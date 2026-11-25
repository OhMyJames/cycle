// What an agent keeps in the home the daemon gives it: how much, and clearing the part that can be fetched again.
// Only the names in CACHE_LEAVES are ever removed. Never a home as a whole, never a login, a plugin, a session's
// history or anything an agent wrote for the owner (docs/protocol.md §16 "本地存储").
import { lstat, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import type { StorageAgent, StorageItem } from "@cycle/protocol";
import type { Config } from "./config.ts";
import type { Harness } from "./harness.ts";

/** An agent's Cycle-managed data directory (its `storageDir`, or `HOME` fallback), by agent. */
export type AgentHome = { agent: string; name: string; home: string };

/** Each managed directory made for an agent: what the harness declares as its storageDir (or its `HOME` fallback), `config.json` overrides included. */
export const agentHomesOf = (
  harnesses: readonly Harness[],
  config: Config,
  dataDir: string,
  inherited: Record<string, string | undefined>,
): AgentHome[] =>
  harnesses.flatMap((harness) => {
    const context = { config, dataDir, inherited };
    const home =
      harness.storageDir !== undefined
        ? harness.storageDir(context)
        : harness.cli?.env(context).HOME;
    return home === undefined || home === ""
      ? []
      : [{ agent: harness.id, name: harness.name, home }];
  });

/** Package managers' downloads and OS caches. Each is fetched again by whatever needs it. Paths below an agent's home. */
export const CACHE_LEAVES: readonly { id: string; path: readonly string[] }[] = [
  { id: "bun-cache", path: [".bun", "install", "cache"] },
  { id: "npm-cache", path: [".npm", "_cacache"] },
  { id: "npx-cache", path: [".npm", "_npx"] },
  { id: "library-caches", path: ["Library", "Caches"] },
  { id: "uv-cache", path: [".cache", "uv"] },
];

/** What an agent resumes a session from. Shown, never cleared. */
export const HISTORY_LEAVES: readonly { id: string; path: readonly string[] }[] = [
  { id: "projects", path: ["projects"] },
  { id: "sessions", path: ["sessions"] },
];

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

/** The size on disk of one folder, in bytes, without following a link. Undefined when it could not be measured in time: not 0, which would read as empty. */
export const sizeOf = async (path: string): Promise<number | undefined> => {
  try {
    const du = Bun.spawn(["du", "-skP", "--", path], {
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(30_000),
    });
    const out = await new Response(du.stdout).text();
    await du.exited;
    const kilobytes = Number.parseInt(out, 10);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined;
  } catch {
    return undefined;
  }
};

type HomeState =
  | { state: "managed"; real: string }
  /** Not made yet: the agent has not run. */
  | { state: "missing" }
  /** Outside the data directory (the owner's own folder), or not something to look at. */
  | { state: "unmanaged" };

/** Whether `home` is inside `dataDir` (never `dataDir` itself), with the real path when it is. */
const homeState = async (home: string, dataDir: string): Promise<HomeState> => {
  try {
    const [real, root] = await Promise.all([realpath(home), realpath(dataDir)]);
    return real.startsWith(root + sep) ? { state: "managed", real } : { state: "unmanaged" };
  } catch (error) {
    return missing(error) ? { state: "missing" } : { state: "unmanaged" };
  }
};

/**
 * A leaf that is a real folder inside the home: there, not a link, and no link on the way to it (a link to another
 * place in the home would have the wrong folder removed). Anything that cannot be told is not one.
 */
const leafPath = async (home: string, path: readonly string[]): Promise<string | undefined> => {
  const full = join(home, ...path);
  try {
    const info = await lstat(full);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    return (await realpath(full)) === full ? full : undefined;
  } catch {
    return undefined;
  }
};

const itemsOf = async (
  home: string,
  leaves: typeof CACHE_LEAVES,
  kind: StorageItem["kind"],
): Promise<StorageItem[]> => {
  const found = await Promise.all(
    leaves.map(async (leaf) => {
      const path = await leafPath(home, leaf.path);
      if (path === undefined) return undefined;
      const bytes = await sizeOf(path);
      return bytes === undefined ? undefined : { id: leaf.id, kind, bytes };
    }),
  );
  return found.filter((item): item is StorageItem => item !== undefined);
};

/** How much each agent keeps in its home, for the ones whose home is the daemon's to look after. */
export const readStorage = async (
  homes: readonly AgentHome[],
  dataDir: string,
): Promise<StorageAgent[]> =>
  Promise.all(
    homes.map(async ({ agent, name, home }): Promise<StorageAgent> => {
      const found = await homeState(home, dataDir);
      if (found.state !== "managed")
        return { agent, name, managed: found.state === "missing", items: [] };
      const [caches, history] = await Promise.all([
        itemsOf(found.real, CACHE_LEAVES, "cache"),
        itemsOf(found.real, HISTORY_LEAVES, "history"),
      ]);
      return { agent, name, managed: true, items: [...caches, ...history] };
    }),
  );

export type CleanResult =
  | { cleaned: true; freedBytes: number }
  | {
      cleaned: false;
      problem: "unmanaged" | "unknown_agent" | "busy" | "failed";
      message: string;
    };

/**
 * Removes the cache folders of one agent's home, and nothing else. `busy` is asked again before each folder: a turn
 * that starts while this runs is not given a cache that is being taken away (the folders already gone stay gone).
 */
export const cleanStorage = async (
  homes: readonly AgentHome[],
  dataDir: string,
  agent: string,
  busy: () => boolean = () => false,
): Promise<CleanResult> => {
  const target = homes.find((h) => h.agent === agent);
  if (target === undefined)
    return { cleaned: false, problem: "unknown_agent", message: `No agent named ${agent}.` };
  const found = await homeState(target.home, dataDir);
  if (found.state === "unmanaged")
    return {
      cleaned: false,
      problem: "unmanaged",
      message: `${target.name}'s home is not inside Cycle's data folder, so nothing in it is cleared.`,
    };
  if (found.state === "missing") return { cleaned: true, freedBytes: 0 };
  let freedBytes = 0;
  let removed = 0;
  let failed = 0;
  for (const leaf of CACHE_LEAVES) {
    const path = await leafPath(found.real, leaf.path);
    if (path === undefined) continue;
    if (busy())
      return {
        cleaned: false,
        problem: "busy",
        message: "A session of this agent started working. Clean up when it has finished.",
      };
    const bytes = await sizeOf(path);
    try {
      await rm(path, { recursive: true, force: true });
      freedBytes += bytes ?? 0;
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  if (failed > 0 && removed === 0)
    return {
      cleaned: false,
      problem: "failed",
      message: `${target.name}'s caches could not be removed. Check the folder's permissions.`,
    };
  return { cleaned: true, freedBytes };
};
