import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the daemon keeps its data: `$CYCLE_HOME`, else `~/.cycle`.
 * Everything that opens files takes the directory as an argument, and tests pass a temporary one, so
 * no test can reach a real home.
 */
export const DATA_DIR_ENV = "CYCLE_HOME";

export const defaultDataDir = (env: Record<string, string | undefined> = process.env): string =>
  env[DATA_DIR_ENV] ?? join(homedir(), ".cycle");

/** The app release a client last said it was, in `initialize`: what `cycle update` installs (docs/daemon.md "cycle update"). */
export const appVersionPath = (dataDir: string): string => join(dataDir, "app-version");

export const sessionsDir = (dataDir: string): string => join(dataDir, "sessions");
/** One directory of attachment bytes for each session (decision 0013). */
export const blobsDir = (dataDir: string): string => join(dataDir, "blobs");
export const indexPath = (dataDir: string): string => join(dataDir, "index.json");
export const defaultsPath = (dataDir: string): string => join(dataDir, "agent-defaults.json");
/** Per-agent hot-reloadable runtime settings overrides (docs/protocol.md §16). */
export const agentSettingsPath = (dataDir: string): string => join(dataDir, "agent-settings.json");
/** Cached dynamic choices discovered from live agents (e.g. Claude's `initializationResult().models`). */
export const optionsCachePath = (dataDir: string): string => join(dataDir, "agent-options.json");
/** Which folders may run their own configuration's commands (docs/protocol.md §8 "信任文件夹"). */
export const trustPath = (dataDir: string): string => join(dataDir, "trust.json");
/** The owner's model providers, keys included: private to the account (docs/adapters/codex.md "自带模型"). */
export const providersPath = (dataDir: string): string => join(dataDir, "providers.json");
/** Values an environment's secrets name, read when they are used and never kept elsewhere (docs/protocol.md §6 "环境"). */
export const secretsPath = (dataDir: string): string => join(dataDir, "secrets.env");
