import {
  CLOSE_UNAUTHORIZED,
  type DaemonEvent,
  type EventFrame,
  type MethodName,
  type Params,
  type Result,
  type ServerMessage,
} from "@cycle/protocol";

/** What the daemon answered a request with, as against a connection that failed under it. */
export class DaemonError extends Error {}

export type ConnectionStatus = "connecting" | "open" | "retrying" | "unauthorized";

export interface ConnectionHandlers {
  onStatus(status: ConnectionStatus): void;
  onFrame(frame: EventFrame): void;
  onPush(event: DaemonEvent): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 8000;

/**
 * The typed WebSocket to the daemon. It reconnects by itself, with a wait
 * that doubles up to a limit, and fails what was asked on a connection that
 * dropped, so no caller waits for an answer that cannot come.
 */
export class Connection {
  private readonly url: string;
  private readonly handlers: ConnectionHandlers;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(url: string, handlers: ConnectionHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  connect(): void {
    if (this.closed || this.socket) return;
    this.handlers.onStatus(this.attempts ? "retrying" : "connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempts = 0;
      this.handlers.onStatus("open");
    });
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const { reject } of this.pending.values()) reject(new Error("The connection dropped."));
      this.pending.clear();
      if (this.closed) return;
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.handlers.onStatus("unauthorized");
        return;
      }
      this.handlers.onStatus("retrying");
      const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.attempts++);
      this.timer = setTimeout(() => this.connect(), wait);
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }

  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to the Cycle daemon."));
    }
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private receive(data: string): void {
    const message = JSON.parse(data) as ServerMessage;
    if ("frame" in message) this.handlers.onFrame(message.frame);
    else if ("push" in message) this.handlers.onPush(message.push);
    else {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ("error" in message) pending.reject(new DaemonError(message.error.message));
      else pending.resolve(message.result);
    }
  }
}
