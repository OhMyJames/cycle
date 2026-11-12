/**
 * Minimal bidirectional JSON-RPC peer over newline-delimited JSON — the
 * framing `codex app-server` uses on stdio. Both sides may send requests.
 */
export class RpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
export type RpcId = number | string;

export interface RpcHandlers {
  onNotification(method: string, params: unknown): void;
  /** A request from the remote side; answer later with `respond`. */
  onRequest(id: RpcId, method: string, params: unknown): void;
  onClose(error?: Error): void;
}

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private closed = false;

  private readonly write: (line: string) => void;
  private readonly handlers: RpcHandlers;

  constructor(write: (line: string) => void, handlers: RpcHandlers) {
    this.write = write;
    this.handlers = handlers;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError("connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  /** Feed raw bytes from the transport; handles partial lines. */
  async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.dispatch(line);
        }
      }
      this.close();
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const reason = error ?? new RpcError("connection closed");
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear();
    this.handlers.onClose(error);
  }

  private send(message: object): void {
    if (this.closed) return;
    this.write(JSON.stringify(message) + "\n");
  }

  private dispatch(line: string): void {
    let message: {
      id?: RpcId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // not protocol output (e.g. a stray log line)
    }
    if (message.method !== undefined) {
      if (message.id !== undefined)
        this.handlers.onRequest(message.id, message.method, message.params);
      else this.handlers.onNotification(message.method, message.params);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new RpcError(
          message.error.message ?? "request failed",
          message.error.code,
          message.error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }
}
