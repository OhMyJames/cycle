import type { CriteriaBook } from "../../criteria.ts";
import { branchOf } from "../../engine/flow.ts";
import {
  conflictBrief,
  continueBrief,
  devBrief,
  fixBrief,
  handoffBrief,
  parseProgress,
} from "../../prompts/index.ts";
import { type Issue, SessionLost, type TurnResult } from "../../types.ts";
import { conflictScene, judgeConflict, theirCommits } from "./conflict.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { docTexts } from "./docs.ts";
import { restoreNodeModules } from "./node-modules.ts";

export async function dev(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  book: CriteriaBook,
  byPerson: boolean,
  save: Save,
): Promise<void> {
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
  const prompt =
    conflictPrompt ??
    (run.findings !== null
      ? fixBrief(run.round, run.findings)
      : progress !== "" || byPerson
        ? continueBrief(issue, byPerson)
        : devBrief(issue, book.items, await docTexts(h, run, issue, ["Design", "Plan"])));

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
      conflictPrompt ??
        handoffBrief(
          issue,
          book.items,
          progress,
          gitLog,
          run.findings,
          await docTexts(h, run, issue, ["Design", "Plan"]),
        ),
      { role: "dev", worktree, timeoutMs: config.turnTimeoutMs },
    );
  }
  await store.event(run.key, "dev_turn", { round: run.round, stop: result.stopReason });
  h.mustHaveEnded("Dev", result);

  await store.appendProgress(
    run.key,
    run.round,
    parseProgress(result.text) ?? "(the turn ended with no progress block)",
  );
  // Decide first: the checkpoint below would commit conflict markers along with everything else.
  if (conflict !== undefined) await judgeConflict(h, run, conflict, worktree, save);
  // What is on disk is the checkpoint. Work Dev left uncommitted is committed here, so it is not lost.
  await h.d.workspace.checkpoint(where(h, worktree), `${run.key}: checkpoint (auto-loop)`);
  await save({ phase: "verify", findings: null });
}
