import type { CriteriaBook } from "../../criteria.ts";
import { branchOf, tail } from "../../engine/flow.ts";
import { renderReviewComment } from "../../pr.ts";
import {
  formatReviewFindings,
  listsWhatWasChecked,
  parseReviewVerdict,
  type ReviewVerdict,
  reviewBrief,
} from "../../prompts/index.ts";
import type { Issue } from "../../types.ts";
import { handleConflict } from "./conflict.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { assertNotClosed, confirmMerged } from "./guard.ts";

export async function review(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  book: CriteriaBook,
  save: Save,
): Promise<{ prUrl: string; autoMerge: boolean } | undefined> {
  const { config, store, tracker } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  const prUrl = h.need(run.dev.prUrl ?? undefined);
  const head = await h.d.workspace.head(where(h, worktree));
  const headSha = head.ok ? head.sha : "";

  // Confirm CI is green for this exact HEAD (re-checks via GitHub after a crash recovery).
  let ciGreen = headSha !== "" && (await h.d.store.loadCi(run.key)).greenSha === headSha;
  let ciNotGreenReason: string | null = null;
  if (!ciGreen) {
    if (headSha === "") {
      ciNotGreenReason = `读取 HEAD 提交失败：${tail(head.ok ? "" : head.error)}`;
    } else {
      const read = await h.net(
        run.key,
        "gh pr view",
        () => h.d.forge.ciStatus(where(h, worktree), prUrl, headSha, config.ciChecks),
        (r) => (r.ok ? undefined : r.error),
      );
      if (read.ok && read.status.state === "passed") {
        ciGreen = true;
        await h.d.store.saveCi(run.key, { greenSha: headSha });
      } else {
        ciNotGreenReason = read.ok
          ? `CI 状态未全绿（当前为 ${read.status.state}）。`
          : `读取 CI 状态失败：${tail(read.error)}`;
      }
    }
  }

  const diff = await h.d.workspace.diff(where(h, worktree), config.baseRef);
  const maxAttempts = Math.max(1, config.maxReviewRetries + 1);
  let reviewSessionId = run.dev.reviewSessionId;
  let verdict: ReviewVerdict | undefined;
  let lastFailure: string | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts = attempt + 1;
    let worktreeModified = false;
    try {
      const created = await h.d.sessions.create({
        role: "review",
        agent: config.reviewAgent,
        ...(config.reviewModel ? { model: config.reviewModel } : {}),
        ...(config.reviewEffort ? { effort: config.reviewEffort } : {}),
        title: `[${run.key}] Review`,
        cwd: config.repoRoot,
        worktree: { base: config.baseRef, name: branchOf(issue.number) },
      });
      reviewSessionId = created.sessionId;
      await save({ dev: { reviewSessionId } });

      const before = await h.snapshot(worktree);
      const retryNote =
        attempt > 0 && lastFailure !== null
          ? `Previous review attempt #${attempt} failed (${lastFailure}). Make sure to include a "What I checked" list and end with a valid <review> JSON block choosing "merge", "reject", or "escalate".`
          : undefined;
      const prompt = reviewBrief(
        issue,
        prUrl,
        book.items,
        diff,
        config.ciChecks,
        retryNote,
        run.dev.resolvedFiles,
      );
      const result = await h.turn(run.key, reviewSessionId, prompt, {
        role: "review",
        worktree,
        timeoutMs: config.turnTimeoutMs,
      });
      await store.event(run.key, "review_turn", {
        round: run.round,
        attempt,
        stop: result.stopReason,
      });

      const after = await h.snapshot(worktree);
      if (before !== after) {
        lastFailure = "评审会话修改了工作区，自动化不信任这次评审结果。";
        worktreeModified = true;
      } else if (result.timedOut) {
        lastFailure = "评审会话单回合超时被取消。";
      } else if (result.stopReason !== "end_turn") {
        lastFailure = `评审会话异常结束（${result.stopReason}）。`;
      } else {
        const parsed = parseReviewVerdict(result.text);
        if (parsed === undefined) {
          lastFailure = "评审会话未给出可解析的结构化结论。";
        } else if (parsed.decision === "merge" && !listsWhatWasChecked(result.text)) {
          lastFailure = "评审结论为合并（merge）但未列出检查内容，不接受无依据的通过。";
        } else {
          verdict = parsed;
          lastFailure = null;
          break;
        }
      }
    } catch (error) {
      lastFailure = `评审会话执行失败：${error instanceof Error ? error.message : String(error)}`;
    }
    if (worktreeModified) break;
    if (attempt + 1 < maxAttempts) {
      await store.event(run.key, "review_retry", { round: run.round, attempt: attempt + 1 });
    }
  }

  await assertNotClosed(h, run);

  const writeAndPostComment = async (body: string) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const commentPath = join(config.stateDir, "runs", run.key, "review-comment.md");
    await mkdir(join(config.stateDir, "runs", run.key), { recursive: true, mode: 0o700 });
    await writeFile(commentPath, body, { mode: 0o600 });
    return h.net(
      run.key,
      "gh pr comment",
      () => h.d.forge.comment(where(h, worktree), prUrl, commentPath),
      (r) => (r.ok ? undefined : r.error),
    );
  };

  // No valid conclusion even after retries (or read-only violation): review system failure, not a code issue.
  if (verdict === undefined) {
    const reason = lastFailure ?? "评审会话未给出有效结论。";
    const commented = await writeAndPostComment(
      renderReviewComment({
        issueKey: run.key,
        ciChecks: config.ciChecks,
        ciGreen,
        sessionId: reviewSessionId,
        systemError: { reason, attempts },
      }),
    );
    await store.event(run.key, "review_decided", { decision: "system_error", attempts });
    const commentErrorLine = !commented.ok
      ? `\n写入 PR 评审评论失败：${tail(commented.error)}`
      : "";
    await tracker.comment(
      issue,
      `已开 PR：${prUrl}\n独立评审经 ${attempts} 次尝试仍未得到有效结论，已升级给人处理。注意：这是评审系统故障，不是代码问题。\n原因：${reason}${commentErrorLine}`,
    );
    await tracker.move(issue, "inReview");
    await store.event(run.key, "review_done", {
      decision: "system_error",
      autoMerge: false,
      attempts,
    });
    await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
    await save({ phase: "done", dev: { prUrl } });
    return { prUrl, autoMerge: false };
  }

  // Reject: blocker or major issues -> send back to Dev with review feedback (or escalate if fix round limit hit).
  if (verdict.decision === "reject") {
    const limitReached = run.round >= config.maxFixRounds;
    const commented = await writeAndPostComment(
      renderReviewComment({
        issueKey: run.key,
        ciChecks: config.ciChecks,
        ciGreen,
        sessionId: reviewSessionId,
        verdict,
        rejectLimitReached: limitReached,
      }),
    );
    await store.event(run.key, "review_decided", { decision: "reject" });
    await store.event(run.key, "round_failed", { round: run.round });
    const formatted = formatReviewFindings(verdict);

    if (limitReached) {
      const commentErrorLine = !commented.ok
        ? `\n写入 PR 评审评论失败：${tail(commented.error)}`
        : "";
      await tracker.comment(
        issue,
        `已开 PR：${prUrl}\n独立评审拒绝（reject），且已达修复轮数上限（${run.round} 轮），未开启自动合并，升级给人处理：\n${tail(formatted, 1500)}${commentErrorLine}`,
      );
      await tracker.move(issue, "inReview");
      await store.event(run.key, "review_done", { decision: "reject_limit", autoMerge: false });
      await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
      await save({ phase: "done", dev: { prUrl } });
      return { prUrl, autoMerge: false };
    }

    await h.d.store.saveCi(run.key, { greenSha: null });
    await store.event(run.key, "review_done", { decision: "reject", autoMerge: false });
    const findings = `PR review rejected ${prUrl} (decision: reject). Fix the blocker/major issues below, run \`bun run check\`, and commit; the loop will verify, run QA, push to the same branch, wait for CI, and re-review.\n\n${formatted}`;
    await save({ phase: "dev", round: run.round + 1, findings });
    return undefined;
  }

  // Merge: enable squash auto-merge only when CI is green and the PR review comment succeeded.
  if (verdict.decision === "merge") {
    const commented = await writeAndPostComment(
      renderReviewComment({
        issueKey: run.key,
        ciChecks: config.ciChecks,
        ciGreen,
        sessionId: reviewSessionId,
        verdict,
      }),
    );
    await store.event(run.key, "review_decided", { decision: "merge" });
    if (ciGreen && commented.ok) {
      const merged = await h.net(
        run.key,
        "gh pr merge",
        () => h.d.forge.autoMerge(where(h, worktree), prUrl, true),
        (r) => (r.ok ? undefined : r.error),
      );
      if (merged.ok) {
        h.mirror(run.key, issue, "merge");
        const outcome = await confirmMerged(h, run, prUrl, worktree);
        if (outcome === "conflict") {
          // Not delivered: merge the base in (auto-merge is turned off first), then CI and review run again.
          await handleConflict(h, run, prUrl, worktree, save);
          await h.d.store.saveCi(run.key, { greenSha: null });
          return undefined;
        }
        await tracker.comment(
          issue,
          `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）全部通过，独立评审结论为合并（merge：${verdict.summary}），已开启 GitHub 自动合并（squash）。`,
        );
        await store.event(run.key, "review_done", { decision: "merge", autoMerge: true });
        await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: true });
        await save({ phase: "done", dev: { prUrl } });
        return { prUrl, autoMerge: true };
      }
      await tracker.comment(
        issue,
        `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）全部通过且独立评审通过，但开启 GitHub 自动合并失败（这是系统/GitHub 操作故障，不是代码问题），需要人工处理：\n${tail(merged.error)}`,
      );
      await tracker.move(issue, "inReview");
      await store.event(run.key, "review_done", { decision: "merge", autoMerge: false });
      await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
      await save({ phase: "done", dev: { prUrl } });
      return { prUrl, autoMerge: false };
    }

    const reasonLines: string[] = [];
    if (!ciGreen && ciNotGreenReason !== null) reasonLines.push(ciNotGreenReason);
    if (!commented.ok) reasonLines.push(`写入 PR 评审评论失败：${tail(commented.error)}`);
    await tracker.comment(
      issue,
      `已开 PR：${prUrl}\n独立评审结论为合并，但未满足自动合并前置条件，未开启自动合并，需要人工处理：\n${reasonLines.join("\n")}`,
    );
    await tracker.move(issue, "inReview");
    await store.event(run.key, "review_done", { decision: "system_error", autoMerge: false });
    await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
    await save({ phase: "done", dev: { prUrl } });
    return { prUrl, autoMerge: false };
  }

  // Escalate: needs human judgment -> post PR comment, do not enable auto-merge, move to In Review.
  const commented = await writeAndPostComment(
    renderReviewComment({
      issueKey: run.key,
      ciChecks: config.ciChecks,
      ciGreen,
      sessionId: reviewSessionId,
      verdict,
    }),
  );
  await store.event(run.key, "review_decided", { decision: "escalate" });
  const reasonLines: string[] = [verdict.summary];
  for (const reason of verdict.reasons) reasonLines.push(`- ${reason}`);
  for (const finding of verdict.findings) {
    reasonLines.push(`- [${finding.severity}] ${finding.where}: ${finding.problem}`);
  }
  if (!commented.ok) {
    reasonLines.push(`写入 PR 评审评论失败：${tail(commented.error)}`);
  }
  await tracker.comment(
    issue,
    `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）已跑完，独立评审结论为升级给人（escalate），未开启自动合并：\n${reasonLines.join("\n")}`,
  );
  await tracker.move(issue, "inReview");
  await store.event(run.key, "review_done", { decision: "escalate", autoMerge: false });
  await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
  await save({ phase: "done", dev: { prUrl } });
  return { prUrl, autoMerge: false };
}
