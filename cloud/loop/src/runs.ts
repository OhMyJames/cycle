import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LoopProjectRuns, LoopRun } from "@cycle/protocol";
import type { Config } from "./config.ts";
import { RunStore } from "./store.ts";

const stateOf = (phase: string): LoopRun["state"] =>
  phase === "done" ? "done" : phase === "blocked" ? "blocked" : "active";

/** One Project's runs. Each record is read on its own: a bad one is skipped and marks the list `unavailable`. */
const projectRuns = async (
  projectKey: string,
  stateDir: string | undefined,
): Promise<LoopProjectRuns> => {
  if (stateDir === undefined) return { projectKey, runs: [], unavailable: false };
  let names: string[];
  try {
    names = await readdir(join(stateDir, "runs"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT")
      return { projectKey, runs: [], unavailable: false };
    console.error(`loop: runs_unreadable project=${projectKey}`);
    return { projectKey, runs: [], unavailable: true };
  }
  const store = new RunStore(stateDir, () => new Date());
  let unavailable = false;
  const loaded = await Promise.all(
    names.map((name) =>
      store.load(name).catch(() => {
        unavailable = true;
        return undefined;
      }),
    ),
  );
  if (unavailable) console.error(`loop: run_unreadable project=${projectKey}`);
  const runs: LoopRun[] = [];
  for (const r of loaded)
    if (r !== undefined)
      runs.push({
        key: r.key,
        kind: r.kind,
        state: stateOf(r.phase),
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
      });
  runs.sort((a, b) => a.key.localeCompare(b.key));
  return { projectKey, runs, unavailable };
};

/**
 * What a client may see of each Project's runs, read from `run.json`. Built field by field: no title, worktree,
 * branch, session or PR address leaves the server. Log lines carry a fixed reason and the Project key, never a path.
 */
export const runsList = async (config: Config): Promise<{ projects: LoopProjectRuns[] }> => ({
  projects: await Promise.all(config.projects.map((p) => projectRuns(p.projectKey, p.stateDir))),
});
