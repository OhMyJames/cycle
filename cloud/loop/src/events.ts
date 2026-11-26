import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { type LoopEvent, LoopEventSchema, type LoopEventsListResult } from "@cycle/protocol";

/** Per events file: who the file is, and the byte offset where each complete line starts. */
type Index = { ino: number; birthtimeMs: number; size: number; starts: number[] };
const indexes = new Map<string, Index>();
/** Updates of one file's index run one at a time: two polls must not both extend it from the same offset. */
const chains = new Map<string, Promise<unknown>>();
const serial = <T>(path: string, work: () => Promise<T>): Promise<T> => {
  const next = (chains.get(path) ?? Promise.resolve()).then(work, work);
  chains.set(
    path,
    next.catch(() => {}),
  );
  return next;
};

/** Failures being logged, so a client polling every second does not flood the log; cleared once a call succeeds. */
const logged = new Set<string>();
const logOnce = (reason: string, projectKey: string, code?: string): void => {
  const line = `loop: ${reason} project=${projectKey}${code ? ` code=${code}` : ""}`;
  if (logged.has(line)) return;
  logged.add(line);
  console.error(line);
};
const recovered = (projectKey: string): void => {
  for (const line of logged) if (line.includes(` project=${projectKey}`)) logged.delete(line);
};

const EMPTY = { ino: 0, birthtimeMs: 0, size: 0, starts: [0] };

/** Brings the index up to the complete lines now in the file; starts over when the file is not the one it knew. */
const refresh = async (path: string, handle: FileHandle | undefined): Promise<Index> => {
  const stat = handle ? await handle.stat() : undefined;
  const known = indexes.get(path);
  let index: Index = known ?? { ...EMPTY, starts: [0] };
  if (
    stat === undefined ||
    stat.size < index.size ||
    stat.ino !== index.ino ||
    stat.birthtimeMs !== index.birthtimeMs
  ) {
    index = { ...EMPTY, starts: [0], ino: stat?.ino ?? 0, birthtimeMs: stat?.birthtimeMs ?? 0 };
  }
  if (handle && stat && stat.size > index.size) {
    const chunk = Buffer.alloc(stat.size - index.size);
    await handle.read(chunk, 0, chunk.length, index.size);
    const starts = [...index.starts];
    let consumed = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        starts.push(index.size + i + 1);
        consumed = i + 1;
      }
    }
    index = { ...index, starts, size: index.size + consumed };
  }
  indexes.set(path, index);
  return index;
};

/**
 * Events of a Project after `afterSeq`, read from `<stateDir>/events.jsonl`. The file is append-only, so a line's
 * number is its `seq`: the same line always has the same one, with no counter to keep and old lines included.
 * A line without its newline yet is still being written and waits; a line that is not an event keeps its number
 * but is skipped. Only `seq`, `ts`, `run` and `kind` leave: the rest of a line may hold paths or addresses.
 * Line offsets are remembered, so a poll reads only the bytes of the page's own lines. `limit` counts lines looked
 * at, so a page with corrupt lines may hold fewer events; `hasMore` then can be true with only corrupt lines left.
 */
export const eventsList = async (
  projectKey: string,
  stateDir: string | undefined,
  afterSeq: number,
  limit: number,
): Promise<LoopEventsListResult> => {
  if (stateDir === undefined) {
    logOnce("state_dir_unknown", projectKey);
    throw new Error("state_dir_unknown");
  }
  const path = join(stateDir, "events.jsonl");
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(path, "r");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const index = await serial(path, () => refresh(path, handle));
    const total = index.starts.length - 1;
    if (afterSeq > total) throw new Error("seq_ahead");
    const end = Math.min(total, afterSeq + limit);
    const events: LoopEvent[] = [];
    if (handle && end > afterSeq) {
      const from = index.starts[afterSeq] as number;
      const buf = Buffer.alloc((index.starts[end] as number) - from);
      await handle.read(buf, 0, buf.length, from);
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < end - afterSeq; i++) {
        const seq = afterSeq + i + 1;
        try {
          const raw = JSON.parse(lines[i] as string) as Record<string, unknown>;
          events.push(LoopEventSchema.parse({ seq, ts: raw.ts, run: raw.run, kind: raw.kind }));
        } catch {
          // not an event: keeps its number, is not sent
        }
      }
    }
    recovered(projectKey);
    return { projectKey, events, lastSeq: end, hasMore: end < total };
  } catch (error) {
    if ((error as Error).message === "seq_ahead") throw error;
    logOnce("events_unreadable", projectKey, (error as { code?: string }).code);
    throw new Error("events_unreadable");
  } finally {
    await handle?.close();
  }
};
