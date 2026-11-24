/** What a record is. See docs/protocol.md §12. */
export type RecordKind = "update" | "request" | "response" | "aborted" | "meta";

/** What a caller appends. The log adds `seq` and `ts`. */
export type NewRecord = { kind: RecordKind; data: unknown };

export type LogRecord = NewRecord & {
  /** Rising with no gap, except where `merged` says so: 1, 2, 3, ... in a log never compacted. */
  seq: number;
  /** ISO 8601, set by the log when the record is accepted. */
  ts: string;
  /**
   * Set on a record that joins this many (2 or more) records written one after another, when the
   * log was compacted. Its seq is the last of them, so the seq before it is `seq - merged`.
   */
  merged?: number;
};

export type ReadRange = {
  /** Only records with a greater seq. Default 0, which is all of them. */
  after?: number;
  /** Only records up to and including this seq. Default: the last one. */
  upTo?: number;
};

/**
 * One session's history. The storage behind it can change (decision 0002); the daemon depends on
 * this and not on files.
 *
 * Single writer: the daemon is the only thing that appends, and appends are made one at a time in
 * the order they were called.
 *
 * A client sees gaps in `seq`: `meta`, `response` and `aborted` records are not sent as
 * `session/update`. Nothing client-side may require seq to be contiguous.
 */
export interface SessionLog {
  readonly sessionId: string;
  /** The seq of the last record written, 0 if none. A record counts once it is on disk. */
  lastSeq(): number;
  /** The `ts` of the last record that is not a `meta` one, or undefined if there is none. */
  updatedAt(): string | undefined;
  /** The last `available_commands_update` written, as `commandsKey` makes it; undefined if there is none. */
  lastCommands(): string | undefined;
  append(record: NewRecord): Promise<LogRecord>;
  /** `stored`: the records as they are kept, with what was moved out of them (images) left as references. */
  read(range?: ReadRange, options?: { stored?: boolean }): Promise<LogRecord[]>;
  /** Called, in seq order, after each record is written. Returns what stops the calls. */
  subscribe(listener: (record: LogRecord) => void): () => void;
  close(): Promise<void>;
}

export interface LogStore {
  /**
   * Opens a session's log. "create" (the default) makes one if there is none, for a new session;
   * "existing" is for a session already on record and fails with LogUnavailable if its log is
   * gone. Opening it twice is a bug.
   */
  open(sessionId: string, mode?: "create" | "existing"): Promise<SessionLog>;
  /** Removes a session's history for good. The session must not be open. */
  remove(sessionId: string): Promise<void>;
  exists(sessionId: string): Promise<boolean>;
}
