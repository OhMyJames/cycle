// `cycle stop` does not stop a daemon whose sessions are working (exit 4) and lists them. The update swaps the app under
// that daemon, so it cannot go on; what the person is told is which sessions are in the way, not the command's own failure.

/** The message for a `cycle stop` that refused, or undefined when it failed for another reason. */
export const stopRefusal = (error: unknown): string | undefined => {
  const failed = error as { code?: unknown; stdout?: unknown };
  if (failed?.code !== 4) return undefined;
  const sessions = String(failed.stdout ?? "")
    .split("\n")
    .flatMap((line) => (line.startsWith("  - ") ? [line.slice(4).trim()] : []));
  if (sessions.length === 0)
    return "Sessions are still working, so Cycle did not restart. Install again when they finish.";
  const shown = sessions.slice(0, 3).join("; ");
  const more = sessions.length > 3 ? `; and ${sessions.length - 3} more` : "";
  return `${sessions.length === 1 ? "A session is" : `${sessions.length} sessions are`} still working, so Cycle did not restart: ${shown}${more}. Install again when they finish.`;
};
