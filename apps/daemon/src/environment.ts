// A session's environment as the daemon keeps and uses it (docs/protocol.md §6 "环境").
import {
  environmentVariables,
  META,
  type Scripts,
  type SessionEnvironment,
  SessionEnvironmentSchema,
  summarizeEnvironment,
} from "@cycle/protocol";
import type { SessionEntry } from "./index-file.ts";

/**
 * The environment a session was made with, as the index keeps it. It was checked when it was taken, but the index can
 * have been written by another version or by hand: one this version cannot read counts as none, so a list, a launch
 * or a terminal never fails on it.
 */
export const environmentOf = (entry: SessionEntry): SessionEnvironment | undefined => {
  if (entry.environment === undefined) return undefined;
  const parsed = SessionEnvironmentSchema.safeParse(entry.environment);
  return parsed.success ? parsed.data : undefined;
};

/** The variables a session's commands are given, by name. Empty when it has no environment. */
export const sessionVariables = (entry: SessionEntry | undefined): Record<string, string> =>
  entry === undefined ? {} : environmentVariables(environmentOf(entry));

/** What a `session/list` row says of the environment: its name, its variables' names and its actions. */
export const environmentRowMeta = (entry: SessionEntry): Record<string, unknown> => {
  const environment = environmentOf(entry);
  return environment !== undefined ? { [META.environment]: summarizeEnvironment(environment) } : {};
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
