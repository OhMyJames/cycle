import type { Session } from "@cycle/protocol";

type Mark = Pick<Session, "activity" | "failed">;

/**
 * What to tell the owner when a session they are not looking at changes: it asks, or it stops
 * after working. Null when nothing is worth saying, including when nothing changed.
 */
export function attentionLabel(before: Mark, after: Mark): string | null {
  if (after.activity === "requires_action") {
    return before.activity === "requires_action" ? null : "Needs your approval";
  }
  if (after.activity === "idle" && before.activity !== "idle") {
    return after.failed ? "Stopped with an error" : "Finished";
  }
  return null;
}
