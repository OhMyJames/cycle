import type { LogRecord } from "./types.ts";

/** The streamed text an agent sends in pieces: `agent_message_chunk` and `agent_thought_chunk`. */
const CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk"]);

type Chunk = { update: Record<string, unknown>; text: string; rest: string };

/** A record's streamed text, or undefined when it is not a plain text chunk that can be joined. */
const chunkOf = (record: LogRecord): Chunk | undefined => {
  if (record.kind !== "update" || record.merged !== undefined) return undefined;
  const update = record.data as Record<string, unknown> | null;
  if (typeof update !== "object" || update === null) return undefined;
  if (typeof update.sessionUpdate !== "string" || !CHUNKS.has(update.sessionUpdate))
    return undefined;
  const content = update.content as Record<string, unknown> | null | undefined;
  if (typeof content !== "object" || content === null) return undefined;
  if (content.type !== "text" || typeof content.text !== "string") return undefined;
  if (Object.keys(content).some((key) => key !== "type" && key !== "text")) return undefined;
  // Everything but the words has to be the same, `messageId` and `_meta` included.
  const { content: _content, ...others } = update;
  return { update, text: content.text, rest: JSON.stringify(others) };
};

/**
 * Joins runs of adjacent text chunks of the same message into one record (docs/protocol.md §12,
 * "Compaction"). In a run, the records between the first and the last become one with their last
 * seq, `merged` as their number, the first of them as `ts` and all their text. A client that has
 * seen up to the end of them, or more, is shown nothing twice, and seq still adds up.
 *
 * Only runs followed by another record are joined. The end of the log is left as it is: a message
 * can still be growing there.
 */
export const compactChunks = (records: readonly LogRecord[]): LogRecord[] => {
  const out: LogRecord[] = [];
  let i = 0;
  while (i < records.length) {
    const first = records[i] as LogRecord;
    const head = chunkOf(first);
    let end = i + 1;
    if (head !== undefined) {
      while (end < records.length) {
        const next = chunkOf(records[end] as LogRecord);
        if (next === undefined || next.rest !== head.rest) break;
        end++;
      }
    }
    // The first and last of a run stay as they are: a client shows when the text began from the
    // first one's time and when it ended from the last one's. Two or more between them are joined.
    if (head === undefined || end - i < 4 || end === records.length) {
      out.push(...records.slice(i, end));
    } else {
      const middle = records.slice(i + 1, end - 1);
      const text = middle.map((record) => (chunkOf(record) as Chunk).text).join("");
      out.push(first, {
        seq: (middle[middle.length - 1] as LogRecord).seq,
        ts: (middle[0] as LogRecord).ts,
        kind: "update",
        merged: middle.length,
        data: { ...head.update, content: { type: "text", text } },
      });
      out.push(records[end - 1] as LogRecord);
    }
    i = end;
  }
  return out;
};
