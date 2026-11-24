// The sessions of each connection: the list (and what in it is worth telling the person), and the sessions being
// watched, whose conversation main keeps whole so a renderer that reloads is given it.
import type { SessionRow } from "@cycle/client";
import {
  type Attention,
  applyUpdate,
  attentionOf,
  type Conversation,
  emptyConversation,
  type SessionSnapshot,
  type SessionSummary,
} from "@cycle/ui";
import type { Pending, PendingStore } from "./pending.ts";
import type { Connection, Runtime } from "./runtime.ts";

/** What the main process is told when a session that was changing is in a state that wants the person. */
export type AttentionNotice = {
  environmentId: string;
  environmentName: string;
  session: SessionSummary;
  kind: Attention;
};

/** What main holds for a session being watched, so a renderer that reloads can be given it whole. */
export type Watched = {
  conversation: Conversation;
  pending: Map<string, Pending>;
  /** Events sent about this session. The renderer compares it with the snapshot it was given. */
  version: number;
};

/** A session watched from now, before its history has come. */
export const emptyWatched = (): Watched => ({
  conversation: { ...emptyConversation(), replaying: true },
  pending: new Map(),
  version: 0,
});

const sessionSummary = (environmentId: string, row: SessionRow): SessionSummary => {
  const meta = (row._meta ?? {}) as Record<string, unknown>;
  return {
    environmentId,
    sessionId: row.sessionId,
    cwd: row.cwd,
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
    archived: meta["cycle/archived"] === true,
    agent: String(meta["cycle/agent"] ?? ""),
    state: (meta["cycle/state"] as SessionSummary["state"]) ?? "stopped",
    lastSeq: Number(meta["cycle/lastSeq"] ?? 0),
    ...(typeof meta["cycle/unread"] === "boolean" ? { unread: meta["cycle/unread"] } : {}),
    ...(typeof meta["cycle/background"] === "number"
      ? { background: meta["cycle/background"] }
      : {}),
    ...(Array.isArray(meta["cycle/backgroundUnknown"])
      ? {
          unknownBackground: meta["cycle/backgroundUnknown"].filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
    ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    ...(typeof meta["cycle/config"] === "object" && meta["cycle/config"] !== null
      ? { config: meta["cycle/config"] as Record<string, string> }
      : {}),
  };
};

export class SessionWatcher {
  readonly #runtime: Runtime;
  readonly #pending: PendingStore;

  constructor(runtime: Runtime, pending: PendingStore) {
    this.#runtime = runtime;
    this.#pending = pending;
  }

  /**
   * Reads the session list and tells the renderer. `afterOutage`: the connection was away, so a session that went from
   * working to stopped may only have been released while nobody watched, and what finished is old news: only a session
   * that is asking (and is still asking) is told.
   */
  async refresh(
    environmentId: string,
    connection: Connection,
    afterOutage = false,
  ): Promise<SessionSummary[]> {
    const runtime = this.#runtime;
    const asked = ++connection.asked;
    const sessions: SessionSummary[] = [];
    let pages = 0;
    for await (const page of connection.client.sessionPages()) {
      pages++;
      for (const row of page.sessions) sessions.push(sessionSummary(environmentId, row));
      // Only preview the first connection. Replacing a known list with a partial one would
      // briefly hide search results and could misclassify attention on a later page.
      if (
        pages === 1 &&
        page.hasMore &&
        !connection.listed &&
        asked === connection.asked &&
        !runtime.hasListed(environmentId) &&
        runtime.isCurrent(environmentId, connection)
      ) {
        runtime.emit({ type: "sessions", environmentId, sessions: [...sessions] });
      }
    }
    // An answer to an older question, arriving after the answer to a newer one, would put the list back.
    if (asked < connection.applied) return connection.sessions;
    connection.applied = asked;
    // The environment may have been removed while the question was out: its list must not come back.
    if (!runtime.isCurrent(environmentId, connection)) return sessions;
    const before = new Map(connection.sessions.map((s) => [s.sessionId, s]));
    const first = !connection.listed;
    if (first) runtime.track("session_list_loaded", { pages });
    connection.listed = true;
    connection.sessions = sessions;
    runtime.keepSessions(environmentId, sessions);
    runtime.emit({ type: "sessions", environmentId, sessions });
    this.#tell(environmentId, before, sessions, afterOutage, first);
    return sessions;
  }

  /** What changed since the list before is what the person may want to be told. A hook that fails must not break the list. */
  #tell(
    environmentId: string,
    before: ReadonlyMap<string, SessionSummary>,
    sessions: readonly SessionSummary[],
    afterOutage: boolean,
    first: boolean,
  ): void {
    const attention = this.#runtime.options.attention;
    const environmentName = this.#runtime.nameOf(environmentId);
    for (const session of sessions) {
      // A session enters the list with its first message (docs/protocol.md §6), already at work: after the first list,
      // one that appears is taken to have been idle, so that one already waiting on the person is told; or, if a turn of
      // it has ended unseen, to have been running, so that one that has finished by the time it is read is told too.
      const was =
        before.get(session.sessionId) ??
        (first
          ? undefined
          : {
              ...session,
              state: session.unread === true ? ("running" as const) : ("idle" as const),
            });
      const kind = attentionOf(was, session);
      if (kind === undefined || (afterOutage && kind !== "needs-you")) continue;
      this.#runtime.track("session_attention", { kind });
      if (attention === undefined) continue;
      try {
        attention({ environmentId, environmentName, session, kind });
      } catch {
        // A notification that cannot be shown is a notification missed, not a list that cannot be read.
      }
    }
  }

  /** Watches a session (once, however many ask at the same time) and gives what main holds of it. */
  async open(environmentId: string, sessionId: string): Promise<SessionSnapshot> {
    const connection = this.#runtime.connection(environmentId);
    let opening = connection.opening.get(sessionId);
    if (opening === undefined) {
      opening = this.#watch(connection, sessionId).finally(() =>
        connection.opening.delete(sessionId),
      );
      connection.opening.set(sessionId, opening);
    }
    await opening;
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) throw new Error("The session is gone");
    this.#runtime.track("session_opened", {
      agent: this.#runtime.agentOf(environmentId, sessionId),
      environment: this.#runtime.kindOf(environmentId),
    });
    return {
      conversation: watched.conversation,
      permissions: [...watched.pending.values()].map((p) => p.request),
      version: watched.version,
    };
  }

  async #watch(connection: Connection, sessionId: string): Promise<void> {
    if (connection.watched.has(sessionId)) return;
    const cwd =
      connection.sessions.find((s) => s.sessionId === sessionId)?.cwd ??
      connection.made.get(sessionId);
    if (cwd === undefined) throw new Error("No such session");
    connection.watched.set(sessionId, emptyWatched());
    try {
      await connection.client.watch(sessionId, cwd);
    } catch (error) {
      connection.watched.delete(sessionId);
      throw error;
    }
  }

  update(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    update: Parameters<typeof applyUpdate>[1],
    at: number | undefined,
  ): void {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) return;
    watched.conversation = applyUpdate(watched.conversation, update, { at });
    watched.version += 1;
    this.#runtime.emit({
      type: "update",
      environmentId,
      sessionId,
      update,
      ...(at !== undefined ? { at } : {}),
      version: watched.version,
    });
  }

  /** A watched session's history could not be read on reconnecting: it is not watched, and nothing waits on it. */
  unreadable(connection: Connection, sessionId: string): void {
    if (!connection.watched.has(sessionId)) return;
    this.#pending.release(connection, { sessionId, cancel: true });
    connection.watched.delete(sessionId);
  }

  /** A watched session was deleted elsewhere while the connection was away: nothing is waiting on it any more. */
  gone(environmentId: string, connection: Connection, sessionId: string): void {
    if (!connection.watched.has(sessionId)) return;
    this.#pending.release(connection, { sessionId, cancel: true });
    connection.watched.delete(sessionId);
    // The renderer drops the view (and with it the permission dialogs), the draft and the selection.
    this.#runtime.emit({ type: "session-gone", environmentId, sessionId });
  }

  /** The session was deleted from here: it is not watched any more. */
  deleted(connection: Connection, sessionId: string): void {
    this.#pending.release(connection, { sessionId, cancel: false });
    connection.watched.delete(sessionId);
  }
}
