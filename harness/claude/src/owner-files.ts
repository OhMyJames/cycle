import { readFile, stat } from "node:fs/promises";
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
 * The part of Claude Code's user config that says which servers there are. Claude Code rewrites the
 * rest of the file itself, as it starts and as it runs, so the file's time says nothing.
 */
export function serversOf(text: string): string {
  try {
    const found = (JSON.parse(text) as { mcpServers?: unknown }).mcpServers;
    return JSON.stringify(found ?? null);
  } catch {
    return "unreadable";
  }
}

/** The digests of the user config read so far, by the file's time and size, which it is read again for. */
const digests = new Map<string, { at: string; digest: string }>();

async function serversDigest(path: string): Promise<string> {
  try {
    // The file is large and rewritten often: it is read only when its time or size says so.
    const found = await stat(path);
    const at = `${found.mtimeMs}:${found.size}`;
    const kept = digests.get(path);
    if (kept?.at === at) return kept.digest;
    const digest = String(Bun.hash(serversOf(await readFile(path, "utf8"))));
    digests.set(path, { at, digest });
    return digest;
  } catch {
    return "-";
  }
}

/**
 * The modified time of each path, or a dash for one that is not there; for the user config, the
 * servers in it, as a digest so no value is kept. A folder's time changes when an entry directly
 * in it is added or removed, which is how a new command or skill shows.
 *
 * shortcut: a command or skill edited in place, one in a folder nested in the commands, and a
 * project's own `.mcp.json` are not seen; upgrade when those should show before the next process
 * starts.
 */
export const fileStamp: Stamp = async (paths) => {
  const parts = await Promise.all(
    paths.map((path) =>
      path.endsWith(".claude.json")
        ? serversDigest(path)
        : stat(path).then(
            (found) => String(found.mtimeMs),
            () => "-",
          ),
    ),
  );
  return parts.join("|");
};
