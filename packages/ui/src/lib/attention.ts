import type { SessionStatus } from "@cycle/protocol";

const ATTENTION: Partial<Record<SessionStatus, string>> = {
  waiting: "Needs your approval",
  idle: "Finished",
  error: "Stopped with an error",
};

/**
 * What to tell the owner when a session they are not looking at changes: it asks, or it stops
 * after working. Null when nothing is worth saying, including when nothing changed.
 */
export function attentionLabel(before: SessionStatus, after: SessionStatus): string | null {
  if (before === after) return null;
  const wasWorking = before === "running" || before === "waiting";
  const label = ATTENTION[after];
  if (!label || (!wasWorking && after !== "waiting")) return null;
  return label;
}
