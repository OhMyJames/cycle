/** The Codex CLI and app-server schema baseline used by this harness. */
export const CODEX_VERSION = "0.171.0" as const;

/**
 * Options every Codex command is run with, the app-server and `cycle codex <args>` alike: the login is kept in
 * `$CODEX_HOME/auth.json`, never the system keychain, whose entries are not kept apart by CODEX_HOME.
 */
export const CODEX_FIXED_ARGS = ["-c", 'cli_auth_credentials_store="file"'] as const;

/** What the adapter takes in a prompt beyond text and links: images, and embedded text (a PDF blob is refused). */
export const CODEX_PROMPT_CAPABILITIES = { image: {}, embeddedContext: {} } as const;

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
