/** The Codex CLI and app-server schema baseline used by this harness. */
export const CODEX_VERSION = "0.171.0" as const;

/** Notifications this adapter consumes from that pinned app-server protocol. Unknown notifications are ignored. */
export const CODEX_NOTIFICATION_METHODS = [
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "turn/plan/updated",
  "thread/status/changed",
  "contextCompacted",
  "thread/compacted",
  "skills/changed",
  "thread/name/updated",
  "thread/tokenUsage/updated",
] as const;
