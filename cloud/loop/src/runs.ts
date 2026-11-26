import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type LoopProjectRuns, type LoopRun, LoopRunSchema } from "@cycle/protocol";
import type { Config } from "./config.ts";
import { RunStore } from "./store.ts";

const stateOf = (phase: string): LoopRun["state"] =>
  phase === "done" ? "done" : phase === "blocked" ? "blocked" : "active";

const BATCH = 16;

/** Projects whose last read was unavailable: a line is logged when this changes, not on every poll. */
const lastUnavailable = new Map<string, boolean>();
const note = (projectKey: string, unavailable: boolean, reason: string): void => {
  if ((lastUnavailable.get(projectKey) ?? false) === unavailable) return;
  lastUnavailable.set(projectKey, unavailable);
  if (unavailable) console.error(`loop: ${reason} project=${projectKey}`);
};

/** The directories under `runs/`; a symlink counts if it leads to one. `bad` is set for one that cannot be followed. */
const runDirs = async (stateDir: string): Promise<{ names: string[]; bad: boolean }> => {
  const entries = await readdir(join(stateDir, "runs"), { withFileTypes: true });
  const names: string[] = [];
  let bad = false;
  for (const entry of entries) {
    if (entry.isDirectory()) names.push(entry.name);
    else if (entry.isSymbolicLink()) {
      const target = await stat(join(stateDir, "runs", entry.name)).catch(() => undefined);
      if (target === undefined) bad = true;
      else if (target.isDirectory()) names.push(entry.name);
    }
  }
  return { names, bad };
};

/** One Project's runs. Each record is read on its own: a bad one is skipped and marks the list `unavailable`. */
const projectRuns = async (
  projectKey: string,
  stateDir: string | undefined,
): Promise<LoopProjectRuns> => {
  if (stateDir === undefined) return { projectKey, runs: [], unavailable: false };
  let dirs: { names: string[]; bad: boolean };
  try {
    dirs = await runDirs(stateDir);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      note(projectKey, false, "");
      return { projectKey, runs: [], unavailable: false };
    }
    note(projectKey, true, "runs_unreadable");
    return { projectKey, runs: [], unavailable: true };
  }
  const store = new RunStore(stateDir, () => new Date());
  let unavailable = dirs.bad;
  const runs: LoopRun[] = [];
  for (let i = 0; i < dirs.names.length; i += BATCH) {
    const batch = dirs.names.slice(i, i + BATCH);
    const loaded = await Promise.all(
      batch.map(async (name) => {
        try {
          // `load` answers undefined only for a directory with no run.json: not a run.
          const r = await store.load(name);
          if (r === undefined) return undefined;
          const run = LoopRunSchema.safeParse({
            key: r.key,
            kind: r.kind,
            state: stateOf(r.phase),
            startedAt: r.startedAt,
            updatedAt: r.updatedAt,
          });
          // A record under another key is a copy of a directory.
          if (run.success && r.key === name) return run.data;
        } catch {}
        unavailable = true;
        return undefined;
      }),
    );
    for (const run of loaded) if (run !== undefined) runs.push(run);
  }
  note(projectKey, unavailable, "run_unreadable");
  runs.sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  return { projectKey, runs, unavailable };
};

/**
 * What a client may see of each Project's runs, read from `run.json`. Built field by field: no title, worktree,
 * branch, session or PR address leaves the server. Log lines carry a fixed reason and the Project key, never a path.
 */
export const runsList = async (config: Config): Promise<{ projects: LoopProjectRuns[] }> => ({
  projects: await Promise.all(config.projects.map((p) => projectRuns(p.projectKey, p.stateDir))),
});
