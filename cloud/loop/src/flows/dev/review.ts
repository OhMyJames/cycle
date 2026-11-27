import type { CriteriaBook } from "../../criteria.ts";
import { branchOf, tail } from "../../engine/flow.ts";
import { deadlineFor, recordHeartbeat } from "../../engine/heartbeat.ts";
import { floorHits } from "../../guard/floor.ts";
import { renderReviewComment } from "../../pr.ts";
import {
  formatReviewFindings,
  listsWhatWasChecked,
  parseReviewVerdict,
  type ReviewVerdict,
  reviewBrief,
} from "../../prompts/index.ts";
import type { Issue } from "../../types.ts";
import { tellTicket } from "../ticket.ts";
import { handleConflict } from "./conflict.ts";
import { type Dev, type DevRun, type Save, where } from "./context.ts";
import { scheduleGraphFix } from "./graph.ts";
import { assertNotClosed, confirmMerged } from "./guard.ts";

export async function review(
  x: Dev,
  run: DevRun,
  issue: Issue,
  book: CriteriaBook,
  save: Save,
): Promise<{ prUrl: string; autoMerge: boolean } | undefined> {
  const { h } = x;
  const { config, store } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  const prUrl = h.need(run.dev.prUrl ?? undefined);
  const head = await h.d.workspace.head(where(h, worktree));
  const headSha = head.ok ? head.sha : "";

  // Confirm CI is green for this exact HEAD. Only what this process saw counts: after a crash recovery the first
  // review asks GitHub again, whatever `ci_state` says.
  let ciGreen = headSha !== "" && x.greenSeen.get(run.key) === headSha;
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
        x.greenSeen.set(run.key, headSha);
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

  // The comment on the pull request is made once for a head and a conclusion, however often the review is entered.
  const writeAndPostComment = async (body: string, decision: string) => {
    const said = `${headSha}:${decision}`;
    if (headSha !== "" && run.dev.reviewCommented === said) return { ok: true as const };
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const commentPath = join(config.stateDir, "runs", run.key, "review-comment.md");
    await mkdir(join(config.stateDir, "runs", run.key), { recursive: true, mode: 0o700 });
    await writeFile(commentPath, body, { mode: 0o600 });
    const posted = await h.net(
      run.key,
      "gh pr comment",
      () => h.d.forge.comment(where(h, worktree), prUrl, commentPath),
      (r) => (r.ok ? undefined : r.error),
    );
    if (posted.ok && headSha !== "") await save({ dev: { reviewCommented: said } });
    return posted;
  };

  /** The end of the review: the comment and the move for the tracker, the run done, and what happened, in one go. */
  const deliverWith = async (
    conclusion: string,
    body: string,
    done: { decision: string; autoMerge: boolean },
    move: boolean,
  ) => {
    await save({ phase: "done", dev: { prUrl } }, (tx) => {
      tellTicket(tx, run, issue, `review:${run.key}:${headSha}:${conclusion}`, {
        body,
        ...(move ? { to: "inReview" as const } : {}),
      });
      tx.event(run.key, "review_done", done);
      tx.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: done.autoMerge });
    });
    return { prUrl, autoMerge: done.autoMerge };
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
      "system_error",
    );
    await store.event(run.key, "review_decided", { decision: "system_error", attempts });
    const commentErrorLine = !commented.ok
      ? `\n写入 PR 评审评论失败：${tail(commented.error)}`
      : "";
    return deliverWith(
      "system_error",
      `已开 PR：${prUrl}\n独立评审经 ${attempts} 次尝试仍未得到有效结论，已升级给人处理。注意：这是评审系统故障，不是代码问题。\n原因：${reason}${commentErrorLine}`,
      { decision: "system_error", autoMerge: false },
      true,
    );
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
      "reject",
    );
    await store.event(run.key, "review_decided", { decision: "reject" });
    await store.event(run.key, "round_failed", { round: run.round });
    const formatted = formatReviewFindings(verdict);

    if (limitReached) {
      const commentErrorLine = !commented.ok
        ? `\n写入 PR 评审评论失败：${tail(commented.error)}`
        : "";
      return deliverWith(
        "reject_limit",
        `已开 PR：${prUrl}\n独立评审拒绝（reject），且已达修复轮数上限（${run.round} 轮），未开启自动合并，升级给人处理：\n${tail(formatted, 1500)}${commentErrorLine}`,
        { decision: "reject_limit", autoMerge: false },
        true,
      );
    }

    x.greenSeen.delete(run.key);
    await h.d.store.saveCi(run.key, { greenSha: null });
    await store.event(run.key, "review_done", { decision: "reject", autoMerge: false });
    const findings = `PR review rejected ${prUrl} (decision: reject). Fix the blocker/major issues below, run \`bun run check\`, and commit; the loop will verify, run QA, push to the same branch, wait for CI, and re-review.\n\n${formatted}`;
    const scheduled = await scheduleGraphFix(h, run, {
      title: "修复 PR 独立评审问题",
      findings,
      verify: ["bun run check"],
      save,
    });
    if (!scheduled) {
      await save({ phase: "dev", round: run.round + 1, findings });
    }
    return undefined;
  }

  // Merge: check the hard path floor before enabling auto-merge (CYC-481). Touching any floor path, or failing to
  // read the changed path list, forces an escalate to a person regardless of the LLM verdict.
  if (verdict.decision === "merge") {
    const changed = await h.net(
      run.key,
      "gh pr diff",
      () => h.d.forge.changedPaths(where(h, worktree), prUrl),
      (r) => (r.ok ? undefined : r.error),
    );
    const hits = changed.ok ? floorHits(changed.paths) : [];
    if (!changed.ok || hits.length > 0) {
      const floorReason = changed.ok
        ? `改动涉及需要人合并的路径：${hits.join("、")}`
        : `无法读取 PR 改动路径列表，按路径底线升级给人合并：${tail(changed.error)}`;
      const escalatedVerdict: ReviewVerdict = {
        ...verdict,
        decision: "escalate",
        reasons: [...verdict.reasons, floorReason],
      };
      const commented = await writeAndPostComment(
        renderReviewComment({
          issueKey: run.key,
          ciChecks: config.ciChecks,
          ciGreen,
          sessionId: reviewSessionId,
          verdict: escalatedVerdict,
        }),
        "floor_hit",
      );
      await store.event(run.key, "floor_hit", {
        ...(changed.ok ? { paths: hits.join(",") } : { unreadable: true }),
      });
      await store.event(run.key, "review_decided", { decision: "escalate" });
      const commentErrorLine = !commented.ok
        ? `\n写入 PR 评审评论失败：${tail(commented.error)}`
        : "";
      return deliverWith(
        "floor_hit",
        `已开 PR：${prUrl}\n${floorReason}，未开启自动合并，已升级给人合并。${commentErrorLine}`,
        { decision: "escalate", autoMerge: false },
        true,
      );
    }

    const commented = await writeAndPostComment(
      renderReviewComment({
        issueKey: run.key,
        ciChecks: config.ciChecks,
        ciGreen,
        sessionId: reviewSessionId,
        verdict,
      }),
      "merge",
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
        recordHeartbeat(h.d.store, run.key, {
          phase: "review",
          waitingOn: "merge",
          deadline: deadlineFor("merge", h.d.clock.now(), h.d.config),
        });
        const outcome = await confirmMerged(h, run, prUrl, worktree);
        if (outcome === "conflict") {
          // Not delivered: merge the base in (auto-merge is turned off first), then CI and review run again.
          await handleConflict(h, run, prUrl, worktree, save);
          x.greenSeen.delete(run.key);
          await h.d.store.saveCi(run.key, { greenSha: null });
          return undefined;
        }
        return deliverWith(
          "merge",
          `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）全部通过，独立评审结论为合并（merge：${verdict.summary}），已开启 GitHub 自动合并（squash）。`,
          { decision: "merge", autoMerge: true },
          false,
        );
      }
      return deliverWith(
        "merge_failed",
        `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）全部通过且独立评审通过，但开启 GitHub 自动合并失败（这是系统/GitHub 操作故障，不是代码问题），需要人工处理：\n${tail(merged.error)}`,
        { decision: "merge", autoMerge: false },
        true,
      );
    }

    const reasonLines: string[] = [];
    if (!ciGreen && ciNotGreenReason !== null) reasonLines.push(ciNotGreenReason);
    if (!commented.ok) reasonLines.push(`写入 PR 评审评论失败：${tail(commented.error)}`);
    return deliverWith(
      "merge_blocked",
      `已开 PR：${prUrl}\n独立评审结论为合并，但未满足自动合并前置条件，未开启自动合并，需要人工处理：\n${reasonLines.join("\n")}`,
      { decision: "system_error", autoMerge: false },
      true,
    );
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
    "escalate",
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
  return deliverWith(
    "escalate",
    `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）已跑完，独立评审结论为升级给人（escalate），未开启自动合并：\n${reasonLines.join("\n")}`,
    { decision: "escalate", autoMerge: false },
    true,
  );
}
