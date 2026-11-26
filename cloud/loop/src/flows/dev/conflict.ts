import { Blocked, tail } from "../../engine/flow.ts";
import type { Done } from "../../ports/workspace.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";

/**
 * The PR conflicts with the base while CI is awaited: merge the base into the branch here, once. A clean merge goes on
 * through verify, QA, push and CI; a real conflict is handed to the Dev session, and judged from the repository after its turn. Out of attempts, it blocks as before.
 */
export async function handleConflict(
  h: FlowHost,
  run: DevRun,
  prUrl: string,
  worktree: string,
  save: Save,
): Promise<void> {
  const { config } = h.d;
  // Before anything else: pushing to a PR with auto-merge on does not turn it off (we have write access), so it would
  // merge on green CI without the new commits being reviewed again. Read it every time; an unreadable state blocks.
  const auto = await h.d.forge.autoMergeOn(where(h, worktree), prUrl);
  if (!auto.ok) throw new Blocked(`处理冲突前读取自动合并状态失败，不推送：${tail(auto.error)}`);
  if (auto.enabled) {
    const off = await h.d.forge.autoMerge(where(h, worktree), prUrl, false);
    if (!off.ok) throw new Blocked(`处理冲突前关闭自动合并失败，不推送：${tail(off.error)}`);
    await h.d.store.event(run.key, "auto_merge_disabled", { prUrl });
  }
  // A merge the loop started and a restart cut off is continued; it is not a second attempt.
  if (run.dev.conflict === null && run.dev.conflictRound >= config.maxConflictRounds) {
    const files = await conflictFiles(h, worktree);
    await h.d.store.event(run.key, "merge_conflict", { prUrl, files: files.length });
    throw new Blocked(
      `发现 PR 与 ${config.baseBranch} 冲突，已自动处理过 ${run.dev.conflictRound} 次，不再自动合并：${prUrl}。${
        files.length > 0 ? `冲突文件：${files.join("、")}。` : ""
      }需要人把 ${config.baseBranch} 合并进该分支并解决冲突。`,
    );
  }
  await startMerge(h, run, worktree, save);
}

/**
 * Safe to run again at any point: after the count is saved, after a clean merge, or with a merge left open. A clean
 * merge goes on to verify. A real conflict is left in the worktree and handed to the Dev session (phase `dev`).
 * Returns the conflict, or undefined when the merge was clean.
 */
export async function startMerge(
  h: FlowHost,
  run: DevRun,
  worktree: string,
  save: Save,
): Promise<{ files: string[]; preMergeSha: string } | undefined> {
  const { config, store, workspace } = h.d;
  const at = where(h, worktree);
  const open = await workspace.mergeInProgress(at);
  if (!open) {
    const status = await workspace.status(at);
    if (!status.ok) throw new Blocked(`读取工作区状态失败：${tail(status.error)}`);
    if (status.porcelain.trim() !== "")
      throw new Blocked(
        `PR 与 ${config.baseBranch} 冲突，但工作区有未提交的改动，不自动合并：\n${tail(status.porcelain)}`,
      );
    const fetched = await h.netExec(run.key, "git fetch", () => workspace.fetchMain(at));
    if (fetched.code !== 0) throw new Blocked(`合并前 git fetch 失败：${tail(fetched.output)}`);
  }
  // HEAD before the merge, saved with the count: a failed resolution goes back to it.
  let preMergeSha = run.dev.conflict?.preMergeSha;
  if (preMergeSha === undefined) {
    const head = await workspace.head(at);
    if (!head.ok) throw new Blocked(`读取 HEAD 提交失败：${tail(head.error)}`);
    preMergeSha = head.sha;
  }
  // The count is saved before the merge, so a kill in the middle cannot let the same attempt be taken twice.
  if (run.dev.conflict === null)
    await save({
      dev: {
        conflictRound: run.dev.conflictRound + 1,
        conflict: { state: "merging", preMergeSha },
      },
    });
  const attempt = run.dev.conflict === null ? run.dev.conflictRound + 1 : run.dev.conflictRound;
  let merged: Done | undefined;
  if (!open) {
    merged = await workspace.mergeMain(at, config.baseRef);
    if (merged.ok) {
      await store.event(run.key, "conflict_merge", { result: "clean", conflictRound: attempt });
      await save({ phase: "verify", dev: { conflict: null } });
      return undefined;
    }
  }
  // A merge that failed without starting leaves nothing to abort: say what git said.
  const started = await workspace.mergeInProgress(at);
  if (!started) {
    await store.event(run.key, "conflict_merge", { result: "failed", conflictRound: attempt });
    await save({ dev: { conflict: null } });
    throw new Blocked(
      `Loop 合并 ${config.baseRef} 失败，没有开始合并：${tail(mergeOutput(merged))}`,
    );
  }
  const files = await workspace.unmergedFiles(at);
  if (files.length === 0) {
    const aborted = await workspace.abortMerge(at);
    await store.event(run.key, "conflict_merge", {
      result: "conflict",
      conflictRound: attempt,
      files: 0,
    });
    await save({ dev: { conflict: null } });
    if (!aborted.ok)
      throw new Blocked(`合并冲突后撤回合并失败，工作区留在合并中：${tail(aborted.error)}`);
    throw new Blocked(
      `Loop 合并 ${config.baseRef} 停在合并中，但没有读到冲突文件，已撤回合并：${tail(mergeOutput(merged))}`,
    );
  }
  await store.event(run.key, "conflict_merge", {
    result: "conflict",
    conflictRound: attempt,
    files: files.length,
  });
  await save({ phase: "dev", dev: { conflict: { state: "dev", preMergeSha, files } } });
  return { files, preMergeSha };
}

/** Titles of the commits on the base, not in the branch before the merge, that touch the conflicted files. */
export async function theirCommits(
  h: FlowHost,
  worktree: string,
  preMergeSha: string,
  files: string[],
): Promise<string[]> {
  return h.d.workspace.theirCommits(where(h, worktree), preMergeSha, h.d.config.baseRef, files);
}

/**
 * After the conflict turn, decides from the repository whether the conflict is resolved: nothing unmerged, no
 * conflict markers in the files, the base in HEAD's history. An open merge is finished here with `commit --no-edit`.
 * Anything else rolls the worktree back to before the merge and blocks. Runs before the checkpoint, which would
 * otherwise commit the conflict markers.
 */
export async function judgeConflict(
  h: FlowHost,
  run: DevRun,
  conflict: { files: string[]; preMergeSha: string },
  worktree: string,
  save: Save,
): Promise<void> {
  const { config, store, workspace } = h.d;
  const at = where(h, worktree);
  const open = () => workspace.mergeInProgress(at);
  const problems: string[] = [];
  const markers = await workspace.conflictMarkers(at, conflict.files);
  if (markers.kind === "found") problems.push(`仍有冲突标记：${markers.files.join("、")}`);
  else if (markers.kind === "error") problems.push(`检查冲突标记失败：${tail(markers.output)}`);
  // A file fixed but not staged still counts as unmerged: stage the files that are clean of markers.
  if (problems.length === 0 && (await open())) {
    await workspace.stage(at, conflict.files);
    const unmerged = await workspace.unmergedFiles(at);
    if (unmerged.length > 0) problems.push(`仍有未解决的文件：${unmerged.join("、")}`);
  }
  if (problems.length === 0 && (await open())) {
    const committed = await workspace.commitMerge(at);
    if (!committed.ok) problems.push(`完成合并提交失败：${tail(committed.error)}`);
  }
  if (problems.length === 0) {
    if (!(await workspace.isAncestor(at, config.baseRef)))
      problems.push(`${config.baseRef} 不在当前分支的历史里（合并被撤回或没有完成）`);
    if (!(await workspace.isAncestor(at, conflict.preMergeSha)))
      problems.push("分支原来的提交不在当前历史里（被 rebase 或重置过）");
  }
  if (problems.length === 0) {
    await store.event(run.key, "conflict_resolved", { files: conflict.files.length });
    await save({
      dev: {
        conflict: null,
        resolvedFiles: [...new Set([...run.dev.resolvedFiles, ...conflict.files])],
      },
    });
    return;
  }
  const rollback = await rollbackMerge(h, worktree, conflict.preMergeSha);
  await store.event(run.key, "conflict_unresolved", { files: conflict.files.length });
  await save({ dev: { conflict: null } });
  throw new Blocked(
    `PR 与 ${config.baseBranch} 冲突，Dev 没有解决：${problems.join("；")}。冲突文件：${conflict.files.join("、")}。${
      rollback === "" ? "已撤回合并，工作区回到合并前。" : rollback
    }`,
  );
}

/** Back to before the merge: abort an open one, then reset to the commit it started from. "" when done. */
export async function rollbackMerge(
  h: FlowHost,
  worktree: string,
  preMergeSha: string,
): Promise<string> {
  const { workspace } = h.d;
  const at = where(h, worktree);
  if (await workspace.mergeInProgress(at)) {
    const aborted = await workspace.abortMerge(at);
    if (!aborted.ok) return `撤回合并失败，工作区留在合并中：${tail(aborted.error)}`;
  }
  const reset = await workspace.resetHard(at, preMergeSha);
  return reset.ok ? "" : `退回合并前的提交失败：${tail(reset.error)}`;
}

/**
 * The scene for a conflict turn. A merge still open, or already finished (the base is in HEAD), is left as it is: a
 * restart or a resend does not merge twice. Otherwise (the merge was aborted) it is made again. A merge that now
 * comes out clean needs no turn: undefined.
 */
export async function conflictScene(
  h: FlowHost,
  run: DevRun,
  worktree: string,
  save: Save,
): Promise<{ files: string[]; preMergeSha: string } | undefined> {
  const { config, workspace } = h.d;
  const saved = h.need(run.dev.conflict ?? undefined);
  const at = where(h, worktree);
  const open = await workspace.mergeInProgress(at);
  const merged = await workspace.isAncestor(at, config.baseRef);
  if (saved.preMergeSha !== undefined && saved.files !== undefined && (open || merged))
    return { files: saved.files, preMergeSha: saved.preMergeSha };
  return startMerge(h, run, worktree, save);
}

/** Best effort: names the files a merge of the base into the PR head would conflict on. */
export async function conflictFiles(h: FlowHost, worktree: string): Promise<string[]> {
  const { config, workspace } = h.d;
  return workspace.conflictProbe(where(h, worktree), config.baseRef);
}

/** The text of a failed merge, for the message that says what git said. */
const mergeOutput = (done: Done | undefined): string =>
  done !== undefined && !done.ok ? done.error : "";
