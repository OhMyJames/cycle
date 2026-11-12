import type { Methods, MethodName, ServerMessage, SessionEvent } from "@cycle/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Typed WebSocket client for the daemon's `@cycle/protocol` wire API. */
export class CycleClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private eventListeners = new Set<(event: SessionEvent) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private opened: Promise<void>;
  status: ConnectionStatus = "connecting";

  constructor(readonly url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => {
        this.setStatus("open");
        resolve();
      });
      this.ws.addEventListener("close", () => {
        this.setStatus("closed");
        const error = new Error("daemon connection closed");
        reject(error);
        for (const { reject: rejectCall } of this.pending.values()) rejectCall(error);
        this.pending.clear();
      });
    });
    this.opened.catch(() => {}); // surfaced through `status` and `call`
    this.ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if ("event" in message) {
        for (const listener of this.eventListeners) listener(message.event);
        return;
      }
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if ("error" in message) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    });
  }

  async call<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    await this.opened;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.ws.close();
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
