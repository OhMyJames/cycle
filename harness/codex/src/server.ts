import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

export type AdapterConfig = { env: Record<string, string>; codexExecutable: string };
type Message = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
};
export class AppServer {
  readonly #process;
  #next = 0;
  #closed = false;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  constructor(
    config: AdapterConfig,
    onEvent: (method: string, params: unknown) => void,
    readonly onExit: (error: Error) => void,
  ) {
    if (
      !config.env.HOME ||
      !config.env.CODEX_HOME ||
      !isAbsolute(config.env.HOME) ||
      !isAbsolute(config.env.CODEX_HOME) ||
      !isAbsolute(config.codexExecutable)
    )
      throw new Error("Codex needs an explicit home, config directory and executable");
    this.#process = spawn(
      config.codexExecutable,
      ["-c", "check_for_update_on_startup=false", "app-server"],
      { cwd: config.env.HOME, env: config.env, stdio: ["pipe", "pipe", "ignore"] },
    );
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as Message;
        if (msg.method) {
          if (msg.id !== undefined)
            this.#send({
              id: msg.id,
              error: { code: -32601, message: "Unsupported server request" },
            });
          else onEvent(msg.method, msg.params);
        } else if (typeof msg.id === "number") {
          const call = this.#pending.get(msg.id);
          if (!call) return;
          this.#pending.delete(msg.id);
          if (msg.error) call.reject(new Error(msg.error.message));
          else call.resolve(msg.result);
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error("Invalid Codex response"));
      }
    });
    this.#process.stdin.on("error", (error) => this.close(error));
    this.#process.on("error", (error) => this.close(error));
    this.#process.on("close", (code, signal) =>
      this.close(new Error(`Codex app-server closed (${signal ?? code})`)),
    );
  }
  #send(message: unknown) {
    if (this.#closed) throw new Error("Codex app-server is closed");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<T>(method: string, params: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error(`Codex timed out: ${method}`)), 20_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send({ id, method, params });
    });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "cycle", version: "1" },
      capabilities: {},
    });
    this.#send({ method: "initialized" });
  }
  get closed() {
    return this.#closed;
  }
  close(reason = new Error("Codex app-server closed")) {
    if (this.#closed) return;
    this.#closed = true;
    this.#process.kill("SIGKILL");
    for (const call of this.#pending.values()) call.reject(reason);
    this.#pending.clear();
    this.onExit(reason);
  }
}
