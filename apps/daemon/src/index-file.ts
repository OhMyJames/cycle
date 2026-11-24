import { SessionUsageSchema } from "@cycle/protocol";
import { z } from "zod";
import { JsonFile, readJsonFile } from "./json-file.ts";

/** One session as the daemon records it. The history itself is in the session's log. */
export const SessionEntrySchema = z.object({
  agent: z.string(),
  /** The id the agent knows the session by. The same as the session's id when the agent adopted it. */
  agentSessionId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  /**
   * True when `title` came from the agent, and so may be replaced by a newer one from it. A title
   * without this is the user's (it is all there was before agents named sessions), and stays.
   */
  titleFromAgent: z.boolean().optional(),
  /**
   * What the session was created with beyond its directory, sent to the agent every time it starts.
   * Servers can carry secrets (env, headers): they are here, in the 0600 index, and nowhere else.
   */
  additionalDirectories: z.array(z.string()).optional(),
  mcpServers: z.array(z.unknown()).optional(),
  systemPrompt: z.unknown().optional(),
  /**
   * The environment the session was made with (docs/protocol.md §6 "环境"): its variables can be secrets, so it is here,
   * in the 0600 index, and not in the log. Checked when it was taken; read back as it was written.
   */
  environment: z.unknown().optional(),
  /** The agent's latest `usage_update`: shown in the session list. */
  usage: SessionUsageSchema.optional(),
  archived: z.boolean().optional(),
  /** True while prompts wait for the agent or a return receipt. Loading reads these from the log. */
  queued: z.boolean().optional(),
  /**
   * How far the clients have seen the session (`_cycle/session/mark_read`), and the seq of the last
   * record worth seeing: a turn that ended or a request for approval. The session is unread when the
   * second is past the first. Both are absent from an index written before they existed, and count
   * as 0: such a session is not unread.
   */
  readSeq: z.number().int().nonnegative().optional(),
  attentionSeq: z.number().int().nonnegative().optional(),
  /**
   * True once a turn of the session has been answered (it ended with `end_turn`): from then on the agent has a
   * record of its own, which a restarted agent must find. Sent to it as `cycle/hadTurn`.
   */
  hadTurn: z.boolean().optional(),
  /**
   * True once the person's first message is in the log: only then is the session in the list (docs/protocol.md §6).
   * False from creation until then. Absent from an entry written before the list asked: read from the log once.
   */
  prompted: z.boolean().optional(),
  /**
   * True from the record that opens a turn (the person's message, a `running` or `requires_action`) until an idle: a
   * turn is open in the log. Loading a session finds by it a turn the daemon stopped in the middle of, which gets its
   * end on record (docs/protocol.md §8). Absent from an entry written before it existed: then the log is read once.
   */
  turnOpen: z.boolean().optional(),
  /** What was asked of the agent with `session/set_config_option`, applied again when it is restarted. */
  config: z.record(z.string(), z.string()).optional(),
  createdAt: z.string(),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export type SessionPosition = readonly [createdAt: string, sessionId: string];
export const comparePosition = (
  [time, id]: SessionPosition,
  [otherTime, otherId]: SessionPosition,
): number =>
  time > otherTime ? -1 : time < otherTime ? 1 : id < otherId ? -1 : id > otherId ? 1 : 0;

const IndexSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), SessionEntrySchema),
});

/** The index is there but cannot be read. It is not replaced: it cannot be rebuilt. */
export class IndexUnreadableError extends Error {
  constructor(path: string, detail: string) {
    super(
      `The session index at ${path} cannot be read (${detail}). Fix or move it; it is not replaced.`,
    );
    this.name = "IndexUnreadableError";
  }
}

/**
 * Which sessions are Cycle's, and what the daemon knows of each (decision 0006). Kept apart from
 * the logs so that listing does not scan them. Written whole, to a temporary file that is then
 * renamed over the old one, so a crash leaves the old index or the new one and never half of one.
 */
export class SessionIndex {
  readonly #file: JsonFile<ReadonlyMap<string, SessionEntry>>;
  /** The order of creation, and the sessions it was made of: made again once they are not the ones kept. */
  #createdOrder: { of: ReadonlyMap<string, SessionEntry>; order: [string, string][] } | undefined;

  private constructor(path: string, sessions: Map<string, SessionEntry>) {
    this.#file = new JsonFile<ReadonlyMap<string, SessionEntry>>(path, sessions, (value) => ({
      version: 1,
      sessions: Object.fromEntries(value),
    }));
  }

  static async load(path: string): Promise<SessionIndex> {
    const parsed = await readJsonFile(
      path,
      IndexSchema,
      (detail) => new IndexUnreadableError(path, detail),
    );
    return new SessionIndex(path, new Map(Object.entries(parsed?.sessions ?? {})));
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.#file.value.get(sessionId);
  }

  list(): [string, SessionEntry][] {
    return [...this.#file.value.entries()];
  }

  /** Stable keys for paging. Metadata edits keep the order, and a cursor survives deletion of its row. */
  createdOrder(): ReadonlyArray<readonly [string, string]> {
    const sessions = this.#file.value;
    if (this.#createdOrder?.of !== sessions) {
      const order = [...sessions.entries()]
        .map(([id, e]): [string, string] => [e.createdAt, id])
        .sort(comparePosition);
      this.#createdOrder = { of: sessions, order };
    }
    return this.#createdOrder.order;
  }

  put(sessionId: string, entry: SessionEntry): Promise<void> {
    return this.#change((sessions) => {
      sessions.set(sessionId, SessionEntrySchema.parse(entry));
    });
  }

  /**
   * Changes an entry. A function is given the entry as it is when its turn in the queue comes, so a
   * change that depends on what is there (a mark that only moves forward) cannot be undone by one
   * made while it waited.
   */
  update(
    sessionId: string,
    change: Partial<SessionEntry> | ((entry: SessionEntry) => Partial<SessionEntry>),
  ): Promise<void> {
    return this.#change((sessions) => {
      const entry = sessions.get(sessionId);
      if (entry === undefined) throw new Error(`No session ${sessionId} in the index`);
      const patch = typeof change === "function" ? change(entry) : change;
      sessions.set(sessionId, SessionEntrySchema.parse({ ...entry, ...patch }));
    });
  }

  /** Resolves when every change made so far is on disk. */
  flush(): Promise<void> {
    return this.#file.flush();
  }

  delete(sessionId: string): Promise<void> {
    return this.#change((sessions) => {
      sessions.delete(sessionId);
    });
  }

  /** `apply` changes a copy of the sessions. */
  #change(apply: (sessions: Map<string, SessionEntry>) => void): Promise<void> {
    return this.#file.change((current) => {
      const sessions = new Map(current);
      apply(sessions);
      return { value: sessions, answer: undefined };
    });
  }
}
