/**
 * A stdio connector, served over streamable HTTP (docs/protocol.md §14). The daemon starts the
 * process itself, so its environment values go to it and to nothing else: the agent only ever sees
 * the gateway's address.
 *
 * One process per session and connector, started at the first request. The agent is its only client:
 * a POST writes its messages to the process and answers with the replies to its requests (JSON); a
 * GET opens the stream on which what the process says by itself (notifications, its own requests)
 * is sent; a DELETE ends it.
 */

export type Spawned = {
  stdin: { write(data: string): void; end(): void };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};

export type Spawn = (
  command: string[],
  options: { cwd: string; env: Record<string, string> },
) => Spawned;

export const bunSpawn: Spawn = (command, options) => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    // What a server prints for people may hold its keys: not kept, not passed on.
    stderr: "ignore",
  });
  return {
    stdin: {
      write: (data) => {
        proc.stdin.write(data);
        proc.stdin.flush();
      },
      end: () => {
        proc.stdin.end();
      },
    },
    stdout: proc.stdout,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

type Message = { id?: string | number | null; method?: string };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Most a single line from the process may be before the process is taken for broken. */
const MAX_LINE = 16 * 1024 * 1024;
/** Messages the process said by itself while no stream was open: kept for the next one, up to this many. */
const MAX_WAITING = 256;

type Id = string | number;
type Waiter = { id: Id; resolve: (message: unknown) => void };

export class StdioBridge {
  readonly #process: Spawned;
  /**
   * The process is asked with ids of the bridge's own, never the agent's: a reply is then for exactly one request,
   * even one the agent gave up on and then used the id of again. Keyed by that id, as a string (a server that
   * answers 3 as "3" is still understood).
   */
  readonly #pending = new Map<string, Waiter>();
  /** The agent's id (as JSON) of each request still waiting, to the bridge's id it was sent with. */
  readonly #sent = new Map<string, number>();
  #next = 0;
  readonly #streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  #waiting: unknown[] = [];
  #ended = false;
  /** Cycle stopped it (the agent went, the connector changed): its ending says nothing of the server. */
  #stopped = false;
  readonly ended: Promise<void>;

  /** `onEnd(failed)`: failed is true when the process ended by itself before it ever answered. */
  constructor(process: Spawned, onEnd: (failed: boolean) => void) {
    this.#process = process;
    let answered = false;
    this.ended = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of process.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > MAX_LINE && !buffer.includes("\n")) break;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line !== "") {
              answered = true;
              this.#received(line);
            }
            newline = buffer.indexOf("\n");
          }
        }
      } catch {
        // The process's output ended badly: the same as ending.
      }
      // However its output ended, the process goes too: nothing could reach it after this.
      process.kill();
      this.#end();
      onEnd(!answered && !this.#stopped);
    })();
  }

  #received(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not a message: a server that logs to stdout.
    }
    const m = message as Message;
    // A reply is to one of the bridge's requests: the agent's id goes back on it. One nobody waits for any more
    // (cancelled, given up on) is for no one.
    if (m.method === undefined && m.id !== undefined && m.id !== null) {
      const key = String(m.id);
      const waiter = this.#pending.get(key);
      if (waiter === undefined) return;
      this.#settle(key, waiter);
      waiter.resolve({ ...(message as object), id: waiter.id });
      return;
    }
    const event = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    if (this.#streams.size === 0) {
      this.#waiting.push(message);
      if (this.#waiting.length > MAX_WAITING) this.#waiting.shift();
      return;
    }
    for (const stream of this.#streams) stream.enqueue(event);
  }

  #settle(key: string, waiter: Waiter): void {
    this.#pending.delete(key);
    this.#sent.delete(JSON.stringify(waiter.id));
  }

  /**
   * Stops waiting for the reply to the bridge's request `ours`: it is answered as cancelled, for whoever still holds
   * it. False when nothing waited for it any more.
   */
  #drop(ours: number): boolean {
    const key = String(ours);
    const waiter = this.#pending.get(key);
    if (waiter === undefined) return false;
    this.#settle(key, waiter);
    waiter.resolve({
      jsonrpc: "2.0",
      id: waiter.id,
      error: { code: -32800, message: "Request cancelled" },
    });
    return true;
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#pending.values()) {
      waiter.resolve({
        jsonrpc: "2.0",
        id: waiter.id,
        error: { code: -32603, message: "The connector stopped" },
      });
    }
    this.#pending.clear();
    this.#sent.clear();
    for (const stream of this.#streams) {
      try {
        stream.close();
      } catch {
        // Already closed by the reader.
      }
    }
    this.#streams.clear();
  }

  stop(): void {
    this.#stopped = true;
    this.#process.kill();
    this.#end();
  }

  async handle(request: Request): Promise<Response> {
    if (this.#ended) return json(502, { error: "The connector stopped" });
    if (request.method === "DELETE") {
      this.stop();
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET") {
      if (!(request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return new Response(null, { status: 405 });
      }
      let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          mine = controller;
          this.#streams.add(controller);
          const encoder = new TextEncoder();
          for (const message of this.#waiting) {
            controller.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
            );
          }
          this.#waiting = [];
        },
        cancel: () => {
          if (mine !== undefined) this.#streams.delete(mine);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    // It may have ended while the body was read: nothing written now would be answered.
    if (this.#ended) return json(502, { error: "The connector stopped" });
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as Message[];
    const replies: Promise<unknown>[] = [];
    const asked: number[] = [];
    for (const message of messages) {
      if (typeof message !== "object" || message === null) continue;
      let sent: unknown = message;
      if (message.method !== undefined && message.id !== undefined && message.id !== null) {
        const id = message.id;
        const agentKey = JSON.stringify(id);
        // An id still waiting for its answer (before, or earlier in this batch) is refused: the agent could not
        // tell its two answers apart.
        if (this.#sent.has(agentKey)) {
          replies.push(
            Promise.resolve({
              jsonrpc: "2.0",
              id,
              error: { code: -32600, message: "Request id already in use" },
            }),
          );
          continue;
        }
        const ours = ++this.#next;
        this.#sent.set(agentKey, ours);
        asked.push(ours);
        replies.push(new Promise((resolve) => this.#pending.set(String(ours), { id, resolve })));
        sent = { ...message, id: ours };
      }
      // A cancelled request gets no answer from a server (MCP): nobody waits for one. The process knows it by the
      // bridge's id; one that waits no more is not the process's to hear of.
      if (message.method === "notifications/cancelled") {
        const params = (message as { params?: { requestId?: unknown } }).params;
        const cancelled = params?.requestId;
        if (cancelled === undefined) continue;
        const ours = this.#sent.get(JSON.stringify(cancelled));
        if (ours === undefined) continue;
        this.#drop(ours);
        sent = { ...message, params: { ...params, requestId: ours } };
      }
      this.#process.stdin.write(`${JSON.stringify(sent)}\n`);
    }
    if (replies.length === 0) return new Response(null, { status: 202 });
    // The agent gave up on the request: its waits end, whatever the process does.
    // By the bridge's ids: the agent's may by then name another request. The process is told too, as a cancel.
    const onAbort = () => {
      for (const ours of asked) {
        if (this.#drop(ours) && !this.#ended) {
          this.#process.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: ours, reason: "The request was abandoned" } })}\n`,
          );
        }
      }
    };
    // Given up on already, while its body was read: no event will come.
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const answers = await Promise.all(replies);
      return json(200, batch ? answers : answers[0]);
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}
