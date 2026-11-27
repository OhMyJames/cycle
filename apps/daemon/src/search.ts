// Full-text search of the conversations this daemon keeps (docs/protocol.md §8 "搜索对话内容"). An inverted index over
// the sessions' JSONL files, built as they grow: each file is read from where the last search stopped, so old lines are
// not read twice. It holds words and seqs, not text: a hit's snippet is read from the history when it is asked for.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SearchHit } from "@cycle/protocol";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TOKEN = 64;
/** A message past this many characters is indexed by its start: the index is not for megabytes of pasted logs. */
const MAX_INDEXED_CHARS = 100_000;
const SNIPPET_CHARS = 160;
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

/** What a record says in words, and who said it; undefined for records that are not conversation. */
export const sayingOf = (data: unknown): { from: "user" | "agent"; text: string } | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const update = data as { sessionUpdate?: unknown; content?: unknown };
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
    return b?.type === "text" && typeof b.text === "string" && b.text !== ""
      ? { from: "agent", text: b.text }
      : undefined;
  }
  return undefined;
};

type Line = { seq: number; saying: { from: "user" | "agent"; text: string } | undefined };

/** The complete lines of a chunk of file, as records. A line that is not a record is skipped. */
const linesOf = (text: string): { lines: Line[]; bytes: number } => {
  const end = text.lastIndexOf("\n") + 1;
  const lines: Line[] = [];
  if (end === 0) return { lines, bytes: 0 };
  for (const line of text.slice(0, end - 1).split("\n")) {
    try {
      const record = JSON.parse(line) as { seq?: unknown; kind?: unknown; data?: unknown };
      if (!Number.isInteger(record.seq)) continue;
      lines.push({
        seq: record.seq as number,
        saying: record.kind === "update" ? sayingOf(record.data) : undefined,
      });
    } catch {}
  }
  return { lines, bytes: Buffer.byteLength(text.slice(0, end)) };
};

const around = (text: string, at: number, length: number): string => {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const before = Math.max(0, at - Math.floor((SNIPPET_CHARS - length) / 3));
  const after = Math.min(text.length, before + SNIPPET_CHARS);
  const cut = flat(text.slice(before, after)).trim();
  return `${before > 0 ? "…" : ""}${cut}${after < text.length ? "…" : ""}`;
};

export class SearchIndex {
  readonly #dir: string;
  /** Per session: how many bytes of its file are indexed. */
  readonly #done = new Map<string, number>();
  /** word → session → seqs, rising. */
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
    this.#done.delete(sessionId);
  }

  async #sync(sessionId: string): Promise<void> {
    const path = this.#path(sessionId);
    const size = await stat(path).then(
      (s) => s.size,
      () => undefined,
    );
    if (size === undefined) return this.#forget(sessionId);
    let from = this.#done.get(sessionId) ?? 0;
    // Shorter than what was read: the file was rewritten (compaction), so its seqs are not the ones indexed.
    if (size < from) {
      this.#forget(sessionId);
      from = 0;
    }
    if (size === from) return;
    const handle = await open(path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const { lines, bytes } = linesOf(text);
    const words = this.#words.get(sessionId) ?? new Set<string>();
    this.#words.set(sessionId, words);
    for (const { seq, saying } of lines) {
      this.#processed += 1;
      if (saying === undefined) continue;
      for (const word of tokensOf(saying.text.slice(0, MAX_INDEXED_CHARS))) {
        const sessions = this.#postings.get(word) ?? new Map<string, number[]>();
        this.#postings.set(word, sessions);
        const seqs = sessions.get(sessionId);
        if (seqs === undefined) sessions.set(sessionId, [seq]);
        else if (seqs.at(-1) !== seq) seqs.push(seq);
        words.add(word);
      }
    }
    this.#done.set(sessionId, from + bytes);
  }

  /** Brings the index up to the files: reads what was added, drops what is gone. One at a time. */
  sync(sessionIds: readonly string[]): Promise<void> {
    const run = this.#queue.then(async () => {
      const wanted = new Set(sessionIds.filter((id) => SAFE_ID.test(id)));
      for (const id of [...this.#done.keys()]) if (!wanted.has(id)) this.#forget(id);
      for (const id of wanted) await this.#sync(id);
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
    const needles = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== "");
    const tokens = [...tokensOf(query)];
    if (tokens.length === 0) return { hits: [], truncated: false };
    const hits: SearchHit[] = [];
    for (const sessionId of sessionIds) {
      const lists = tokens.map((t) => this.#postings.get(t)?.get(sessionId));
      if (lists.some((l) => l === undefined)) continue;
      const [first, ...rest] = (lists as number[][]).sort((a, b) => a.length - b.length);
      const sets = rest.map((l) => new Set(l));
      const seqs = (first ?? []).filter((s) => sets.every((set) => set.has(s))).reverse();
      if (seqs.length === 0) continue;
      const wanted = new Set(seqs);
      const said = await this.#read(sessionId, wanted);
      for (const seq of seqs) {
        const saying = said.get(seq);
        if (saying === undefined) continue;
        const lower = saying.text.toLowerCase();
        if (!needles.every((n) => lower.includes(n))) continue;
        if (hits.length === limit) return { hits, truncated: true };
        const at = lower.indexOf(needles[0] ?? "");
        hits.push({
          sessionId,
          seq,
          from: saying.from,
          snippet: around(saying.text, Math.max(0, at), needles[0]?.length ?? 0),
        });
      }
    }
    return { hits, truncated: false };
  }

  /** The words of some records of a session, read from its file as it is now. */
  async #read(
    sessionId: string,
    seqs: ReadonlySet<number>,
  ): Promise<Map<number, NonNullable<Line["saying"]>>> {
    const found = new Map<number, NonNullable<Line["saying"]>>();
    const text = await Bun.file(this.#path(sessionId))
      .text()
      .catch(() => "");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      // Cheap test before parsing: most lines are not asked for.
      const seq = /^\{"seq":(\d+),/.exec(line)?.[1];
      if (seq !== undefined && !seqs.has(Number(seq))) continue;
      try {
        const record = JSON.parse(line) as { seq?: number; kind?: unknown; data?: unknown };
        if (record.seq === undefined || !seqs.has(record.seq) || record.kind !== "update") continue;
        const saying = sayingOf(record.data);
        if (saying !== undefined) found.set(record.seq, saying);
      } catch {}
    }
    return found;
  }
}
