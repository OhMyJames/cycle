import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

export type AdapterConfig = {
  /** Explicit environment given to `agy`; nothing is inherited from the adapter process. */
  env: Record<string, string>;
  /** Absolute path to the `agy` executable (if resolved at startup). */
  agyExecutable: string;
  /** Fallback absolute paths checked if `agy` is installed after the daemon starts (never inherited). */
  fallbackExecutables?: string[];
  /** Optional `--log-file` path passed to `agy acp`. */
  logFile?: string;
  /** Pass `--sandbox` to `agy acp`. */
  sandbox?: boolean;
  /** Pass `--agent <name>` to `agy acp`. */
  agent?: string;
  /** When explicitly `false`, pass `--disable-telemetry` to `agy acp`. */
  telemetry?: boolean;
  /** Optional factory replacing the spawned child process (for in-process unit tests or alternate transports). */
  connect?: (handlers: AgyServerHandlers) => AgyTransport;
  /** Called if the underlying `agy acp` process terminates unexpectedly. */
  onServerExit?: () => void;
  /** How long `session/cancel` waits for `agy` to settle an in-flight prompt before forcing cancellation. */
  cancelTimeoutMs?: number;
  /** Quiet window (ms) before closing a synthesized autonomous turn that had no in-flight prompt. */
  autonomousIdleMs?: number;
};

export type AgyServerHandlers = {
  onNotification: (method: string, params: unknown) => void;
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onExit: (error: Error) => void;
};

export type AgyTransport = {
  request: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  notify: (method: string, params: unknown) => void;
  close: (reason?: Error) => void;
  readonly closed: boolean;
};

type WireMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class AgyRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const buildAgyArgs = (config: AdapterConfig): string[] => {
  const args = ["acp", "--process-per-session"];
  if (config.logFile) args.push("--log-file", config.logFile);
  if (config.sandbox) args.push("--sandbox");
  if (config.agent) args.push("--agent", config.agent);
  if (config.telemetry === false) args.push("--disable-telemetry");
  return args;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class AgyProcess implements AgyTransport {
  readonly #process;
  readonly #onExit: (error: Error) => void;
  #nextId = 0;
  #closed = false;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(config: AdapterConfig, handlers: AgyServerHandlers) {
    if (!config.env.HOME || !isAbsolute(config.env.HOME) || !isAbsolute(config.agyExecutable)) {
      throw new Error("agy needs an explicit absolute HOME and executable");
    }
    this.#onExit = handlers.onExit;
    this.#process = spawn(config.agyExecutable, buildAgyArgs(config), {
      cwd: config.env.HOME,
      env: config.env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as WireMessage;
        if (typeof msg.method === "string") {
          if (msg.id !== undefined) {
            const id = msg.id;
            void handlers.onRequest(msg.method, msg.params).then(
              (result) => {
                if (!this.#closed) this.#send({ jsonrpc: "2.0", id, result });
              },
              (error: unknown) => {
                if (this.#closed) return;
                const code = error instanceof AgyRpcError ? error.code : -32603;
                const message =
                  error instanceof Error ? error.message : "Request unsupported or unavailable";
                this.#send({ jsonrpc: "2.0", id, error: { code, message } });
              },
            );
          } else {
            handlers.onNotification(msg.method, msg.params);
          }
        } else if (typeof msg.id === "number") {
          const call = this.#pending.get(msg.id);
          if (!call) return;
          this.#pending.delete(msg.id);
          if (msg.error) {
            call.reject(new AgyRpcError(msg.error.code, msg.error.message, msg.error.data));
          } else {
            call.resolve(msg.result);
          }
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error("Invalid agy ACP response"));
      }
    });
    this.#process.stdin.on("error", (error) => this.close(error));
    this.#process.on("error", (error) => this.close(error));
    this.#process.on("close", (code, signal) =>
      this.close(new Error(`agy acp exited (${signal ?? code})`)),
    );
  }

  #send(message: unknown) {
    if (this.#closed) throw new Error("agy acp process is closed");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T>(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("agy acp process is closed"));
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`agy acp timed out: ${method}`));
            }, timeoutMs)
          : undefined;
      this.#pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (this.#closed) return;
    this.#send({ jsonrpc: "2.0", method, params });
  }

  get closed() {
    return this.#closed;
  }

  close(reason = new Error("agy acp process closed")) {
    if (this.#closed) return;
    this.#closed = true;
    this.#process.stdin.end();
    const child = this.#process;
    if (child.exitCode === null && child.signalCode === null) {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    }
    for (const call of this.#pending.values()) call.reject(reason);
    this.#pending.clear();
    this.#onExit(reason);
  }
}
