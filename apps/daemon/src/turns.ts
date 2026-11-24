import type { LogRecord } from "./log/types.ts";

/**
 * What a stop would cut short in one session (`Daemon.activity`): a turn in progress, how many requests in it wait on
 * the owner, background sub-agents still working, and how many prompts are queued behind the turn (those are kept).
 */
export type Activity = {
  sessionId: string;
  title?: string;
  turn: boolean;
  pending: number;
  background: number;
  queued: number;
};

/**
 * What a logged update says of the turn: true when it opens one (the person's message, the agent at work or waiting
 * on the owner), false when it ends it (any idle), undefined when it says nothing about it. See docs/protocol.md §8.
 */
export const opensOrEndsTurn = (update: Record<string, unknown>): boolean | undefined => {
  if (update.sessionUpdate === "user_message") return true;
  if (update.sessionUpdate !== "state_update") return undefined;
  if (update.state === "running" || update.state === "requires_action") return true;
  if (update.state === "idle") return false;
  return undefined;
};

/** Whether a log ends with a turn open: something opened one and no idle came after it. */
export const turnLeftOpen = (records: readonly LogRecord[]): boolean => {
  let open = false;
  for (const record of records) {
    if (record.kind !== "update") continue;
    const said = opensOrEndsTurn(record.data as Record<string, unknown>);
    if (said !== undefined) open = said;
  }
  return open;
};

/** A record of something the person said: the agent's echo of a prompt (docs/protocol.md §8). */
export const isUserMessage = (record: LogRecord): boolean =>
  record.kind === "update" &&
  (record.data as { sessionUpdate?: unknown } | null)?.sessionUpdate === "user_message";
