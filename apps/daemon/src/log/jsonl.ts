import { appendFile, mkdir, open, rename, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { commandsKey, isCommandsData } from "../commands-update.ts";
import { logUnavailable } from "../errors.ts";
import { compactChunks } from "./compact.ts";
import type { LogRecord, LogStore, NewRecord, ReadRange, SessionLog } from "./types.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type JsonlStoreOptions = {
  /** The directory the sessions' files go in. Always given: nothing here guesses a home. */
  dir: string;
  now?: () => Date;
  /** How many lines compaction must save for an opened log to be rewritten. Default 32. */
  minSaving?: number;
};

const isRecord = (value: unknown): value is LogRecord =>
  typeof value === "object" &&
  value !== null &&
  Number.isInteger((value as LogRecord).seq) &&
  typeof (value as LogRecord).ts === "string" &&
  typeof (value as LogRecord).kind === "string" &&
  isMergedField(value as LogRecord);

/** `merged` is only on an update, and is a whole number of 2 or more. */
const isMergedField = ({ merged, kind }: LogRecord): boolean =>
  merged === undefined || (kind === "update" && Number.isInteger(merged) && merged >= 2);

/**
 * Parses a file's text into records, checking that seq is 1, 2, 3, ... If there is a half line at
 * the end, from a crash, it is left out and `validBytes` says where the good part ends.
 */
export const parseLog = (
  sessionId: string,
  text: string,
): { records: LogRecord[]; validBytes: number } => {
  const end = text.lastIndexOf("\n") + 1;
  const records: LogRecord[] = [];
  if (end > 0) {
    const lines = text.slice(0, end - 1).split("\n");
    let last = 0;
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw logUnavailable(sessionId, `line ${index + 1} is not JSON`);
      }
      if (!isRecord(parsed)) throw logUnavailable(sessionId, `line ${index + 1} is not a record`);
      // A compacted record stands for `merged` records, so it is that far past the one before it.
      if (parsed.seq !== last + (parsed.merged ?? 1)) {
        throw logUnavailable(sessionId, `line ${index + 1} has seq ${parsed.seq}`);
      }
      last = parsed.seq;
      records.push(parsed);
    }
  }
  return { records, validBytes: Buffer.byteLength(text.slice(0, end)) };
};

class JsonlSessionLog implements SessionLog {
  readonly sessionId: string;
  readonly #path: string;
  readonly #now: () => Date;
  readonly #listeners = new Set<(record: LogRecord) => void>();
  #last: number;
  #updated: string | undefined;
  #commands: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    sessionId: string,
    path: string,
    last: number,
    updated: string | undefined,
    commands: string | undefined,
    now: () => Date,
  ) {
    this.sessionId = sessionId;
    this.#path = path;
    this.#last = last;
    this.#updated = updated;
    this.#commands = commands;
    this.#now = now;
  }

  lastCommands(): string | undefined {
    return this.#commands;
  }

  lastSeq(): number {
    return this.#last;
  }

  updatedAt(): string | undefined {
    return this.#updated;
  }

  append(record: NewRecord): Promise<LogRecord> {
    // One at a time, in the order called, so seq and the file agree.
    const run = this.#queue.then(() => this.#write(record));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(record: NewRecord): Promise<LogRecord> {
    if (this.#closed) throw logUnavailable(this.sessionId, "the log is closed");
    const stored: LogRecord = {
      seq: this.#last + 1,
      ts: this.#now().toISOString(),
      kind: record.kind,
      data: record.data,
    };
    try {
      await appendFile(this.#path, `${JSON.stringify(stored)}\n`);
    } catch (error) {
      throw logUnavailable(this.sessionId, String(error));
    }
    this.#last = stored.seq;
    if (stored.kind !== "meta") this.#updated = stored.ts;
    if (stored.kind === "update" && isCommandsData(stored.data))
      this.#commands = commandsKey(stored.data);
    for (const listener of [...this.#listeners]) listener(stored);
    return stored;
  }

  async read(range: ReadRange = {}): Promise<LogRecord[]> {
    const after = range.after ?? 0;
    const upTo = range.upTo ?? Number.POSITIVE_INFINITY;
    const text = await Bun.file(this.#path)
      .text()
      .catch((error) => {
        throw logUnavailable(this.sessionId, String(error));
      });
    const { records } = parseLog(this.sessionId, text);
    return records.filter((r) => r.seq > after && r.seq <= upTo);
  }

  subscribe(listener: (record: LogRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.#queue;
    this.#closed = true;
    this.#listeners.clear();
  }
}

export class JsonlLogStore implements LogStore {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #minSaving: number;
  readonly #open = new Set<string>();

  constructor(options: JsonlStoreOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? (() => new Date());
    this.#minSaving = options.minSaving ?? 32;
  }

  #path(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw logUnavailable(sessionId, "not a usable session id");
    return join(this.#dir, `${sessionId}.jsonl`);
  }

  async exists(sessionId: string): Promise<boolean> {
    return stat(this.#path(sessionId)).then(
      () => true,
      () => false,
    );
  }

  async open(sessionId: string, mode: "create" | "existing" = "create"): Promise<SessionLog> {
    const path = this.#path(sessionId);
    if (this.#open.has(sessionId)) throw logUnavailable(sessionId, "the log is already open");
    // Taken before anything is awaited: two opens at once cannot both get the file.
    this.#open.add(sessionId);
    let text: string;
    let records: LogRecord[];
    let updated: string | undefined;
    try {
      if (mode === "create") {
        await mkdir(this.#dir, { recursive: true });
        // A new session: make sure the file exists, then read what is there.
        await (await open(path, "a")).close();
      } else if (!(await this.exists(sessionId))) {
        // The index knows this session but its log is gone. Making an empty one would hide the loss
        // and number the next record from 1; the session is reported as unreadable instead.
        throw logUnavailable(sessionId, "the history file is missing");
      }
      text = await Bun.file(path).text();
      const parsed = parseLog(sessionId, text);
      records = parsed.records;
      // A crash can leave half a line. It is cut off now, before anything is appended: otherwise
      // the next record would be glued to it, and the damage would be in the middle of the file.
      if (parsed.validBytes < Buffer.byteLength(text)) await truncate(path, parsed.validBytes);
      // Nothing writes to it and no client is attached yet: the time to join the text chunks.
      // A joined record carries its first `ts`, so what `updatedAt` says is taken before.
      updated = records.findLast((record) => record.kind !== "meta")?.ts;
      if (mode === "existing") records = await this.#compact(path, records);
    } catch (error) {
      this.#open.delete(sessionId);
      throw error;
    }
    const commands = records.findLast((r) => r.kind === "update" && isCommandsData(r.data));
    const log = new JsonlSessionLog(
      sessionId,
      path,
      records.at(-1)?.seq ?? 0,
      updated,
      commands === undefined ? undefined : commandsKey(commands.data),
      this.#now,
    );
    const close = log.close.bind(log);
    log.close = async () => {
      await close();
      this.#open.delete(sessionId);
    };
    return log;
  }

  /**
   * Joins adjacent text chunks (`compactChunks`) and swaps the file for the result: written beside
   * it and renamed, so a crash leaves the old file or the new one, never half. A failure leaves the
   * old file as it was, which is still a good log.
   */
  async #compact(path: string, records: LogRecord[]): Promise<LogRecord[]> {
    const compacted = compactChunks(records);
    // A file is not rewritten for a few lines.
    if (records.length - compacted.length < this.#minSaving) return records;
    const temp = `${path}.compact`;
    try {
      // On disk before it replaces the only copy.
      const handle = await open(temp, "w");
      try {
        await handle.writeFile(compacted.map((record) => `${JSON.stringify(record)}\n`).join(""));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
      return compacted;
    } catch {
      await rm(temp, { force: true });
      return records;
    }
  }

  async remove(sessionId: string): Promise<void> {
    if (this.#open.has(sessionId)) throw logUnavailable(sessionId, "the log is open");
    await rm(this.#path(sessionId), { force: true });
  }
}
