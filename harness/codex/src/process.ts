import { createRequire } from "node:module";
import { JsonRpcPeer, type RpcId } from "./rpc.ts";

/** A string or a list of strings is written as TOML; anything else as it is. */
export type CodexConfig = Record<string, string | number | boolean | string[]>;

export interface CodexProcessSpec {
  /** Path to the `codex` executable. Defaults to the bundled `@openai/codex`. */
  bin?: string | undefined;
  /** `-c key=value` config overrides passed to `codex app-server`. */
  config: CodexConfig;
  env: Record<string, string | undefined>;
  /** Receives the app-server's stderr (its log output), line by line. */
  onLog?: ((line: string) => void) | undefined;
}

export interface CodexProcessHandlers {
  onNotification(method: string, params: Record<string, unknown>): void;
  onRequest(rpc: JsonRpcPeer, id: RpcId, method: string, params: Record<string, unknown>): void;
  /** The process went away without being asked to. */
  onExit(error: Error | undefined): void;
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

/**
 * One `codex app-server` child over stdio. It is started on the first request
 * and started again on the next one should it die.
 */
export class CodexProcess {
  /** Sessions this process has in memory. */
  readonly loaded = new Set<string>();
  private readonly spec: CodexProcessSpec;
  private readonly handlers: CodexProcessHandlers;
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private rpc: JsonRpcPeer | null = null;
  private starting: Promise<JsonRpcPeer> | null = null;
  private disposed = false;
  /** The latest lines codex logged, to explain a start that failed. */
  private readonly recentLog: string[] = [];

  constructor(spec: CodexProcessSpec, handlers: CodexProcessHandlers) {
    this.spec = spec;
    this.handlers = handlers;
  }

  peer(): Promise<JsonRpcPeer> {
    if (this.rpc) return Promise.resolve(this.rpc);
    if (this.disposed) return Promise.reject(new Error("The codex harness was shut down."));
    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    const rpc = await this.peer();
    return rpc.request<T>(method, params);
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

  private async spawn(): Promise<JsonRpcPeer> {
    const bin = this.spec.bin ?? resolveCodexBin();
    const overrides = Object.entries(this.spec.config).flatMap(([key, value]) => [
      "-c",
      `${key}=${typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value)}`,
    ]);
    // A .js entrypoint (the npm package's launcher) is run with our own runtime.
    const cmd = /\.[cm]?js$/.test(bin) ? [process.execPath, bin] : [bin];
    const proc = Bun.spawn([...cmd, "app-server", ...overrides], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.spec.env },
    });
    const rpc = new JsonRpcPeer(
      (line) => {
        void proc.stdin.write(line);
      },
      {
        onNotification: (method, params) =>
          this.handlers.onNotification(method, (params ?? {}) as Record<string, unknown>),
        onRequest: (id, method, params) =>
          this.handlers.onRequest(rpc, id, method, (params ?? {}) as Record<string, unknown>),
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
    if (!this.disposed) this.handlers.onExit(error);
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
        this.spec.onLog?.(line);
      }
    }
  }
}
