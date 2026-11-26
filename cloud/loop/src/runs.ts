import type { LoopProjectRuns, LoopRun } from "@cycle/protocol";
import type { Config } from "./config.ts";
import { RunStore } from "./store.ts";

/**
 * What a client may see of each Project's runs, read from `run.json`. Built field by field: no title, worktree,
 * branch, session or PR address leaves the server. A Project with no `stateDir` or no runs gets an empty list; a
 * Project whose runs cannot be read does too, rather than an error that could carry a path.
 */
export const runsList = async (config: Config): Promise<{ projects: LoopProjectRuns[] }> => ({
  projects: await Promise.all(
    config.projects.map(async (p) => {
      if (p.stateDir === undefined) return { projectKey: p.projectKey, runs: [] };
      const records = await new RunStore(p.stateDir, () => new Date()).all().catch(() => []);
      const runs: LoopRun[] = records
        .map((r) => ({
          key: r.key,
          kind: r.kind,
          state:
            r.phase === "done"
              ? ("done" as const)
              : r.phase === "blocked"
                ? ("blocked" as const)
                : ("active" as const),
          startedAt: r.startedAt,
          updatedAt: r.updatedAt,
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { projectKey: p.projectKey, runs };
    }),
  ),
});
