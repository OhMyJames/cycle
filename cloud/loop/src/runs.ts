import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type LoopProjectRuns, type LoopRun, LoopRunSchema } from "@cycle/protocol";
import type { Config } from "./config.ts";
import { RunStore } from "./store.ts";

/** Where a Project's runs are kept (`<dir>/runs/<KEY>/run.json`). Supplied by whoever starts the server (CYC-455). */
export type StateDirOf = (projectKey: string) => string | undefined;

const stateOf = (phase: string): LoopRun["state"] =>
  phase === "done" ? "done" : phase === "blocked" ? "blocked" : "active";

/** A fixed reason and the Project key; never a path or anything from the record. */
const warn = (reason: string, projectKey: string): void =>
  console.error(`loop: ${reason} project=${projectKey}`);

const projectRuns = async (
  projectKey: string,
  stateDir: string | undefined,
): Promise<LoopProjectRuns> => {
  if (stateDir === undefined) {
    warn("state_dir_unknown", projectKey);
    throw new Error("state_dir_unknown");
  }
  let names: string[];
  try {
    names = (await readdir(join(stateDir, "runs"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      // A state directory with no `runs/` yet has no runs; one that is not there is a wrong setting.
      const missing = await readdir(stateDir).then(
        () => false,
        () => true,
      );
      if (!missing) return { projectKey, runs: [] };
      warn("state_dir_missing", projectKey);
      throw new Error("state_dir_missing");
    }
    warn("runs_unreadable", projectKey);
    throw new Error("runs_unreadable");
  }
  const store = new RunStore(stateDir, () => new Date());
  const loaded = await Promise.all(
    names.map(async (name) => {
      try {
        const r = await store.load(name);
        if (r === undefined || r.key !== name) return undefined;
        return LoopRunSchema.parse({
          key: r.key,
          kind: r.kind === "design" ? "research" : r.kind,
          state: stateOf(r.phase),
          startedAt: r.startedAt,
          updatedAt: r.updatedAt,
        });
      } catch {
        warn("run_unreadable", projectKey);
        return undefined;
      }
    }),
  );
  const runs = loaded.filter((r): r is LoopRun => r !== undefined);
  runs.sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  return { projectKey, runs };
};

/**
 * What a client may see of each Project's runs, read from `run.json`. Built field by field: no title, worktree,
 * branch, session or PR address leaves the server. A Project whose state directory is unknown, missing or unreadable
 * fails the whole call rather than answering an empty list.
 */
export const runsList = async (
  config: Config,
  stateDirOf: StateDirOf,
): Promise<{ projects: LoopProjectRuns[] }> => ({
  projects: await Promise.all(
    config.projects.map((p) => projectRuns(p.projectKey, stateDirOf(p.projectKey))),
  ),
});
