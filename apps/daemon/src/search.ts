// Full-text search of the conversations this daemon keeps (docs/protocol.md §8 "搜索对话内容"). An inverted index over
// the sessions' JSONL files, built as they grow: each file is read from where the last search stopped, so old lines are
// not read twice. It holds words and seqs, not text: a hit's snippet is read from the history when it is asked for.
// A message is what the person sent, or one reply of the agent: its streamed chunks (same `messageId`, one after the
// other) are one message, and a message is named by the seq of its first record.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SearchHit } from "@cycle/protocol";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TOKEN = 64;
/** A message past this many characters is indexed by its start: the index is not for megabytes of pasted logs. */
const MAX_INDEXED_CHARS = 100_000;
const SNIPPET_CHARS = 160;
/** The most read from a file at a time. */
const READ_BYTES = 1 << 20;
/** How much of a line is looked at to tell whether the file is still the one that was indexed. */
const FINGERPRINT_BYTES = 4096;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]+/gu;

/** The words of a text as the index and the query see them: lower case; CJK as single characters and pairs. */
export const tokensOf = (text: string): Set<string> => {
  const tokens = new Set<string>();
  for (const [word] of text.toLowerCase().matchAll(WORD)) {
    const chars = [...word];
    let run: string[] = [];
    const flush = () => {
      if (run.length > 0) tokens.add(run.join("").slice(0, MAX_TOKEN));
      run = [];
    };
    for (const [i, ch] of chars.entries()) {
      if (CJK.test(ch)) {
        flush();
        tokens.add(ch);
        const next = chars[i + 1];
        if (next !== undefined && CJK.test(next)) tokens.add(ch + next);
      } else run.push(ch);
    }
    flush();
  }
  return tokens;
};

type Block = { type?: unknown; text?: unknown };
type Saying = { from: "user" | "agent"; text: string; messageId?: string };

/** What a record says in words, and who said it; undefined for records that are not conversation. */
export const sayingOf = (data: unknown): Saying | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const update = data as { sessionUpdate?: unknown; content?: unknown; messageId?: unknown };
  if (update.sessionUpdate === "user_message") {
    const blocks = Array.isArray(update.content) ? update.content : [update.content];
    const text = blocks
      .map((b: Block | null) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter((t) => t !== "")
      .join("\n");
    return text === "" ? undefined : { from: "user", text };
  }
  if (update.sessionUpdate === "agent_message_chunk") {
    const b = update.content as Block | null;
    if (b?.type !== "text" || typeof b.text !== "string" || b.text === "") return undefined;
    return {
      from: "agent",
      text: b.text,
      ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
    };
  }
  return undefined;
};

/** Puts the chunks of one reply together: says which message (by first seq) each saying belongs to. */
class Grouper {
  #open: { messageId: string; key: number; tail: string } | undefined;

  /** `joined` is the end of what came before in this message, then this chunk: the words that cross a chunk. */
  feed(seq: number, saying: Saying): { key: number; joined: string } {
    if (saying.from === "user" || saying.messageId === undefined) {
      this.#open = undefined;
      return { key: seq, joined: saying.text };
    }
    const same = this.#open?.messageId === saying.messageId ? this.#open : undefined;
    const joined = (same?.tail ?? "") + saying.text;
    this.#open = {
      messageId: saying.messageId,
      key: same?.key ?? seq,
      tail: joined.slice(-MAX_TOKEN),
    };
    return { key: this.#open.key, joined };
  }
}

type Line = { text: string; start: number; end: number; bytes: Buffer };

/** The complete lines of a file from a byte, read a piece at a time. A half line at the end is not given. */
async function* linesOf(path: string, from: number, size: number): AsyncGenerator<Line> {
  const handle = await open(path, "r");
  try {
    let at = from;
    let pending = Buffer.alloc(0);
    let pendingStart = from;
    while (at < size) {
      const buffer = Buffer.alloc(Math.min(READ_BYTES, size - at));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
      if (bytesRead === 0) break;
      at += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let from0 = 0;
      for (let nl = pending.indexOf(10, from0); nl >= 0; nl = pending.indexOf(10, from0)) {
        const bytes = pending.subarray(from0, nl);
        yield {
          text: bytes.toString("utf8"),
          start: pendingStart + from0,
          end: pendingStart + nl + 1,
          bytes,
        };
        from0 = nl + 1;
      }
      pendingStart += from0;
      pending = pending.subarray(from0);
    }
  } finally {
    await handle.close();
  }
}

const parse = (text: string): { seq: number; saying: Saying | undefined } | undefined => {
  try {
    const record = JSON.parse(text) as { seq?: unknown; kind?: unknown; data?: unknown };
    if (!Number.isInteger(record.seq)) return undefined;
    return {
      seq: record.seq as number,
      saying: record.kind === "update" ? sayingOf(record.data) : undefined,
    };
  } catch {
    return undefined;
  }
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const around = (text: string, at: number, length: number): string => {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const before = Math.max(0, at - Math.floor((SNIPPET_CHARS - length) / 3));
  const after = Math.min(text.length, before + SNIPPET_CHARS);
  const cut = flat(text.slice(before, after)).trim();
  return `${before > 0 ? "…" : ""}${cut}${after < text.length ? "…" : ""}`;
};

type Progress = {
  /** Bytes of the file that are indexed. */
  done: number;
  /** The last indexed line: where it is and what it starts with, to tell a rewritten file from a longer one. */
  last: { start: number; hash: bigint } | undefined;
  grouper: Grouper;
};

const fingerprint = (bytes: Buffer): bigint =>
  BigInt(Bun.hash(bytes.subarray(0, FINGERPRINT_BYTES)));

export class SearchIndex {
  readonly #dir: string;
  readonly #progress = new Map<string, Progress>();
  /** word → session → message keys, rising. */
  readonly #postings = new Map<string, Map<string, number[]>>();
  readonly #words = new Map<string, Set<string>>();
  #queue: Promise<unknown> = Promise.resolve();
  #processed = 0;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /** How many records have been read into the index since it was made: a record is read once. */
  get processed(): number {
    return this.#processed;
  }

  #path(sessionId: string): string {
    return join(this.#dir, `${sessionId}.jsonl`);
  }

  #forget(sessionId: string): void {
    for (const word of this.#words.get(sessionId) ?? []) {
      const sessions = this.#postings.get(word);
      sessions?.delete(sessionId);
      if (sessions?.size === 0) this.#postings.delete(word);
    }
    this.#words.delete(sessionId);
    this.#progress.delete(sessionId);
  }

  /** Whether the file still starts with what was indexed: its last indexed line is where it was. */
  async #unchanged(path: string, progress: Progress): Promise<boolean> {
    if (progress.last === undefined) return true;
    const handle = await open(path, "r");
    try {
      const length = Math.min(FINGERPRINT_BYTES, progress.done - 1 - progress.last.start);
      const buffer = Buffer.alloc(length + 1);
      const probe = Buffer.alloc(1);
      const { bytesRead } = await handle.read(buffer, 0, length, progress.last.start);
      await handle.read(probe, 0, 1, progress.done - 1);
      return (
        bytesRead === length &&
        probe[0] === 10 &&
        fingerprint(buffer.subarray(0, length)) === progress.last.hash
      );
    } finally {
      await handle.close();
    }
  }

  async #sync(sessionId: string): Promise<void> {
    const path = this.#path(sessionId);
    const size = await stat(path).then(
      (s) => s.size,
      () => undefined,
    );
    if (size === undefined) return this.#forget(sessionId);
    let progress = this.#progress.get(sessionId);
    // Shorter, or not the same file: it was rewritten (compaction), so its seqs are not the ones indexed.
    if (
      progress !== undefined &&
      (size < progress.done || !(await this.#unchanged(path, progress)))
    ) {
      this.#forget(sessionId);
      progress = undefined;
    }
    if (progress === undefined) {
      progress = { done: 0, last: undefined, grouper: new Grouper() };
      this.#progress.set(sessionId, progress);
    }
    if (size === progress.done) return;
    const words = this.#words.get(sessionId) ?? new Set<string>();
    this.#words.set(sessionId, words);
    for await (const line of linesOf(path, progress.done, size)) {
      progress.done = line.end;
      progress.last = { start: line.start, hash: fingerprint(line.bytes) };
      const record = parse(line.text);
      if (record === undefined) continue;
      this.#processed += 1;
      if (record.saying === undefined) continue;
      const { key, joined } = progress.grouper.feed(record.seq, record.saying);
      for (const word of tokensOf(joined.slice(0, MAX_INDEXED_CHARS))) {
        const sessions = this.#postings.get(word) ?? new Map<string, number[]>();
        this.#postings.set(word, sessions);
        const keys = sessions.get(sessionId);
        if (keys === undefined) sessions.set(sessionId, [key]);
        else if (keys.at(-1) !== key) keys.push(key);
        words.add(word);
      }
    }
  }

  /** Brings the index up to the files: reads what was added, drops what is gone. One at a time. */
  sync(sessionIds: readonly string[]): Promise<void> {
    const run = this.#queue.then(async () => {
      const wanted = new Set(sessionIds.filter((id) => SAFE_ID.test(id)));
      for (const id of [...this.#progress.keys()]) if (!wanted.has(id)) this.#forget(id);
      for (const id of wanted) {
        // A file that cannot be read is left out of this search; the others are still searched.
        await this.#sync(id).catch(() => this.#forget(id));
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Messages that say every word of the query, in the sessions given (newest first), each session's latest first. */
  async search(
    sessionIds: readonly string[],
    query: string,
    limit: number,
  ): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    await this.sync(sessionIds);
    const tokens = [...tokensOf(query)];
    if (tokens.length === 0) return { hits: [], truncated: false };
    const hits: SearchHit[] = [];
    for (const sessionId of sessionIds) {
      const lists = tokens.map((t) => this.#postings.get(t)?.get(sessionId));
      if (lists.some((l) => l === undefined)) continue;
      const [first, ...rest] = (lists as number[][]).sort((a, b) => a.length - b.length);
      const sets = rest.map((l) => new Set(l));
      const keys = (first ?? []).filter((s) => sets.every((set) => set.has(s))).reverse();
      if (keys.length === 0) continue;
      const said = await this.#read(sessionId, new Set(keys));
      for (const key of keys) {
        const saying = said.get(key);
        if (saying === undefined) continue;
        // The same words the index saw, over the whole message: what the index found is only a likely.
        const words = tokensOf(saying.text);
        if (!tokens.every((t) => words.has(t))) continue;
        if (hits.length === limit) return { hits, truncated: true };
        let at = 0;
        let length = 0;
        for (const token of tokens) {
          const found = new RegExp(escapeRegExp(token), "iu").exec(saying.text);
          if (found !== null) {
            at = found.index;
            length = token.length;
            break;
          }
        }
        hits.push({
          sessionId,
          seq: key,
          from: saying.from,
          snippet: around(saying.text, at, length),
        });
      }
    }
    return { hits, truncated: false };
  }

  /** The words of some messages of a session, read from its file as it is now, a piece at a time. */
  async #read(
    sessionId: string,
    keys: ReadonlySet<number>,
  ): Promise<Map<number, { from: "user" | "agent"; text: string }>> {
    const found = new Map<number, { from: "user" | "agent"; text: string }>();
    const path = this.#path(sessionId);
    const size = await stat(path).then(
      (s) => s.size,
      () => 0,
    );
    const grouper = new Grouper();
    const last = Math.max(...keys);
    try {
      for await (const line of linesOf(path, 0, size)) {
        const record = parse(line.text);
        if (record?.saying === undefined) continue;
        const { key } = grouper.feed(record.seq, record.saying);
        // Nothing after the last message asked for belongs to one.
        if (key > last) break;
        if (!keys.has(key)) continue;
        const had = found.get(key);
        if (had === undefined)
          found.set(key, { from: record.saying.from, text: record.saying.text });
        else if (had.text.length < MAX_INDEXED_CHARS) had.text += record.saying.text;
      }
    } catch {}
    return found;
  }
}
