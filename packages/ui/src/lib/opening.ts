/** The key a new session's composer keeps its text and returned attachments under. */
export const draftKey = (cwd: string): string => `new:${cwd}`;

/** What became of a new session's first prompt. */
export type Opening = "sent" | "dropped" | "kept";

/**
 * A session the page just made has nothing in it until its first prompt is taken. When the agent
 * does not take it (Claude Code cannot start, say), the session would stay as an empty "New
 * session": it is deleted instead, and the prompt stays in the composer it came from. A session
 * that cannot be deleted stays, and the prompt waits in its own composer.
 */
export async function opening(ports: {
  send: () => Promise<boolean>;
  /** Deletes the session, which holds nothing but the notice of what went wrong. True when it is gone. */
  drop: () => Promise<boolean>;
}): Promise<Opening> {
  if (await ports.send()) return "sent";
  return (await ports.drop()) ? "dropped" : "kept";
}
