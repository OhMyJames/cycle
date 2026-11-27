// What the engine does about a person's moves on the board (CYC-499): a work item moved out of Todo or In Progress
// stops the run where it is, and one put back goes on only when nothing unfinished blocks it.

import type { RunRecord } from "../store.ts";
import type { Issue } from "../types.ts";
import type { Deps, Flow, Save } from "./flow.ts";

/**
 * A person put a blocked run back: it goes on only when nothing unfinished blocks the work item, as for a new one
 * (`pickNext`). Blockers that are unknown keep it waiting. One `resume_waiting_blockers` event per blocker set.
 */
export const waitingForBlockers = async (
  { config, store }: Deps,
  run: RunRecord,
  issue: Issue,
): Promise<boolean> => {
  const columns = issue.blockerColumnIds;
  const open = (c: number) => c !== config.columns.done && c !== config.columns.canceled;
  if (columns !== null && !columns.some(open)) return false;
  const keys = (issue.links ?? [])
    .filter((l) => l.kind === "blocks" && l.direction === "inward")
    .map((l) => l.key);
  const set = (keys.length > 0 ? keys : (columns ?? []).map(String)).sort().join(",");
  const last = (await store.events()).filter(
    (e) => e.run === run.key && e.kind === "resume_waiting_blockers",
  );
  if (last.at(-1)?.blockers !== set)
    await store.event(run.key, "resume_waiting_blockers", { blockers: set });
  return true;
};

/**
 * Before a phase: has a person moved the work item out of Todo or In Progress (or taken `auto` off)? Then the run
 * stops in the phase it was about to begin and this is true. Nothing is written to the tracker, no comment and no
 * move: the person's move stands. Put back in Todo, the run goes on from this phase.
 */
export const stopIfMoved = async (
  { store }: Deps,
  flow: Flow,
  run: RunRecord,
  save: Save,
): Promise<boolean> => {
  if (run.phase === "blocked" || run.phase === "done") return false;
  const mine = await flow.stillMine(run);
  if (mine === true) return false;
  await save({
    phase: "blocked",
    resumeFrom: run.phase,
    blockedReason: "人把工单移出了 Todo/In Progress",
  });
  await store.event(run.key, "stopped_by_person", { stateType: mine.stateType });
  return true;
};
