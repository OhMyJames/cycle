import { open } from "node:fs/promises";
import { join } from "node:path";
import { type LoopEvent, LoopEventSchema, type LoopEventsListResult } from "@cycle/protocol";

/** Per events file: the byte offset where each complete line starts, extended as the file grows. */
type Index = { size: number; starts: number[] };
const indexes = new Map<string, Index>();
/** Failures already logged, so a client polling every second does not flood the log. */
const logged = new Set<string>();
const logOnce = (reason: string, projectKey: string): void => {
  const line = `loop: ${reason} project=${projectKey}`;
  if (logged.has(line)) return;
  logged.add(line);
  console.error(line);
};

/**
 * Events of a Project after `afterSeq`, read from `<stateDir>/events.jsonl`. The file is append-only, so a line's
 * number is its `seq`: the same line always has the same one, with no counter to keep and old lines included.
 * A line without its newline yet is still being written and waits; a line that is not an event keeps its number
 * but is skipped. Only `seq`, `ts`, `run` and `kind` leave: the rest of a line may hold paths or addresses.
 * Line offsets are remembered, so a poll reads only the bytes after `afterSeq`.
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
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(path, "r");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const size = handle ? (await handle.stat()).size : 0;
    let index = indexes.get(path);
    if (index === undefined || size < index.size) index = { size: 0, starts: [0] };
    if (handle && size > index.size) {
      const chunk = Buffer.alloc(size - index.size);
      await handle.read(chunk, 0, chunk.length, index.size);
      // Only complete lines count: the index stops after the last newline.
      let consumed = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) {
          index.starts.push(index.size + i + 1);
          consumed = i + 1;
        }
      }
      index.size += consumed;
    }
    indexes.set(path, index);
    const total = index.starts.length - 1;
    if (afterSeq > total) throw new Error("seq_ahead");
    const events: LoopEvent[] = [];
    let lastSeq = afterSeq;
    let hasMore = false;
    if (handle && afterSeq < total) {
      const from = index.starts[afterSeq] as number;
      const buf = Buffer.alloc(index.size - from);
      await handle.read(buf, 0, buf.length, from);
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < total - afterSeq; i++) {
        if (events.length >= limit) {
          hasMore = true;
          break;
        }
        const seq = afterSeq + i + 1;
        lastSeq = seq;
        try {
          const raw = JSON.parse(lines[i] as string) as Record<string, unknown>;
          events.push(LoopEventSchema.parse({ seq, ts: raw.ts, run: raw.run, kind: raw.kind }));
        } catch {
          // not an event: keeps its number, is not sent
        }
      }
    }
    return { projectKey, events, lastSeq, hasMore };
  } catch (error) {
    if ((error as Error).message === "seq_ahead") throw error;
    logOnce("events_unreadable", projectKey);
    throw new Error("events_unreadable");
  } finally {
    await handle?.close();
  }
};
