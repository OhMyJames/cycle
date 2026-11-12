import type {
  DaemonEvent,
  EventFrame,
  MethodName,
  Params,
  Result,
  ServerMessage,
  SessionEvent,
} from "@cycle/protocol";

/** Bare-bones wire client, independent of packages/ui, to pin the protocol. */
export interface WireClient {
  frames: EventFrame[];
  pushes: DaemonEvent[];
  opened: Promise<void>;
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  events(): SessionEvent[];
  /** Resolves once `predicate` holds, checked again after every message. */
  until(predicate: () => boolean): Promise<void>;
  close(): void;
}

export function connect(url: string): WireClient {
  const ws = new WebSocket(url);
  const frames: EventFrame[] = [];
  const pushes: DaemonEvent[] = [];
  const pending = new Map<number, (message: ServerMessage) => void>();
  const waiters = new Set<() => void>();
  let nextId = 1;
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if ("frame" in message) frames.push(message.frame);
    else if ("push" in message) pushes.push(message.push);
    else {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
    for (const wake of waiters) wake();
  });
  return {
    frames,
    pushes,
    opened: new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)));
    }),
    call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
      const id = nextId++;
      return new Promise<Result<M>>((resolve, reject) => {
        pending.set(id, (message) => {
          if ("error" in message) reject(new Error(message.error.message));
          else if ("result" in message) resolve(message.result as Result<M>);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    events: () => frames.flatMap((frame) => frame.events),
    async until(predicate) {
      while (!predicate()) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
        });
      }
    },
    close: () => ws.close(),
  };
}
