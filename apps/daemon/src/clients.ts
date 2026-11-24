// The clients connected to the daemon, and the one way anything is told to them without waiting for an answer
// (CYCL-260, D-12). A client that cannot be told (it is going, its handler failed) does not stop the others being told,
// and is not passed over in silence: the daemon's log says which, and what. Once per client: one that is going fails
// everything it is sent until it is seen to have gone, and that is one fact, not one line per notification.
import { errorText, type Logger } from "./logger.ts";
import type { ClientConn } from "./session.ts";

export class Clients {
  readonly #conns = new Set<ClientConn>();
  /** The clients a failure has been logged for already. */
  readonly #failed = new WeakSet<ClientConn>();
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  get size(): number {
    return this.#conns.size;
  }

  add(conn: ClientConn): void {
    this.#conns.add(conn);
  }

  delete(conn: ClientConn): void {
    this.#conns.delete(conn);
  }

  /** Tells every connected client. */
  broadcast(method: string, params: unknown): void {
    for (const conn of this.#conns) this.tell(conn, method, params);
  }

  /** Tells the client of one connection, if it is still connected (an answer for it alone). */
  tellOne(connectionId: string, method: string, params: unknown): void {
    for (const conn of this.#conns) if (conn.id === connectionId) this.tell(conn, method, params);
  }

  /** Tells one client, without waiting. A failure is logged by client and method, never by what was said. */
  tell(conn: ClientConn, method: string, params: unknown): void {
    conn.notify(method, params).catch((error: unknown) => {
      if (this.#failed.has(conn)) return;
      this.#failed.add(conn);
      this.#log.warn("notify_failed", { conn: conn.id, method, error: errorText(error) });
    });
  }
}
