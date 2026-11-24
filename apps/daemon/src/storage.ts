// What an agent keeps in the home the daemon gives it: how much, and clearing the part that can be fetched again.
// Only the names in CACHE_LEAVES are ever removed. Never a home as a whole, never a login, a plugin, a session's
// history or anything an agent wrote for the owner (docs/protocol.md §16 "本地存储").
import { lstat, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import type { StorageAgent, StorageItem } from "@cycle/protocol";
import type { Config } from "./config.ts";
import type { Harness } from "./harness.ts";

/** An agent's home as the daemon gives it (its `HOME`), by agent. */
export type AgentHome = { agent: string; name: string; home: string };

/** Each home that is made for an agent: what the harness's own environment says its `HOME` is, `config.json` overrides included. */
export const agentHomesOf = (
  harnesses: readonly Harness[],
  config: Config,
  dataDir: string,
  inherited: Record<string, string | undefined>,
): AgentHome[] =>
  harnesses.flatMap((harness) => {
    const home = harness.cli?.env({ config, dataDir, inherited }).HOME;
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

/** The size on disk of one folder, in bytes, without following a link; 0 for none. `du` walks it without holding up the daemon. */
export const sizeOf = async (path: string, signal?: AbortSignal): Promise<number> => {
  const du = Bun.spawn(["du", "-skP", "--", path], {
    stdout: "pipe",
    stderr: "ignore",
    ...(signal !== undefined ? { signal } : {}),
  });
  const out = await new Response(du.stdout).text();
  await du.exited;
  const kilobytes = Number.parseInt(out, 10);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
};

/** The real path of `home` when it is inside `dataDir` (never `dataDir` itself); undefined when it is not, or is not there. */
const managedHome = async (home: string, dataDir: string): Promise<string | undefined> => {
  try {
    const [real, root] = await Promise.all([realpath(home), realpath(dataDir)]);
    return real.startsWith(root + sep) ? real : undefined;
  } catch {
    return undefined;
  }
};

/** A leaf that is a real folder inside the home: not absent, not a link, and no link on the way to it. */
const leafPath = async (home: string, path: readonly string[]): Promise<string | undefined> => {
  const full = join(home, ...path);
  try {
    if ((await lstat(full)).isSymbolicLink()) return undefined;
    const real = await realpath(full);
    return real === full || real.startsWith(home + sep) ? full : undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
};

const itemsOf = async (
  home: string,
  leaves: typeof CACHE_LEAVES,
  kind: StorageItem["kind"],
  signal: AbortSignal,
): Promise<StorageItem[]> => {
  const found = await Promise.all(
    leaves.map(async (leaf) => {
      const path = await leafPath(home, leaf.path);
      if (path === undefined) return undefined;
      return { id: leaf.id, kind, bytes: await sizeOf(path, signal) };
    }),
  );
  return found.filter((item): item is StorageItem => item !== undefined);
};

/** How much each agent keeps in its home, for the ones whose home is the daemon's to look after. */
export const readStorage = async (
  homes: readonly AgentHome[],
  dataDir: string,
): Promise<StorageAgent[]> => {
  const signal = AbortSignal.timeout(60_000);
  return Promise.all(
    homes.map(async ({ agent, name, home }): Promise<StorageAgent> => {
      const real = await managedHome(home, dataDir);
      if (real === undefined) {
        // Outside the data directory, or not made yet. Only the first is the owner's own folder.
        const unmanaged = await realpath(home).then(
          () => true,
          () => false,
        );
        return { agent, name, managed: !unmanaged, items: [] };
      }
      const [caches, history] = await Promise.all([
        itemsOf(real, CACHE_LEAVES, "cache", signal),
        itemsOf(real, HISTORY_LEAVES, "history", signal),
      ]);
      return { agent, name, managed: true, items: [...caches, ...history] };
    }),
  );
};

export type CleanResult =
  | { cleaned: true; freedBytes: number }
  | { cleaned: false; problem: "unmanaged" | "unknown_agent"; message: string };

/** Removes the cache folders of one agent's home, and nothing else. The caller has checked that no turn of it is running. */
export const cleanStorage = async (
  homes: readonly AgentHome[],
  dataDir: string,
  agent: string,
): Promise<CleanResult> => {
  const target = homes.find((h) => h.agent === agent);
  if (target === undefined)
    return { cleaned: false, problem: "unknown_agent", message: `No agent named ${agent}.` };
  const real = await managedHome(target.home, dataDir);
  if (real === undefined)
    return {
      cleaned: false,
      problem: "unmanaged",
      message: `${target.name}'s home is not inside Cycle's data folder, so nothing in it is cleared.`,
    };
  const signal = AbortSignal.timeout(60_000);
  let freedBytes = 0;
  for (const leaf of CACHE_LEAVES) {
    const path = await leafPath(real, leaf.path);
    if (path === undefined) continue;
    freedBytes += await sizeOf(path, signal);
    await rm(path, { recursive: true, force: true });
  }
  return { cleaned: true, freedBytes };
};
