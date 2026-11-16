import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Says whether files changed: a text that is the same until one of them is written, added or
 * removed. A harness takes it as a port, so a test gives its own and touches no disk.
 */
export type Stamp = (paths: string[]) => Promise<string>;

/** The files and folders the owner's servers, plugins and commands are read from, in every folder. */
export function ownerFiles(env: Record<string, string | undefined>, home: string): string[] {
  // Claude Code keeps its user settings beside the home it is moved to, or else in the user's own.
  const config = env["CLAUDE_CONFIG_DIR"]
    ? join(home, ".claude.json")
    : join(homedir(), ".claude.json");
  return [
    config,
    join(home, "settings.json"),
    join(home, "settings.local.json"),
    join(home, "plugins", "installed_plugins.json"),
    join(home, "commands"),
    join(home, "skills"),
  ];
}

/** What a folder brings of its own: its commands and skills, and the settings that turn plugins on. */
export function folderFiles(cwd: string): string[] {
  const dot = join(cwd, ".claude");
  return [
    join(dot, "commands"),
    join(dot, "skills"),
    join(dot, "settings.json"),
    join(dot, "settings.local.json"),
  ];
}

/**
 * The modified time of each path, or a dash for one that is not there. A folder's changes when an
 * entry directly in it is added or removed, which is how a new command or skill shows.
 *
 * shortcut: a command or skill edited in place, with no entry added or removed, is not seen;
 * upgrade when a changed description should show before the next process starts.
 */
export const fileStamp: Stamp = async (paths) => {
  const times = await Promise.all(
    paths.map((path) =>
      stat(path).then(
        (found) => String(found.mtimeMs),
        () => "-",
      ),
    ),
  );
  return times.join("|");
};
