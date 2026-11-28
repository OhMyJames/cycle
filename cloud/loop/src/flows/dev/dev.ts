import type { CriteriaBook } from "../../criteria.ts";
import { Blocked, branchOf } from "../../engine/flow.ts";
import {
  bodyChangedNotice,
  conflictBrief,
  continueBrief,
  devBrief,
  fixBrief,
  handoffBrief,
  parseProgress,
  parseQuestion,
} from "../../prompts/index.ts";
import { type Issue, SessionLost, type TurnResult } from "../../types.ts";
import { conflictScene, judgeConflict, theirCommits } from "./conflict.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { docTexts } from "./docs.ts";
import { nodeDev } from "./graph.ts";
import { restoreNodeModules } from "./node-modules.ts";

export async function dev(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  book: CriteriaBook,
  byPerson: boolean,
  save: Save,
): Promise<void> {
  // CYC-508: Level-2 Task Graph node execution uses its own fresh session per node; conflict resolution stays branch-wide.
  if (run.dev.conflict?.state !== "dev" && run.dev.activeNodeId != null) {
    await nodeDev(h, run, issue, book, byPerson, save);
    return;
  }
  const { config, store } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  // Released while waiting for CI or the merge: installed again before the session starts.
  // Not in the middle of a conflict merge: an install could fail on a conflicted manifest or rewrite bun.lock.
  // The restore in #verify installs once the merge is resolved.
  if (run.dev.conflict?.state !== "dev") await restoreNodeModules(h, run, worktree, save);
  const progress = await store.readProgress(run.key);
  // A conflict turn: the merge of the base is in the worktree (made again if it is not), and Dev is asked to finish it.
  let conflict: { files: string[]; preMergeSha: string } | undefined;
  if (run.dev.conflict?.state === "dev") {
    const found = await conflictScene(h, run, worktree, save);
    if (found === undefined) return;
    conflict = found;
  }
  const conflictPrompt =
    conflict === undefined
      ? undefined
      : conflictBrief(
          issue,
          config.baseRef,
          conflict.files,
          await theirCommits(h, worktree, conflict.preMergeSha, conflict.files),
        ) +
        (run.dev.nodeModulesReleased
          ? "\n\nDependencies are not installed in this worktree (node_modules was removed while waiting for CI). Resolve package.json and bun.lock first if they are conflicted, then run `bun install` before `bun run check`.\n"
          : "");
  // CYC-467: the body changed while the run was blocked: the turn begins by saying so, whatever phase it resumed in.
  const notice = run.dev.bodyChanged === true ? bodyChangedNotice(issue, book.items) : "";
  const prompt =
    notice +
    (conflictPrompt ??
      (run.findings !== null
        ? fixBrief(run.round, run.findings)
        : progress !== "" || byPerson
          ? continueBrief(issue, byPerson)
          : devBrief(issue, book.items, await docTexts(h, run, issue, ["Design", "Plan"]))));

  let sessionId = h.need(run.devSessionId ?? undefined);
  let result: TurnResult;
  try {
    result = await h.turn(run.key, sessionId, prompt, {
      role: "dev",
      worktree,
      timeoutMs: config.turnTimeoutMs,
    });
  } catch (error) {
    if (!(error instanceof SessionLost)) throw error;
    // It cannot be continued: a new one takes over from what is on disk, not from a replay of the log.
    const gitLog = await h.d.workspace.log(where(h, worktree), config.baseRef);
    const created = await h.d.sessions.create({
      role: "dev",
      run: run.key,
      agent: config.devAgent,
      ...(config.devModel ? { model: config.devModel } : {}),
      ...(config.devEffort ? { effort: config.devEffort } : {}),
      title: `[${run.key}] Dev`,
      // The same name again is the worktree that is there: the daemon reuses it, and files the session under it.
      cwd: config.repoRoot,
      worktree: { base: config.baseRef, name: branchOf(issue.number) },
    });
    await save({
      devSessionId: created.sessionId,
      replacedSessions: [...run.replacedSessions, sessionId],
    });
    sessionId = created.sessionId;
    await store.event(run.key, "dev_session", { replaced: true });
    result = await h.turn(
      run.key,
      sessionId,
      notice +
        (conflictPrompt ??
          handoffBrief(
            issue,
            book.items,
            progress,
            gitLog,
            run.findings,
            await docTexts(h, run, issue, ["Design", "Plan"]),
          )),
      { role: "dev", worktree, timeoutMs: config.turnTimeoutMs },
    );
  }
  if (run.dev.bodyChanged === true) await save({ dev: { bodyChanged: false } });
  await store.event(run.key, "dev_turn", { round: run.round, stop: result.stopReason });
  h.mustHaveEnded("Dev", result);

  await store.appendProgress(
    run.key,
    run.round,
    parseProgress(result.text) ?? "(the turn ended with no progress block)",
  );
  // A question for a person: not checked, not a round. What is on disk is kept (not in a conflict: the checkpoint
  // would commit its markers, and putting the run back backs the merge out).
  const question = parseQuestion(result.text);
  if (question !== undefined) {
    if (conflict === undefined)
      await h.d.workspace.checkpoint(where(h, worktree), `${run.key}: checkpoint (auto-loop)`);
    await store.event(run.key, "dev_asked", { chars: question.length });
    // Asked in a fix round: the answer is for the work, not for the findings, which the session still has.
    await save({ findings: null });
    const events = await store.events();
    let asks = 0;
    for (const e of events) {
      if (e.run !== run.key) continue;
      if (e.kind === "dev_asked") asks++;
      else if (e.kind === "verify" && e.passed === e.criteria) asks = 0;
    }
    throw new Blocked("等人决定", undefined, {
      comment: `Loop 的 Dev 会话需要你决定：\n\n${question}\n\n${asks >= 3 ? "已多次提问，建议重写工单。\n\n" : ""}回答写在评论里，然后把工单放回 Todo`,
      notice: `Dev 会话需要人决定：${question}`,
      session: { kind: "dev", id: sessionId },
    });
  }
  // Decide first: the checkpoint below would commit conflict markers along with everything else.
  if (conflict !== undefined) await judgeConflict(h, run, conflict, worktree, save);
  // What is on disk is the checkpoint. Work Dev left uncommitted is committed here, so it is not lost.
  await h.d.workspace.checkpoint(where(h, worktree), `${run.key}: checkpoint (auto-loop)`);
  await save({ phase: "verify", findings: null });
}
