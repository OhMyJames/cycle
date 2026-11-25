/** The Codex CLI and app-server schema baseline used by this harness. */
export const CODEX_VERSION = "0.171.0" as const;

/**
 * Options every Codex command is run with, the app-server and `cycle codex <args>` alike: CLI auth and MCP OAuth
 * credentials stay in `$CODEX_HOME` files, never the system keychain, whose entries are not kept apart by CODEX_HOME.
 */
export const CODEX_FIXED_ARGS = [
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  'mcp_oauth_credentials_store="file"',
] as const;

/**
 * The whole command line after the executable for every `codex app-server` Cycle starts: the session's and the short
 * ones Settings uses to read the account, sign in and sign out. One list, so they never differ.
 */
export const codexAppServerArgs = (): string[] => [
  ...CODEX_FIXED_ARGS,
  "-c",
  "check_for_update_on_startup=false",
  "app-server",
];

/** What the adapter takes in a prompt beyond text and links: images, and embedded text (a PDF blob is refused). */
export const CODEX_PROMPT_CAPABILITIES = { image: {}, embeddedContext: {} } as const;

/** Notifications this adapter consumes from that pinned app-server protocol. Unknown notifications are ignored. */
export const CODEX_NOTIFICATION_METHODS = [
  "turn/started",
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
  "skills/changed",
  "thread/name/updated",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
] as const;
