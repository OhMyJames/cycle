import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * JSON-RPC over a child process's stdin and stdout, one message a line: how Codex's app-server and agy's ACP
 * speak. The two harnesses share it so a fix to the transport is made once.
 */

/** An error with a JSON-RPC code: what the other side answered, or what a handler wants answered. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/**
 * The code a request handler's failure is answered with: its own when it has one, else an internal error.
 * A DOMException's `code` (20 for an abort) is the DOM's, not a JSON-RPC one.
 */
export const codeOf = (error: unknown): number =>
  isObject(error) &&
  !(error instanceof DOMException) &&
  typeof error.code === "number" &&
  Number.isInteger(error.code)
    ? error.code
    : -32603;

export type LineRpcHandlers = {
  onNotification: (method: string, params: unknown) => void;
  /** A request from the process. Throw an `RpcError` (or anything with a numeric `code`) to answer with that code. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** The process ended or was closed; every request still waiting has been rejected with `error`. */
  onExit: (error: Error) => void;
};

export type LineRpcOptions = {
  /** Who it is, in error messages ("Codex app-server"). */
  name: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  /** The whole environment of the process: nothing is inherited. */
  env: Record<string, string>;
  /** Whether each message says `"jsonrpc": "2.0"` (ACP does; Codex's app-server leaves it out). */
  jsonrpc: boolean;
  /** How long a request waits for its answer unless the call says otherwise; 0 waits for ever. */
  timeoutMs: number;
};

type Message = {
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

/** An error answer as an `RpcError`, whatever shape it came in. */
const errorOf = (error: unknown): RpcError =>
  isObject(error)
    ? new RpcError(
        typeof error.code === "number" ? error.code : -32603,
        typeof error.message === "string" ? error.message : "Unknown error",
        error.data,
      )
    : new RpcError(-32603, typeof error === "string" ? error : "Unknown error");

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class LineJsonRpcProcess {
  readonly #options: LineRpcOptions;
  readonly #handlers: LineRpcHandlers;
  readonly #process;
  #next = 0;
  #closed = false;
  readonly #pending = new Map<number, Pending>();

  constructor(options: LineRpcOptions, handlers: LineRpcHandlers) {
    this.#options = options;
    this.#handlers = handlers;
    this.#process = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: this.#process.stdout }).on("line", (line) => this.#receive(line));
    this.#process.stdin.on("error", (error) => this.close(error));
    this.#process.on("error", (error) => this.close(error));
    this.#process.on("close", (code, signal) =>
      this.close(new Error(`${options.name} exited (${signal ?? code})`)),
    );
  }

  #receive(line: string): void {
    // Closed, nothing it says is taken any more: its handlers have been told it ended.
    if (this.#closed) return;
    // A blank line says nothing; anything else that is not a message means the two sides no longer agree.
    if (line.trim() === "") return;
    try {
      const msg = JSON.parse(line) as Message;
      if (!isObject(msg)) throw new Error(`Invalid ${this.#options.name} message`);
      if (typeof msg.method === "string") {
        if (typeof msg.id === "number" || typeof msg.id === "string")
          this.#answer(msg.id, msg.method, msg.params);
        else if (msg.id === undefined) this.#handlers.onNotification(msg.method, msg.params);
      } else if (typeof msg.id === "number") {
        const call = this.#pending.get(msg.id);
        if (!call) return;
        this.#pending.delete(msg.id);
        if (msg.error !== undefined) call.reject(errorOf(msg.error));
        else call.resolve(msg.result);
      }
    } catch (error) {
      const reason =
        error instanceof Error ? error : new Error(`Invalid ${this.#options.name} message`);
      // readline hands over the bytes after the last newline as one more line at EOF. A process
      // stopped while writing a large message therefore leaves half a JSON line. That is its exit,
      // not a protocol disagreement: let the process's own close event provide the real reason.
      setTimeout(() => {
        if (this.#closed || this.#process.exitCode !== null || this.#process.signalCode !== null)
          return;
        this.close(reason);
      }, 0).unref();
    }
  }

  #answer(id: number | string, method: string, params: unknown): void {
    void this.#handlers.onRequest(method, params).then(
      (result) => {
        if (!this.#closed) this.#send({ id, result });
      },
      (error: unknown) => {
        if (this.#closed) return;
        // The handler's own code: a refusal (-32602), an unknown method (-32601) or a failure are not the same.
        const message = error instanceof Error ? error.message : "Request failed";
        this.#send({ id, error: { code: codeOf(error), message } });
      },
    );
  }

  #send(message: Record<string, unknown>): void {
    if (this.#closed) throw new Error(`${this.#options.name} is closed`);
    const line = JSON.stringify(this.#options.jsonrpc ? { jsonrpc: "2.0", ...message } : message);
    this.#process.stdin.write(`${line}\n`);
  }

  request<T>(method: string, params: unknown, timeoutMs = this.#options.timeoutMs): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`${this.#options.name} is closed`));
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`${this.#options.name} timed out: ${method}`));
            }, timeoutMs)
          : undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.#pending.delete(id);
      };
      this.#pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value as T);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        // Never sent: nothing will answer it, so it waits for nothing.
        done();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#send({ method, params });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** How many requests wait for an answer. */
  get waiting(): number {
    return this.#pending.size;
  }

  close(reason = new Error(`${this.#options.name} closed`)): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#process.stdin.end();
    // Ending stdin asks it to stop; one that is still there a second later is made to.
    const child = this.#process;
    if (child.exitCode === null && child.signalCode === null)
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    const calls = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of calls) call.reject(reason);
    this.#handlers.onExit(reason);
  }
}
