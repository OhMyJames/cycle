import { createRequire } from "node:module";
import type {
  ApprovalDecision,
  CreateSessionOptions,
  Harness,
  Item,
  ItemStatus,
  SessionEvent,
  SessionInfo,
} from "@cycle/protocol";
import { JsonRpcPeer, type RpcId } from "./rpc.ts";
import type {
  ApprovalRequestParams,
  CodexItem,
  DeltaNotification,
  ErrorNotification,
  ItemNotification,
  ThreadStartResponse,
  TurnNotification,
} from "./wire.ts";

export interface CodexHarnessOptions {
  /** Path to the `codex` executable. Defaults to the bundled `@openai/codex`. */
  bin?: string;
  /** `-c key=value` config overrides passed to `codex app-server`. */
  config?: Record<string, string | number | boolean>;
  env?: Record<string, string | undefined>;
  /** Receives the app-server's stderr (its log output), line by line. */
  onLog?: (line: string) => void;
}

function resolveCodexBin(): string {
  if (process.env.CYCLE_CODEX_BIN) return process.env.CYCLE_CODEX_BIN;
  try {
    return createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
  } catch {
    return "codex";
  }
}

const STATUS: Record<string, ItemStatus> = {
  inProgress: "running",
  completed: "completed",
  failed: "failed",
  declined: "declined",
};

/** Translate a codex thread item into the harness-agnostic model. */
export function toItem(raw: CodexItem): Item {
  const item = raw as Extract<CodexItem, { type: "userMessage" | "agentMessage" | "reasoning" | "commandExecution" | "fileChange" }>;
  switch (item.type) {
    case "userMessage":
      return {
        id: item.id,
        kind: "userMessage",
        text: item.content.map((c) => c.text ?? "").join(""),
      };
    case "agentMessage":
      return { id: item.id, kind: "agentMessage", text: item.text };
    case "reasoning":
      return { id: item.id, kind: "reasoning", text: [...item.summary, ...item.content].join("\n\n") };
    case "commandExecution":
      return {
        id: item.id,
        kind: "command",
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? "",
        exitCode: item.exitCode,
        status: STATUS[item.status] ?? "running",
      };
    case "fileChange":
      return {
        id: item.id,
        kind: "fileChange",
        changes: item.changes.map((c) => ({ path: c.path, change: c.kind.type, diff: c.diff })),
        status: STATUS[item.status] ?? "running",
      };
    default:
      return { id: raw.id, kind: "other", type: raw.type };
  }
}

/**
 * Drives one `codex app-server` child process over stdio. One process hosts
 * many threads; each Cycle session maps 1:1 onto a codex thread.
 */
export class CodexHarness implements Harness {
  readonly name = "codex";
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private rpc: JsonRpcPeer | null = null;
  private listeners = new Set<(event: SessionEvent) => void>();
  private activeTurns = new Map<string, string>();
  private pendingApprovals = new Map<string, { rpcId: RpcId; sessionId: string }>();
  private sessions = new Set<string>();

  constructor(private readonly options: CodexHarnessOptions = {}) {}

  async start(): Promise<void> {
    if (this.proc) return;
    const bin = this.options.bin ?? resolveCodexBin();
    const overrides = Object.entries(this.options.config ?? {}).flatMap(([key, value]) => [
      "-c",
      `${key}=${typeof value === "string" ? JSON.stringify(value) : value}`,
    ]);
    // A .js entrypoint (the npm package's launcher) is run with our own runtime.
    const cmd = /\.[cm]?js$/.test(bin) ? [process.execPath, bin] : [bin];
    const proc = Bun.spawn([...cmd, "app-server", ...overrides], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.options.env },
    });
    this.proc = proc;

    const rpc = new JsonRpcPeer((line) => void proc.stdin.write(line), {
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onClose: (error) => {
        const message = `codex app-server exited${error ? `: ${error.message}` : ""}`;
        for (const sessionId of this.sessions) this.emit({ type: "session.error", sessionId, message });
      },
    });
    this.rpc = rpc;
    void rpc.pump(proc.stdout);
    void this.pumpLogs(proc.stderr);

    await rpc.request("initialize", {
      clientInfo: { name: "cycle", title: "Cycle", version: "0.0.0" },
      capabilities: null,
    });
    rpc.notify("initialized");
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionInfo> {
    const response = await this.peer().request<ThreadStartResponse>("thread/start", {
      cwd: options.cwd ?? null,
      model: options.model ?? null,
    });
    this.sessions.add(response.thread.id);
    return {
      id: response.thread.id,
      harness: this.name,
      cwd: response.cwd,
      model: response.model,
      createdAt: response.thread.createdAt * 1000,
    };
  }

  async sendMessage(sessionId: string, text: string): Promise<{ turnId: string }> {
    const response = await this.peer().request<{ turn: { id: string } }>("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    this.activeTurns.set(sessionId, response.turn.id);
    return { turnId: response.turn.id };
  }

  async interrupt(sessionId: string): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return;
    await this.peer().request("turn/interrupt", { threadId: sessionId, turnId });
  }

  respondApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error(`unknown approval: ${approvalId}`);
    this.pendingApprovals.delete(approvalId);
    this.peer().respond(pending.rpcId, { decision });
    this.emit({ type: "approval.resolved", sessionId: pending.sessionId, approvalId });
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.sessions.clear();
    if (!proc) return;
    proc.kill();
    await proc.exited;
  }

  private peer(): JsonRpcPeer {
    if (!this.rpc) throw new Error("CodexHarness not started");
    return this.rpc;
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case "turn/started": {
        const { threadId, turn } = params as TurnNotification;
        this.activeTurns.set(threadId, turn.id);
        this.emit({ type: "turn.started", sessionId: threadId, turnId: turn.id });
        break;
      }
      case "item/started":
      case "item/completed": {
        const { threadId, turnId, item } = params as ItemNotification;
        this.emit({
          type: method === "item/started" ? "item.started" : "item.completed",
          sessionId: threadId,
          turnId,
          item: toItem(item),
        });
        break;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/commandExecution/outputDelta": {
        const { threadId, turnId, itemId, delta } = params as DeltaNotification;
        this.emit({ type: "item.delta", sessionId: threadId, turnId, itemId, delta });
        break;
      }
      case "turn/completed": {
        const { threadId, turn } = params as TurnNotification;
        this.activeTurns.delete(threadId);
        for (const [approvalId, pending] of this.pendingApprovals) {
          if (pending.sessionId === threadId) this.pendingApprovals.delete(approvalId);
        }
        this.emit({
          type: "turn.completed",
          sessionId: threadId,
          turnId: turn.id,
          status: turn.status === "inProgress" ? "completed" : turn.status,
          error: turn.error?.message,
        });
        break;
      }
      case "error": {
        const { threadId, error, willRetry } = params as ErrorNotification;
        if (!willRetry) this.emit({ type: "session.error", sessionId: threadId, message: error.message });
        break;
      }
      // Everything else (token usage, plan updates, ...) is ignored for now.
    }
  }

  private handleServerRequest(id: RpcId, method: string, params: unknown): void {
    const kind =
      method === "item/commandExecution/requestApproval"
        ? "command"
        : method === "item/fileChange/requestApproval"
          ? "fileChange"
          : null;
    if (!kind) {
      this.peer().respondError(id, -32601, `cycle does not handle ${method}`);
      return;
    }
    const request = params as ApprovalRequestParams;
    const approvalId = `${request.threadId}:${id}`;
    this.pendingApprovals.set(approvalId, { rpcId: id, sessionId: request.threadId });
    this.emit({
      type: "approval.requested",
      sessionId: request.threadId,
      turnId: request.turnId,
      approval: {
        id: approvalId,
        kind,
        itemId: request.itemId,
        command: request.command ?? undefined,
        cwd: request.cwd ?? undefined,
        reason: request.reason ?? undefined,
      },
    });
  }

  private async pumpLogs(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) this.options.onLog?.(line);
    }
  }
}
