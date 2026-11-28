import { z } from "zod";
import { cycleMethod } from "./method.ts";

/** How many prompts a session holds while its agent works (docs/protocol.md §8). */
export const QUEUE_LIMIT = 8;

/** The `sessionUpdate` of a queue snapshot. The daemon makes it; an agent never sends one. */
export const QUEUE_UPDATE = "_cycle/queue_update";

/** A prompt waiting for the agent. `queueId` is the daemon's; the history's `messageId` is the agent's. */
export const QueueEntrySchema = z.object({
  queueId: z.string(),
  prompt: z.array(z.unknown()),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

/** Why a queue was handed back. A client shows nothing for any of them: the text is back in its box. */
export const QueueReasonSchema = z.enum(["cancelled", "error", "closed", "interrupted"]);
export type QueueReason = z.infer<typeof QueueReasonSchema>;

/**
 * The whole queue, after each change. `entries` is state: the last one is the queue. `returned` is
 * an event: a client acts on it only when it arrives live, never in a replay.
 */
export const QueueUpdateSchema = z.object({
  sessionUpdate: z.literal(QUEUE_UPDATE),
  entries: z.array(QueueEntrySchema),
  returnId: z.string().optional(),
  returned: z.array(QueueEntrySchema).optional(),
  reason: QueueReasonSchema.optional(),
  /** The queue is held because the daemon is draining to update; its entries are sent after the switch (docs/protocol.md §8). */
  hold: z.literal("update").optional(),
});
export type QueueUpdate = z.infer<typeof QueueUpdateSchema>;

/** Takes a prompt back out of the queue, to be edited. Answers with what it held. */
export const promptDequeue = cycleMethod(
  "_cycle/prompt/dequeue",
  z.object({ sessionId: z.string(), queueId: z.string() }),
  z.object({ prompt: z.array(z.unknown()) }),
);

export const promptAckReturn = cycleMethod(
  "_cycle/prompt/ack_return",
  z.object({ sessionId: z.string(), returnId: z.string() }),
  z.object({ acknowledged: z.boolean() }),
);
