// What the flows of one work item in the tracker share: dev and research runs both come from the `Todo` column, go
// on when a person puts them back, and stop in Blocked with a comment.

import {
  type BlockArgs,
  type FlowHost,
  type Intake,
  PHASE_NAMES,
  type Phase,
} from "../engine/flow.ts";
import { writeIntent } from "../engine/reconcile.ts";
import { fullFlowPreflight, isFullFlow } from "../full-flow.ts";
import { preflight, sendBackComment } from "../preflight.ts";
import { pickNext } from "../select.ts";
import { applyPatch, type RunRecord } from "../store.ts";
import type { Issue } from "../types.ts";

/**
 * The `Todo` column: the next work item `pickNext` chooses, checked by `preflight`, which also says its kind. One
 * intake for dev and research both, so the choice between them is by priority and age, not by kind.
 */
export const todoIntake = (host: FlowHost): Intake => ({
  async want(held) {
    const { config, tracker } = host.d;
    const todo = await tracker.listTodo();
    const issue = pickNext(
      todo.filter((i) => !held.has(i.key)),
      config,
    );
    if (issue === undefined) {
      const labeled = todo.filter((i) => i.labelIds.includes(config.autoLabelId));
      const rightType = labeled.filter(
        (i) => i.typeId !== null && config.allowedTypeIds.includes(i.typeId),
      );
      const leaves = rightType.filter((i) => i.subtaskCount === 0);
      return {
        idle: `dry run: ${todo.length} in Todo, ${labeled.length} with auto, ${rightType.length} allowed type, ${leaves.length} leaf`,
      };
    }
    if (isFullFlow(issue, config)) {
      const full = await fullFlowPreflight(issue, config, tracker);
      if (!full.ok) return { reject: issue, reasons: full.reasons };
      return {
        take: issue,
        accepted: { ok: true, kind: "dev", specs: full.specs, docs: full.docs },
      };
    }
    const pre = preflight(issue, config);
    if (!pre.ok) return { reject: issue, reasons: pre.reasons };
    return { take: issue, accepted: pre };
  },

  async reject(issue, reasons) {
    const { store } = host.d;
    const body = sendBackComment(reasons);
    const why = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 12);
    store.transaction((tx) => {
      const seq = tx.countEvents(issue.key, "preflight_rejected") + 1;
      // One comment for one reason, however many rounds or re-queues see it (on purpose: a person who puts the
      // work item back unfixed has already read it); the move is written each time, and does nothing
      // when the work item is already in Blocked.
      writeIntent(tx, {
        run: issue.key,
        issue,
        kind: "comment",
        dedupe: `rejected:${issue.key}:${why}`,
        payload: { body },
      });
      // Not while a move to Blocked is still waiting: a tracker that is down must not collect one per round.
      const waiting = tx.pendingIntents().some((i) => i.kind === "move" && i.runKey === issue.key);
      if (!waiting)
        writeIntent(tx, {
          run: issue.key,
          issue,
          kind: "move",
          dedupe: `move:${issue.key}:rejected:${seq}`,
          payload: { to: "blocked" },
        });
      tx.event(issue.key, "preflight_rejected", { reasons: reasons.length });
    });
    await host.reconcile.flush(issue.id, { capMs: host.d.mirrorCapMs ?? 10_000 });
  },
});

/** Unfinished goes on; blocked only once a person has put the work item back in `Todo` with the `auto` label. */
export const ticketStillWanted = async (
  host: FlowHost,
  run: RunRecord,
): Promise<{ issue: Issue; byPerson: boolean } | undefined> => {
  const { config, tracker } = host.d;
  const issue = await tracker.get(run.issueNumber);
  const putBack =
    issue.columnId === config.columns.todo && issue.labelIds.includes(config.autoLabelId);
  if (run.phase === "blocked" && !putBack) return undefined;
  // Not blocked and not done: the loop that was on it is gone (no step holds it).
  return { issue, byPerson: run.phase === "blocked" };
};

/**
 * Blocked: the reason in a comment on the work item, which says which session to open, and the work item in Blocked.
 * `redact` turns what was said into what may be written there.
 */
export const blockTicket = async (
  host: FlowHost,
  { run, issue, said, resumeFrom, asked }: BlockArgs,
  how: { firstPhase: Phase; session: string; redact: (said: string) => string },
) => {
  const { store } = host.d;
  const reason = how.redact(said);
  const from = run.phase === "blocked" || run.phase === "done" ? how.firstPhase : run.phase;
  const body =
    asked?.comment ??
    `自动化在「${PHASE_NAMES[from]}」卡住了：${reason}\n\n现场已保留：${how.session}可在 Cycle 桌面端打开接管。处理后把工单放回 Todo，自动化会在原会话里继续。`;
  // The run and what the tracker should show are written together; the reconciler brings the tracker to it, now or on
  // a later step. `blockSeq` is which Blocked this is for the run: one comment each, the next Blocked comments again.
  store.transaction((tx) => {
    const blockSeq = tx.countEvents(run.key, "blocked") + 1;
    tx.save(
      applyPatch(run, { phase: "blocked", blockedReason: reason, resumeFrom: resumeFrom ?? from }),
    );
    writeIntent(tx, {
      run: run.key,
      issue,
      kind: "comment",
      dedupe: `blocked:${run.key}:${blockSeq}`,
      payload: { body },
    });
    writeIntent(tx, {
      run: run.key,
      issue,
      kind: "move",
      dedupe: `move:${run.key}:${blockSeq}`,
      payload: { to: "blocked" },
    });
    tx.event(run.key, "blocked", { phase: from, round: run.round });
    if (asked !== undefined)
      tx.notice(run.key, "blocked", asked.notice, `blocked:${run.key}:${blockSeq}`, asked.session);
  });
  await host.reconcile.flush(issue.id, { capMs: host.d.mirrorCapMs ?? 10_000 });
  return { status: "blocked" as const, key: run.key, reason };
};
