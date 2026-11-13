import { createRequire } from "node:module";
import type {
  AccountInfo,
  Approval,
  ApprovalResponse,
  CreateSessionOptions,
  DirectoryEntry,
  ExecOptions,
  ExecResult,
  FileMatch,
  Harness,
  HarnessEvent,
  HarnessSession,
  McpServerInfo,
  McpServerInput,
  ModelInfo,
  PluginCatalog,
  PluginDetail,
  PromptInput,
  RateLimitWindow,
  SkillInfo,
  TerminalHandle,
  TerminalOptions,
  Turn,
  TurnOptions,
  Usage,
} from "@cycle/protocol";
import { JsonRpcPeer, type RpcId } from "./rpc.ts";
import {
  checkServerName,
  mcpServerEdits,
  modePolicy,
  toInput,
  toCatalog,
  toItem,
  toMcpServers,
  toModel,
  toPluginDetail,
  toSession,
  toSkill,
  toTurn,
  toUsage,
} from "./translate.ts";
import type {
  WireItem,
  WireConfigEdit,
  WireMcpConfig,
  WireMcpServer,
  WirePluginDetail,
  WirePluginList,
  WireModel,
  WireRateLimitWindow,
  WireSkill,
  WireThread,
  WireThreadResponse,
  WireTokenUsage,
  WireTurn,
  WireUnknownItem,
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
  const fromEnv = process.env["CYCLE_CODEX_BIN"];
  if (fromEnv) return fromEnv;
  try {
    return createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
  } catch {
    return "codex";
  }
}

interface PendingApproval {
  rpcId: RpcId;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

interface OpenTerminal {
  onData(bytes: Uint8Array): void;
  onExit(exitCode: number | null): void;
}

type Json = Record<string, unknown>;

const EXEC_OUTPUT_CAP = 8 * 1024 * 1024;
const LIST_PAGE = 100;
const LIST_LIMIT = 2000;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toWindow(raw: WireRateLimitWindow | null | undefined): RateLimitWindow | null {
  if (!raw) return null;
  return {
    usedPercent: raw.usedPercent,
    windowMinutes: raw.windowDurationMins,
    resetsAt: raw.resetsAt === null ? null : raw.resetsAt * 1000,
  };
}

/**
 * Drives one `codex app-server` child process over stdio. One process hosts
 * many threads; each Cycle session maps 1:1 onto a codex thread. Should the
 * process die it is started again on the next request, and each session is
 * brought back into it the next time it is used.
 */
export class CodexHarness implements Harness {
  readonly name = "codex";
  private readonly options: CodexHarnessOptions;
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private rpc: JsonRpcPeer | null = null;
  private starting: Promise<JsonRpcPeer> | null = null;
  private disposed = false;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  /** Sessions the running process has in memory. */
  private readonly loaded = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly terminals = new Map<string, OpenTerminal>();
  /** The latest lines codex logged, to explain a start that failed. */
  private readonly recentLog: string[] = [];

  constructor(options: CodexHarnessOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    await this.peer();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const proc = this.proc;
    this.proc = null;
    this.rpc = null;
    this.loaded.clear();
    if (!proc) return;
    proc.kill();
    await proc.exited;
  }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Sessions

  async createSession(options: CreateSessionOptions): Promise<HarnessSession> {
    const policy = options.mode ? modePolicy(options.mode) : null;
    const response = await this.request<WireThreadResponse>("thread/start", {
      cwd: options.cwd,
      model: options.model ?? null,
      approvalPolicy: policy?.approvalPolicy ?? null,
      sandbox: policy?.sandbox ?? null,
      ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}),
    });
    this.loaded.add(response.thread.id);
    return toSession(response.thread, {
      model: response.model,
      effort: response.reasoningEffort,
    });
  }

  async listSessions(filter: { archived: boolean }): Promise<HarnessSession[]> {
    const sessions: HarnessSession[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: WireThread[]; nextCursor: string | null } = await this.request(
        "thread/list",
        {
          cursor,
          limit: LIST_PAGE,
          archived: filter.archived,
          sortKey: "updated_at",
          sourceKinds: ["cli", "vscode", "appServer"],
        },
      );
      for (const thread of page.data) sessions.push(toSession(thread));
      cursor = page.nextCursor;
    } while (cursor && sessions.length < LIST_LIMIT);
    return sessions;
  }

  async loadSession(
    sessionId: string,
    options: TurnOptions,
  ): Promise<{ session: HarnessSession; turns: Turn[]; usage: Usage | null }> {
    const response = await this.resume(sessionId, options);
    return {
      session: toSession(response.thread, {
        model: response.model,
        effort: response.reasoningEffort,
      }),
      turns: response.thread.turns.map(toTurn),
      usage: null,
    };
  }

  async forkSession(sessionId: string, turnId: string | null): Promise<HarnessSession> {
    const response = await this.request<WireThreadResponse>("thread/fork", {
      threadId: sessionId,
      ...(turnId ? { lastTurnId: turnId } : {}),
    });
    this.loaded.add(response.thread.id);
    return toSession(response.thread, {
      model: response.model,
      effort: response.reasoningEffort,
    });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.request("thread/name/set", { threadId: sessionId, name: title });
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    await this.request(archived ? "thread/archive" : "thread/unarchive", { threadId: sessionId });
    if (archived) this.loaded.delete(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request("thread/delete", { threadId: sessionId });
    this.loaded.delete(sessionId);
  }

  async compactSession(sessionId: string): Promise<void> {
    await this.ensureLoaded(sessionId, {});
    await this.request("thread/compact/start", { threadId: sessionId });
  }

  // Turns

  async send(
    sessionId: string,
    input: PromptInput,
    options: TurnOptions,
  ): Promise<{ turnId: string }> {
    await this.ensureLoaded(sessionId, options);
    const policy = options.mode ? modePolicy(options.mode) : null;
    const response = await this.request<{ turn: WireTurn }>("turn/start", {
      threadId: sessionId,
      input: toInput(input),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(policy
        ? { approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy }
        : {}),
    });
    this.activeTurns.set(sessionId, response.turn.id);
    return { turnId: response.turn.id };
  }

  async steer(sessionId: string, input: PromptInput): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) throw new Error("No turn is running to steer.");
    await this.request("turn/steer", {
      threadId: sessionId,
      input: toInput(input),
      expectedTurnId: turnId,
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return;
    await this.request("turn/interrupt", { threadId: sessionId, turnId });
  }

  respondApproval(approvalId: string, response: ApprovalResponse): void {
    const pending = this.approvals.get(approvalId);
    if (!pending || !this.rpc) throw new Error(`unknown approval: ${approvalId}`);
    this.approvals.delete(approvalId);
    this.rpc.respond(pending.rpcId, this.approvalResult(pending, response));
    this.emit({ type: "approval.resolved", sessionId: pending.sessionId, approvalId });
  }

  // What the agent offers

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: WireModel[]; nextCursor: string | null } = await this.request(
        "model/list",
        { cursor, limit: LIST_PAGE },
      );
      for (const model of page.data) if (!model.hidden) models.push(toModel(model));
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  async listSkills(cwd: string): Promise<SkillInfo[]> {
    const response = await this.request<{ data: { skills: WireSkill[] }[] }>("skills/list", {
      cwds: [cwd],
    });
    return response.data.flatMap((entry) => entry.skills.map(toSkill));
  }

  // The connector

  private async mcpConfig(): Promise<Record<string, WireMcpConfig | undefined>> {
    const { config } = await this.request<{
      config: { mcp_servers?: Record<string, WireMcpConfig> | null };
    }>("config/read", {});
    return config.mcp_servers ?? {};
  }

  async listMcpServers(): Promise<McpServerInfo[]> {
    const [configured, statuses] = await Promise.all([
      this.mcpConfig(),
      this.request<{ data: WireMcpServer[] }>("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
      }),
    ]);
    return toMcpServers(configured, statuses.data);
  }

  /** Writes the owner's configuration and has codex's sessions take it up. */
  private async writeConfig(edits: WireConfigEdit[]): Promise<void> {
    await this.request("config/batchWrite", { edits, reloadUserConfig: true });
    await this.request("config/mcpServer/reload", undefined);
  }

  async putMcpServer(server: McpServerInput): Promise<void> {
    const configured = await this.mcpConfig();
    await this.writeConfig(mcpServerEdits(server, configured[server.name]));
  }

  async removeMcpServer(name: string): Promise<void> {
    checkServerName(name);
    await this.writeConfig([
      { keyPath: `mcp_servers.${name}`, value: null, mergeStrategy: "replace" },
    ]);
  }

  async enableMcpServer(name: string, enabled: boolean): Promise<void> {
    checkServerName(name);
    const configured = await this.mcpConfig();
    if (!configured[name]) throw new Error(`No MCP server named ${name}.`);
    await this.writeConfig([
      { keyPath: `mcp_servers.${name}.enabled`, value: enabled, mergeStrategy: "replace" },
    ]);
  }

  async loginMcpServer(name: string): Promise<{ url: string }> {
    checkServerName(name);
    const response = await this.request<{ authorizationUrl: string }>("mcpServer/oauth/login", {
      name,
    });
    return { url: response.authorizationUrl };
  }

  private pluginList(): Promise<WirePluginList> {
    return this.request<WirePluginList>("plugin/list", {});
  }

  async listPlugins(): Promise<PluginCatalog> {
    return toCatalog(await this.pluginList());
  }

  /** Codex names a plugin's marketplace by the file it was read from. */
  private async marketplacePath(marketplace: string): Promise<string> {
    const list = await this.pluginList();
    const path = list.marketplaces.find((entry) => entry.name === marketplace)?.path;
    if (!path) throw new Error(`No marketplace named ${marketplace}.`);
    return path;
  }

  async readPlugin(marketplace: string, name: string): Promise<PluginDetail> {
    const marketplacePath = await this.marketplacePath(marketplace);
    const { plugin } = await this.request<{ plugin: WirePluginDetail }>("plugin/read", {
      marketplacePath,
      pluginName: name,
    });
    return toPluginDetail(plugin);
  }

  async installPlugin(marketplace: string, name: string): Promise<void> {
    const marketplacePath = await this.marketplacePath(marketplace);
    await this.request("plugin/install", { marketplacePath, pluginName: name });
  }

  async uninstallPlugin(id: string): Promise<void> {
    await this.request("plugin/uninstall", { pluginId: id });
  }

  async enablePlugin(id: string, enabled: boolean): Promise<void> {
    if (!/^[\w.-]+@[\w.-]+$/.test(id)) throw new Error(`${id} is not a plugin.`);
    await this.writeConfig([
      { keyPath: `plugins."${id}".enabled`, value: enabled, mergeStrategy: "replace" },
    ]);
  }

  async addMarketplace(source: string): Promise<void> {
    await this.request("marketplace/add", { source: source.trim() });
  }

  async removeMarketplace(name: string): Promise<void> {
    await this.request("marketplace/remove", { marketplaceName: name });
  }

  async readAccount(): Promise<AccountInfo> {
    const { account } = await this.request<{ account: Json | null }>("account/read", {});
    if (!account) return { kind: null, email: null, plan: null, limits: null };
    const kind =
      account["type"] === "apiKey" || account["type"] === "chatgpt" ? account["type"] : "other";
    let limits: AccountInfo["limits"] = null;
    if (kind === "chatgpt") {
      try {
        const { rateLimits } = await this.request<{
          rateLimits: {
            primary: WireRateLimitWindow | null;
            secondary: WireRateLimitWindow | null;
          };
        }>("account/rateLimits/read", {});
        limits = {
          primary: toWindow(rateLimits.primary),
          secondary: toWindow(rateLimits.secondary),
        };
      } catch {
        // Limits are a courtesy: an account without them still works.
      }
    }
    return { kind, email: text(account["email"]), plan: text(account["planType"]), limits };
  }

  // The agent's machine

  async exec(argv: string[], options: ExecOptions): Promise<ExecResult> {
    return this.request<ExecResult>("command/exec", {
      command: argv,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 30_000,
      outputBytesCap: EXEC_OUTPUT_CAP,
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  }

  async readDirectory(path: string): Promise<DirectoryEntry[]> {
    const response = await this.request<{
      entries: { fileName: string; isDirectory: boolean }[];
    }>("fs/readDirectory", { path });
    return response.entries.map((entry) => ({
      name: entry.fileName,
      directory: entry.isDirectory,
    }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this.request<{ dataBase64: string }>("fs/readFile", { path });
    return new Uint8Array(Buffer.from(response.dataBase64, "base64"));
  }

  async searchFiles(root: string, query: string): Promise<FileMatch[]> {
    const response = await this.request<{
      files: { path: string; match_type: string }[];
    }>("fuzzyFileSearch", { query, roots: [root], cancellationToken: `cycle:${root}` });
    return response.files.map((file) => ({
      path: file.path,
      directory: file.match_type === "directory",
    }));
  }

  async openTerminal(options: TerminalOptions): Promise<TerminalHandle> {
    const rpc = await this.peer();
    const processId = options.id;
    const finish = (exitCode: number | null) => {
      if (this.terminals.delete(processId)) options.onExit(exitCode);
    };
    this.terminals.set(processId, { onData: options.onData, onExit: options.onExit });
    rpc
      .request<ExecResult>("command/exec", {
        command: options.argv,
        processId,
        tty: true,
        streamStdin: true,
        streamStdoutStderr: true,
        disableTimeout: true,
        disableOutputCap: true,
        cwd: options.cwd,
        env: options.env ?? null,
        size: { rows: options.rows, cols: options.cols },
        sandboxPolicy: { type: "dangerFullAccess" },
      })
      .then(
        (result) => finish(result.exitCode),
        () => finish(null),
      );
    const quietly = (method: string, params: Json) => {
      // A terminal that already exited refuses these, which is the answer wanted.
      rpc.request(method, params).catch(() => {});
    };
    return {
      write: (bytes) =>
        quietly("command/exec/write", {
          processId,
          deltaBase64: Buffer.from(bytes).toString("base64"),
        }),
      resize: (cols, rows) => quietly("command/exec/resize", { processId, size: { rows, cols } }),
      kill: () => quietly("command/exec/terminate", { processId }),
    };
  }

  // The process

  private peer(): Promise<JsonRpcPeer> {
    if (this.rpc) return Promise.resolve(this.rpc);
    if (this.disposed) return Promise.reject(new Error("The codex harness was shut down."));
    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawn(): Promise<JsonRpcPeer> {
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
    const rpc = new JsonRpcPeer(
      (line) => {
        void proc.stdin.write(line);
      },
      {
        onNotification: (method, params) => this.handleNotification(method, (params ?? {}) as Json),
        onRequest: (id, method, params) =>
          this.handleServerRequest(id, method, (params ?? {}) as Json),
        onClose: (error) => this.handleExit(rpc, error),
      },
    );
    void rpc.pump(proc.stdout);
    void this.pumpLogs(proc.stderr);
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "cycle", title: "Cycle", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
    } catch (error) {
      proc.kill();
      // What codex printed last says why far better than a closed pipe does.
      const said = this.recentLog.findLast((line) => /error/i.test(line)) ?? this.recentLog.at(-1);
      throw new Error(`codex app-server could not start: ${said ?? String(error)}`, {
        cause: error,
      });
    }
    rpc.notify("initialized");
    this.proc = proc;
    this.rpc = rpc;
    return rpc;
  }

  private handleExit(rpc: JsonRpcPeer, error: Error | undefined): void {
    if (this.rpc !== rpc) return;
    this.rpc = null;
    this.proc = null;
    this.loaded.clear();
    this.activeTurns.clear();
    this.approvals.clear();
    for (const [id, terminal] of this.terminals) {
      this.terminals.delete(id);
      terminal.onData(new TextEncoder().encode("\r\n[the agent process exited]\r\n"));
      terminal.onExit(null);
    }
    if (this.disposed) return;
    this.emit({
      type: "harness.exited",
      message: `codex app-server exited${error ? `: ${error.message}` : ""}`,
    });
  }

  private async request<T = unknown>(method: string, params: unknown): Promise<T> {
    const rpc = await this.peer();
    return rpc.request<T>(method, params);
  }

  private async resume(sessionId: string, options: TurnOptions): Promise<WireThreadResponse> {
    const policy = options.mode ? modePolicy(options.mode) : null;
    const response = await this.request<WireThreadResponse>("thread/resume", {
      threadId: sessionId,
      model: options.model ?? null,
      approvalPolicy: policy?.approvalPolicy ?? null,
      sandbox: policy?.sandbox ?? null,
    });
    this.loaded.add(sessionId);
    return response;
  }

  private async ensureLoaded(sessionId: string, options: TurnOptions): Promise<void> {
    await this.peer();
    if (!this.loaded.has(sessionId)) await this.resume(sessionId, options);
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // What codex tells us

  private handleNotification(method: string, params: Json): void {
    const sessionId = text(params["threadId"]) ?? "";
    const turnId = text(params["turnId"]) ?? "";
    switch (method) {
      case "turn/started": {
        const turn = params["turn"] as WireTurn;
        this.activeTurns.set(sessionId, turn.id);
        this.emit({
          type: "turn.started",
          sessionId,
          turnId: turn.id,
          startedAt: turn.startedAt === null ? null : turn.startedAt * 1000,
        });
        break;
      }
      case "turn/completed": {
        const turn = params["turn"] as WireTurn;
        this.activeTurns.delete(sessionId);
        for (const [approvalId, pending] of this.approvals) {
          if (pending.sessionId === sessionId) this.approvals.delete(approvalId);
        }
        this.emit({
          type: "turn.completed",
          sessionId,
          turnId: turn.id,
          status: turn.status === "inProgress" ? "completed" : turn.status,
          error: turn.error?.message ?? null,
          durationMs: turn.durationMs,
        });
        break;
      }
      case "item/started":
      case "item/completed":
        this.emit({
          type: method === "item/started" ? "item.started" : "item.completed",
          sessionId,
          turnId,
          item: toItem(params["item"] as WireItem | WireUnknownItem),
        });
        break;
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/commandExecution/outputDelta":
        this.emit({
          type: "item.delta",
          sessionId,
          turnId,
          itemId: text(params["itemId"]) ?? "",
          delta: text(params["delta"]) ?? "",
        });
        break;
      case "item/reasoning/summaryPartAdded":
        if (typeof params["summaryIndex"] === "number" && params["summaryIndex"] > 0) {
          this.emit({
            type: "item.delta",
            sessionId,
            turnId,
            itemId: text(params["itemId"]) ?? "",
            delta: "\n\n",
          });
        }
        break;
      case "turn/plan/updated":
        this.emit({
          type: "plan.updated",
          sessionId,
          plan: {
            explanation: text(params["explanation"]),
            steps: params["plan"] as {
              step: string;
              status: "pending" | "inProgress" | "completed";
            }[],
          },
        });
        break;
      case "turn/diff/updated":
        this.emit({ type: "diff.updated", sessionId, turnId, diff: text(params["diff"]) ?? "" });
        break;
      case "thread/tokenUsage/updated":
        this.emit({
          type: "usage.updated",
          sessionId,
          usage: toUsage(params["tokenUsage"] as WireTokenUsage),
        });
        break;
      case "mcpServer/oauthLogin/completed":
      case "mcpServer/startupStatus/updated":
        this.emit({ type: "mcp.changed" });
        break;
      case "thread/name/updated":
        this.emit({
          type: "session.changed",
          sessionId,
          patch: { title: text(params["threadName"])?.trim() || null },
        });
        break;
      case "serverRequest/resolved": {
        const approvalId = `${sessionId}:${String(params["requestId"])}`;
        if (this.approvals.delete(approvalId)) {
          this.emit({ type: "approval.resolved", sessionId, approvalId });
        }
        break;
      }
      case "command/exec/outputDelta": {
        const terminal = this.terminals.get(text(params["processId"]) ?? "");
        const data = text(params["deltaBase64"]);
        if (terminal && data) terminal.onData(new Uint8Array(Buffer.from(data, "base64")));
        break;
      }
      case "error": {
        const error = params["error"] as { message?: string } | undefined;
        if (params["willRetry"] && sessionId && error?.message) {
          this.emit({ type: "notice", sessionId, level: "warning", message: error.message });
        }
        break;
      }
      case "warning":
        if (sessionId) {
          this.emit({
            type: "notice",
            sessionId,
            level: "warning",
            message: text(params["message"]) ?? "",
          });
        }
        break;
      case "model/rerouted":
        this.emit({
          type: "notice",
          sessionId,
          level: "info",
          message: `This turn ran on ${String(params["toModel"])} instead of ${String(params["fromModel"])}.`,
        });
        break;
      default:
      // Everything else is state this harness does not show.
    }
  }

  private handleServerRequest(id: RpcId, method: string, params: Json): void {
    const rpc = this.rpc;
    if (!rpc) return;
    const sessionId = text(params["threadId"]);
    const approval = sessionId ? this.toApproval(`${sessionId}:${id}`, method, params) : null;
    if (!sessionId || !approval) {
      if (method === "mcpServer/elicitation/request") {
        // No form for these yet: declining lets the tool carry on without one.
        rpc.respond(id, { action: "decline", content: null, _meta: null });
      } else {
        rpc.respondError(id, -32601, `cycle does not handle ${method}`);
      }
      return;
    }
    this.approvals.set(approval.id, { rpcId: id, sessionId, method, params });
    this.emit({
      type: "approval.requested",
      sessionId,
      turnId: text(params["turnId"]),
      approval,
    });
  }

  private toApproval(id: string, method: string, params: Json): Approval | null {
    const itemId = text(params["itemId"]) ?? "";
    const reason = text(params["reason"]);
    switch (method) {
      case "item/commandExecution/requestApproval":
        return {
          id,
          kind: "command",
          itemId,
          command: text(params["command"]),
          cwd: text(params["cwd"]),
          reason,
        };
      case "item/fileChange/requestApproval":
        return { id, kind: "fileChange", itemId, reason };
      case "item/permissions/requestApproval":
        return {
          id,
          kind: "permissions",
          itemId,
          reason,
          summary: JSON.stringify(params["permissions"] ?? {}, null, 2),
        };
      case "item/tool/requestUserInput": {
        const questions = (params["questions"] ?? []) as {
          id: string;
          header: string;
          question: string;
          isOther: boolean;
          isSecret: boolean;
          options: { label: string; description: string }[] | null;
        }[];
        return {
          id,
          kind: "question",
          itemId,
          questions: questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options ?? [],
            allowOther: question.isOther || !question.options?.length,
            secret: question.isSecret,
          })),
        };
      }
      default:
        return null;
    }
  }

  private approvalResult(pending: PendingApproval, response: ApprovalResponse): unknown {
    if (pending.method === "item/tool/requestUserInput") {
      const answers = "answers" in response ? response.answers : {};
      return {
        answers: Object.fromEntries(
          Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
        ),
      };
    }
    const decision = "decision" in response ? response.decision : "cancel";
    if (pending.method === "item/permissions/requestApproval") {
      const granted = decision === "accept" || decision === "acceptForSession";
      return {
        permissions: granted ? (pending.params["permissions"] ?? {}) : {},
        scope: decision === "acceptForSession" ? "session" : "turn",
      };
    }
    return { decision };
  }

  private async pumpLogs(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.recentLog.push(line);
        if (this.recentLog.length > 20) this.recentLog.shift();
        this.options.onLog?.(line);
      }
    }
  }
}
