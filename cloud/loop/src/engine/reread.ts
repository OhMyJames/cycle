import type { CriteriaBook } from "../criteria.ts";
import type { RunRecord } from "../store.ts";
import type { Issue } from "../types.ts";
import type { Deps, Flow } from "./flow.ts";
import { writeIntent } from "./reconcile.ts";

/**
 * A person put a blocked run back. The flow reads the work item again (CYC-467, `Flow.reread`): a changed body gives
 * new criteria, saved with the run, and a note for Dev's next turn; one that no longer passes the preflight is sent
 * back (`rejected`). Then the budget of fix rounds starts again, from where it stopped (the flow resets its own), the
 * work item goes to In Progress, and `resumed` is written.
 */
export const putBackRun = async (
  d: Deps,
  flow: Flow,
  run: RunRecord,
  issue: Issue,
  book: CriteriaBook,
  flush: () => Promise<void>,
): Promise<{ run: RunRecord; book: CriteriaBook } | { rejected: string[] }> => {
  const again = await flow.reread?.(run, issue);
  if (again !== undefined && "rejected" in again) return again;
  const current = again?.run ?? run;
  const criteria = again?.book ?? book;
  const putBack = await flow.putBack({
    ...current,
    phase: current.resumeFrom ?? flow.firstPhase,
    round: 0,
    blockedReason: null,
    resumeFrom: null,
    cleanupNote: null,
  });
  const saved = d.store.transaction((tx) => {
    const saved = tx.save(putBack);
    tx.saveCriteria(run.key, criteria);
    writeIntent(tx, {
      run: run.key,
      issue,
      kind: "move",
      dedupe: `move:${run.key}:resumed:${tx.countEvents(run.key, "resumed") + 1}`,
      payload: { to: "inProgress", from: "todo" },
    });
    tx.event(run.key, "resumed", { phase: saved.phase });
    return saved;
  });
  await flush();
  return { run: saved, book: criteria };
};
