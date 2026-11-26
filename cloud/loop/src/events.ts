import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LoopEvent, LoopEventSchema, type LoopEventsListResult } from "@cycle/protocol";

/**
 * Events of a Project after `afterSeq`, read from `<stateDir>/events.jsonl`. The file is append-only, so a line's
 * number is its `seq`: the same line always has the same one, with no counter to keep and old lines included.
 * A line without its newline yet is still being written and waits; a line that is not an event keeps its number
 * but is skipped. Only `seq`, `ts`, `run` and `kind` leave: the rest of a line may hold paths or addresses.
 */
export const eventsList = async (
  projectKey: string,
  stateDir: string | undefined,
  afterSeq: number,
  limit: number,
): Promise<LoopEventsListResult> => {
  if (stateDir === undefined) {
    console.error(`loop: state_dir_unknown project=${projectKey}`);
    throw new Error("state_dir_unknown");
  }
  let text = "";
  try {
    text = await readFile(join(stateDir, "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      console.error(`loop: events_unreadable project=${projectKey}`);
      throw new Error("events_unreadable");
    }
  }
  const lines = text.split("\n");
  lines.pop(); // after the last newline: empty, or a line still being written
  if (afterSeq > lines.length) {
    // The file is shorter than the client's last seq: it was replaced. The client starts over from 0.
    throw new Error("seq_ahead");
  }
  const events: LoopEvent[] = [];
  let lastSeq = afterSeq;
  let hasMore = false;
  for (let i = afterSeq; i < lines.length; i++) {
    if (events.length >= limit) {
      hasMore = true;
      break;
    }
    lastSeq = i + 1;
    try {
      const raw = JSON.parse(lines[i] as string) as Record<string, unknown>;
      events.push(LoopEventSchema.parse({ seq: i + 1, ts: raw.ts, run: raw.run, kind: raw.kind }));
    } catch {
      // not an event: keeps its number, is not sent
    }
  }
  return { projectKey, events, lastSeq, hasMore };
};
