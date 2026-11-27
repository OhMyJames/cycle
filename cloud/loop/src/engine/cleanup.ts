// Cleanup of worktrees, local branches, and per-run temporary HOMEs for Done, Canceled, and stale Blocked runs
// (CYC-379, CYC-449, CYC-473). Extracted from `engine.ts` to keep the core engine concise and under the 600-line cap.

import { rm } from "node:fs/promises";
import { runHomeDir } from "../env.ts";
import type { PlanFlow } from "../flows/plan.ts";
import { applyPatch, type RunRecord } from "../store.ts";
import { branchOf, type Deps, type Flow, type RunKind } from "./flow.ts";

export async function runCleanup(input: {
  deps: Deps;
  flows: Record<RunKind, Flow>;
  plan: PlanFlow;
  active: ReadonlySet<string>;
}): Promise<void> {
  const { deps, flows, plan, active } = input;
  const { config, store, log } = deps;
  if (config.planning !== null) {
    try {
      await plan.cleanup(active);
    } catch (error) {
      log(
        `cleanup of planning worktrees failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const run of await store.all()) {
    if (run.cleanedAt !== null || run.worktree === null) continue;
    if (run.phase !== "done" && run.phase !== "blocked") continue;
    if (active.has(run.key)) continue;
    try {
      await cleanupOne(deps, flows[run.kind], run, run.worktree);
    } catch (error) {
      log(
        `cleanup of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function cleanupOne(deps: Deps, flow: Flow, run: RunRecord, worktree: string): Promise<void> {
  const { config, tracker, store } = deps;
  const note = async (kind: string, data: Record<string, string | number | boolean> = {}) => {
    if (run.cleanupNote === kind) return;
    await store.event(run.key, kind, data);
    await store.save({ ...run, cleanupNote: kind });
  };
  const own = `/${branchOf(run.issueNumber)}`;
  if (!worktree.replace(/\/+$/, "").endsWith(own)) return;

  const issue = await tracker.get(run.issueNumber);
  if (issue.columnId === config.columns.canceled)
    return removeWorktree(deps, flow, run, worktree, note);

  if (run.phase === "blocked") {
    const days = config.blockedReminderDays;
    if (days <= 0) return;
    const since = Date.parse(run.updatedAt);
    const waited = Math.floor((deps.clock.now().getTime() - since) / 86_400_000);
    if (Number.isNaN(since) || waited < days) return;
    return note("blocked_stale", { days: waited });
  }

  if (issue.columnId !== config.columns.done) return;
  const done = await flow.whenDone(run);
  if (done === "keep") return;
  if (done !== "remove") return note(done.note);
  return removeWorktree(deps, flow, run, worktree, note);
}

async function removeWorktree(
  deps: Deps,
  flow: Flow,
  run: RunRecord,
  worktree: string,
  note: (kind: string) => Promise<void>,
): Promise<void> {
  const { config, store, clock, workspace } = deps;
  const branches = [...new Set([run.localBranch, branchOf(run.issueNumber)])].filter(
    (b): b is string => b !== null,
  );
  const removal = await workspace.remove(
    { cwd: config.repoRoot, timeoutMs: config.commandTimeoutMs },
    worktree,
    branches,
  );
  if (removal === "failed") return note("cleanup_failed");
  if (removal === "dirty") return note("cleanup_skipped_dirty");
  await rm(runHomeDir(config.stateDir, run.key), { recursive: true, force: true });
  await store.event(run.key, "cleaned");
  if (run.phase !== "done") {
    await store.save(
      applyPatch(run, {
        worktree: null,
        localBranch: null,
        devSessionId: null,
        qaSessionId: null,
        findings: null,
        resumeFrom: "claimed",
        cleanedAt: null,
        cleanupNote: null,
        ...flow.afterRemoved?.(),
      }),
    );
    return;
  }
  await store.save({ ...run, cleanedAt: clock.now().toISOString(), cleanupNote: null });
}
