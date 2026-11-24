// A session's environment as the daemon keeps and uses it (docs/protocol.md §6 "环境").
import {
  checkEnvironment,
  environmentVariables,
  META,
  type Scripts,
  type SessionEnvironment,
  secretKey,
  summarizeEnvironment,
} from "@cycle/protocol";
import type { SessionEntry } from "./index-file.ts";
import { readSecrets, withoutSecrets } from "./secrets.ts";

/**
 * The environment a session was made with, as the index keeps it. It was checked when it was taken, but the index can
 * have been written by another version or by hand: one that does not pass the same rules (its shape, names, reserved
 * names) counts as none, so a list, a launch or a terminal never fails on it or hands an agent a name it should not.
 */
export const environmentOf = (entry: SessionEntry): SessionEnvironment | undefined => {
  const kept = entry.environment;
  if (typeof kept !== "object" || kept === null) return undefined;
  // Checked once for each value the index holds: a list reads every row's, a launch and a terminal read it again.
  if (!checked.has(kept)) {
    const result = checkEnvironment(kept);
    checked.set(kept, result.ok ? result.environment : undefined);
  }
  return checked.get(kept);
};

/** What the rules make of each environment the index has held (the same as when it was taken, or none). */
const checked = new WeakMap<object, SessionEnvironment | undefined>();

/**
 * The variables the commands an agent runs are given, by name: the literal ones only. A secret never goes here: an agent
 * can print what its commands see (docs/protocol.md §6 "环境"). Empty when the session has no environment.
 */
export const commandVariables = (entry: SessionEntry | undefined): Record<string, string> =>
  entry === undefined ? {} : environmentVariables(environmentOf(entry));

/**
 * What a terminal, an action and a setup or cleanup script are given: the literal variables and the secrets, read from
 * `secrets.env` now. A secret the file has no value for is left unset. `scrub` takes the values out of text those
 * scripts printed, for anything that is shown or told to an agent.
 */
export const shellVariables = async (
  entry: SessionEntry | undefined,
  dataDir: string,
): Promise<{ variables: Record<string, string>; scrub: (text: string) => string }> =>
  shellVariablesOf(entry === undefined ? undefined : environmentOf(entry), dataDir);

/** The same, for an environment a session is being made with and has no entry yet. */
export const shellVariablesOf = async (
  environment: SessionEnvironment | undefined,
  dataDir: string,
): Promise<{ variables: Record<string, string>; scrub: (text: string) => string }> => {
  const variables = environmentVariables(environment);
  const secrets = environment?.secrets ?? [];
  if (secrets.length === 0) return { variables, scrub: (text) => text };
  const held = await readSecrets(dataDir);
  const values: string[] = [];
  for (const secret of secrets) {
    const { name } = secret;
    const value = held[secretKey(secret)];
    if (value === undefined) continue;
    variables[name] = value;
    values.push(value);
  }
  return { variables, scrub: (text) => withoutSecrets(text, values) };
};

/** What a `session/list` row says of the environment: its name, its variables' names and its actions. */
export const environmentRowMeta = (entry: SessionEntry): Record<string, unknown> => {
  const environment = environmentOf(entry);
  return {
    ...(environment !== undefined ? { [META.environment]: summarizeEnvironment(environment) } : {}),
    ...(entry.worktree !== undefined ? { [META.worktree]: entry.worktree } : {}),
  };
};

/** The script for this system: its own, else the default, else none (an empty one is none). */
export const scriptFor = (
  scripts: Scripts | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  if (scripts === undefined) return undefined;
  const own =
    platform === "darwin"
      ? scripts.macos
      : platform === "win32"
        ? scripts.windows
        : platform === "linux"
          ? scripts.linux
          : undefined;
  const chosen = own ?? scripts.default;
  return chosen !== undefined && chosen.trim() !== "" ? chosen : undefined;
};
