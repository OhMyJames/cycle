import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogRecord, LogStore, NewRecord, ReadRange, SessionLog } from "./types.ts";

/** Decision 0013: the bytes of attachments live beside the log, not in it. */
export const BLOB_META = "cycle/blob";
export const BLOB_MISSING_META = "cycle/blobMissing";
/** base64 shorter than this stays in the log: a file for a few KB is not worth it. */
export const BLOB_MIN_CHARS = 16 * 1024;

const HASH = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_DEPTH = 12;
/** Blobs written by this process stay in memory (up to this much) so a live broadcast need not read them back. */
const RECENT_CHARS = 24 * 1024 * 1024;

type Recent = { held: Map<string, string>; chars: number };
type Ref = { field: "data" | "blob"; sha256: string; bytes: number };
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The field of `value` that holds attachment bytes, if it is an image block or an embedded resource. */
const fieldOf = (value: Json): "data" | "blob" | undefined => {
  if (value.type === "image" && typeof value.data === "string") return "data";
  if (typeof value.uri === "string" && typeof value.blob === "string") return "blob";
  return undefined;
};

/** A copy of `value` with `change` applied to every object that has attachment bytes or a reference. */
const rewrite = async (
  value: unknown,
  change: (object: Json) => Promise<Json | undefined>,
  depth = 0,
): Promise<unknown> => {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    const items = await Promise.all(value.map((item) => rewrite(item, change, depth + 1)));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isObject(value)) return value;
  let result: Json = value;
  const changed = await change(value);
  if (changed !== undefined) result = changed;
  let copied = result !== value;
  for (const [key, child] of Object.entries(result)) {
    const next = await rewrite(child, change, depth + 1);
    if (next !== child) {
      if (!copied) {
        result = { ...result };
        copied = true;
      }
      result[key] = next;
    }
  }
  return result;
};

/** Whether `test` holds for some object inside `value`: a look, with nothing awaited and nothing copied. */
const any = (value: unknown, test: (object: Json) => boolean, depth = 0): boolean => {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => any(item, test, depth + 1));
  if (!isObject(value)) return false;
  return test(value) || Object.values(value).some((child) => any(child, test, depth + 1));
};

class BlobSessionLog implements SessionLog {
  readonly sessionId: string;
  readonly #inner: SessionLog;
  readonly #dir: string;
  readonly #recent: Recent;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(inner: SessionLog, dir: string, recent: Recent) {
    this.sessionId = inner.sessionId;
    this.#inner = inner;
    this.#dir = dir;
    this.#recent = recent;
  }

  lastSeq(): number {
    return this.#inner.lastSeq();
  }

  updatedAt(): string | undefined {
    return this.#inner.updatedAt();
  }

  lastCommands(): string | undefined {
    return this.#inner.lastCommands();
  }

  #remember(sha256: string, text: string): void {
    const recent = this.#recent;
    const key = `${this.sessionId}/${sha256}`;
    if (recent.held.has(key)) return;
    recent.held.set(key, text);
    recent.chars += text.length;
    for (const [oldest, held] of recent.held) {
      if (recent.chars <= RECENT_CHARS) break;
      recent.held.delete(oldest);
      recent.chars -= held.length;
    }
  }

  async #store(text: string): Promise<string> {
    const sha256 = createHash("sha256").update(text).digest("hex");
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const path = join(this.#dir, sha256);
    // The same bytes again (one picture attached twice) are already there.
    if (
      !(await stat(path).then(
        () => true,
        () => false,
      ))
    ) {
      // A name of its own: two of the same bytes at once must not share a temporary file.
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, path);
    }
    this.#remember(sha256, text);
    return sha256;
  }

  append(record: NewRecord): Promise<LogRecord> {
    // One at a time, in the order called: storing a blob is asynchronous, and seq must follow the
    // callers' order (and a close must wait for what was already asked).
    const run = this.#queue.then(() => this.#append(record));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #append(record: NewRecord): Promise<LogRecord> {
    // Most records (a streamed word) have nothing in them to move: no walk, no awaits.
    if (
      !any(record.data, (object) => {
        const field = fieldOf(object);
        return field !== undefined && (object[field] as string).length >= BLOB_MIN_CHARS;
      })
    ) {
      return this.#inner.append(record);
    }
    // Written before the line that points to it.
    const data = await rewrite(record.data, async (object) => {
      const field = fieldOf(object);
      if (field === undefined) return undefined;
      const text = object[field] as string;
      if (text.length < BLOB_MIN_CHARS) return undefined;
      const sha256 = await this.#store(text);
      const meta = isObject(object._meta) ? object._meta : {};
      const ref: Ref = { field, sha256, bytes: text.length };
      return { ...object, [field]: "", _meta: { ...meta, [BLOB_META]: ref } };
    });
    return this.#restore(await this.#inner.append({ ...record, data }));
  }

  async #load(sha256: string): Promise<string | undefined> {
    const held = this.#recent.held.get(`${this.sessionId}/${sha256}`);
    if (held !== undefined) return held;
    return readFile(join(this.#dir, sha256), "utf8").then(
      (text) => text,
      () => undefined,
    );
  }

  /** The record with each reference replaced by its bytes. A record with no reference is returned as it is. */
  async #restore(record: LogRecord): Promise<LogRecord> {
    if (!any(record.data, (object) => isObject(object._meta) && BLOB_META in object._meta)) {
      return record;
    }
    const data = await rewrite(record.data, async (object) => {
      const meta = object._meta;
      const ref = isObject(meta) ? (meta[BLOB_META] as Partial<Ref> | undefined) : undefined;
      if (!isObject(ref)) return undefined;
      const { _meta, ...rest } = object;
      const { [BLOB_META]: _ref, ...otherMeta } = meta as Json;
      const kept = Object.keys(otherMeta).length > 0 ? { _meta: otherMeta } : {};
      const field = ref.field === "blob" ? "blob" : "data";
      const text =
        typeof ref.sha256 === "string" && HASH.test(ref.sha256)
          ? await this.#load(ref.sha256)
          : undefined;
      if (text === undefined) {
        return { ...rest, [field]: "", _meta: { ...otherMeta, [BLOB_MISSING_META]: true } };
      }
      return { ...rest, [field]: text, ...kept };
    });
    return data === record.data ? record : { ...record, data };
  }

  async read(range?: ReadRange, options?: { stored?: boolean }): Promise<LogRecord[]> {
    if (options?.stored === true) return this.#inner.read(range);
    return Promise.all((await this.#inner.read(range)).map((record) => this.#restore(record)));
  }

  subscribe(listener: (record: LogRecord) => void): () => void {
    // Restoring is asynchronous; a chain keeps the calls in seq order.
    let chain: Promise<unknown> = Promise.resolve();
    let live = true;
    const stop = this.#inner.subscribe((record) => {
      chain = chain.then(async () => {
        const restored = await this.#restore(record).catch(() => record);
        if (live) listener(restored);
      });
    });
    return () => {
      live = false;
      stop();
    };
  }

  async close(): Promise<void> {
    await this.#queue;
    await this.#inner.close();
  }
}

/**
 * Keeps attachment bytes out of a session's log (decision 0013). Wraps any store: the log it opens
 * writes references and reads bytes.
 */
export class BlobLogStore implements LogStore {
  readonly #inner: LogStore;
  readonly #dir: string;
  readonly #recent: Recent = { held: new Map(), chars: 0 };

  /** `dir`: the directory that holds one directory of blobs for each session. */
  constructor(inner: LogStore, dir: string) {
    this.#inner = inner;
    this.#dir = dir;
  }

  #sessionDir(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw new Error("not a usable session id");
    return join(this.#dir, sessionId);
  }

  async open(sessionId: string, mode?: "create" | "existing"): Promise<SessionLog> {
    return new BlobSessionLog(
      await this.#inner.open(sessionId, mode),
      this.#sessionDir(sessionId),
      this.#recent,
    );
  }

  async remove(sessionId: string): Promise<void> {
    await this.#inner.remove(sessionId);
    for (const key of [...this.#recent.held.keys()]) {
      if (key.startsWith(`${sessionId}/`)) {
        this.#recent.chars -= this.#recent.held.get(key)?.length ?? 0;
        this.#recent.held.delete(key);
      }
    }
    await rm(this.#sessionDir(sessionId), { recursive: true, force: true });
  }

  exists(sessionId: string): Promise<boolean> {
    return this.#inner.exists(sessionId);
  }
}
