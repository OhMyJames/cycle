import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { CODEX_FIXED_ARGS, CODEX_VERSION } from "./protocol.ts";

export type AdapterConfig = {
  env: Record<string, string>;
  codexExecutable: string;
  /** The app-server ended while its session was open: nothing more can be done with this adapter. */
  onServerExit?: () => void;
};
type Message = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
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
    onRequest: (method: string, params: unknown) => Promise<unknown>,
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
      [...CODEX_FIXED_ARGS, "-c", "check_for_update_on_startup=false", "app-server"],
      { cwd: config.env.HOME, env: config.env, stdio: ["pipe", "pipe", "inherit"] },
    );
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as Message;
        if (msg.method) {
          if (msg.id !== undefined) {
            const id = msg.id;
            void onRequest(msg.method, msg.params).then(
              (result) => {
                if (!this.closed) this.#send({ id, result });
              },
              () => {
                if (!this.closed)
                  this.#send({
                    id,
                    error: { code: -32601, message: "Request unsupported or unavailable" },
                  });
              },
            );
          } else onEvent(msg.method, msg.params);
        } else if (typeof msg.id === "number") {
          const call = this.#pending.get(msg.id);
          if (!call) return;
          this.#pending.delete(msg.id);
          if (msg.error) call.reject(new CodexRpcError(msg.error.code, msg.error.message));
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
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex timed out: ${method}`));
      }, 20_000);
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
    const result = await this.request<{ userAgent?: string }>("initialize", {
      clientInfo: { name: "cycle", title: null, version: "1" },
      // `turn/start.collaborationMode` (Codex's plan mode) is experimental in the pinned version.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (typeof result.userAgent !== "string" || !result.userAgent.includes(CODEX_VERSION))
      throw new Error(`Codex app-server version is not the pinned ${CODEX_VERSION}`);
    this.#send({ method: "initialized" });
  }
  get closed() {
    return this.#closed;
  }
  close(reason = new Error("Codex app-server closed")) {
    if (this.#closed) return;
    this.#closed = true;
    this.#process.stdin.end();
    // Ending stdin asks it to stop; one that is still there a second later is made to.
    const child = this.#process;
    if (child.exitCode === null && child.signalCode === null)
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    for (const call of this.#pending.values()) call.reject(reason);
    this.#pending.clear();
    this.onExit(reason);
  }
}
