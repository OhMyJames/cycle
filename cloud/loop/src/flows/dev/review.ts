import type { CriteriaBook } from "../../criteria.ts";
import { tail } from "../../engine/flow.ts";
import { deadlineFor, recordHeartbeat } from "../../engine/heartbeat.ts";
import { mayMerge } from "../../guard/merge-gate.ts";
import { renderReviewComment } from "../../pr.ts";
import { formatReviewFindings, type ReviewVerdict } from "../../prompts/index.ts";
import type { Issue } from "../../types.ts";
import { commentOnce, type ReviewInput, reviewTask } from "../review/index.ts";
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

  // The review itself is the review task's: it confirms CI for this exact HEAD with GitHub, runs the read-only
  // sessions and keeps the conclusion for the commit. This flow acts on the conclusion.
  const parsedPr = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl);
  const repo = parsedPr?.[1] ?? "";
  const pr = parsedPr ? Number(parsedPr[2]) : 0;
  const reviewInput: ReviewInput = {
    repo,
    pr,
    headSha,
    prRef: prUrl,
    key: run.key,
    origin: `dev:${run.key}`,
    worktree,
    comment: false,
    ciKnownGreen: headSha !== "" && x.greenSeen.get(run.key) === headSha,
    context: {
      kind: "ticket",
      issue,
      criteria: book.items,
      resolvedFiles: run.dev.resolvedFiles ?? [],
    },
    render: (r) =>
      renderReviewComment({
        issueKey: run.key,
        ciChecks: config.ciChecks,
        ciGreen: true,
        sessionId: r.sessionId,
        ...(r.verdict ? { verdict: r.verdict } : {}),
        ...(r.systemError ? { systemError: r.systemError } : {}),
      }),
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

  const result =
    parsedPr === null
      ? ({
          kind: "unavailable",
          reason: `无法从 PR 地址读出仓库和编号：${tail(prUrl)}`,
        } as const)
      : headSha === ""
        ? ({
            kind: "unavailable",
            reason: `读取 HEAD 提交失败：${tail(head.ok ? "" : head.error)}`,
          } as const)
        : await reviewTask(h, reviewInput);
  await assertNotClosed(h, run);

  if (result.kind !== "concluded") {
    const why =
      result.kind === "ci_not_green"
        ? result.reason
        : result.kind === "busy"
          ? "这个提交的评审正被另一处执行。"
          : result.reason;
    x.greenSeen.delete(run.key);
    return deliverWith(
      "merge_blocked",
      `已开 PR：${prUrl}\n未能得到针对这个提交的评审结论，未开启自动合并，需要人工处理：\n${why}`,
      { decision: "system_error", autoMerge: false },
      true,
    );
  }
  // A conclusion kept from an earlier call says nothing about CI now: unless CI was seen green on this commit, or the
  // task has just read it, read it again before green is recorded or the gate is asked.
  let ciAtHead: "passed" | "failed" | "pending" | "unreadable" = "passed";
  if (reviewInput.ciKnownGreen !== true && !result.ciReadGreen) {
    const ci = await h.net(
      run.key,
      "gh pr view",
      () => h.d.forge.ciStatus(where(h, worktree), prUrl, headSha, config.ciChecks),
      (r) => (r.ok ? undefined : r.error),
    );
    ciAtHead = ci.ok ? ci.status.state : "unreadable";
  }
  if (ciAtHead !== "passed") {
    x.greenSeen.delete(run.key);
    return deliverWith(
      "merge_blocked",
      `已开 PR：${prUrl}\n评审结论已有，但这个提交的 CI 当前不是全绿（${ciAtHead}），未开启自动合并，需要人工处理。`,
      { decision: "system_error", autoMerge: false },
      true,
    );
  }
  x.greenSeen.set(run.key, headSha);
  await h.d.store.saveCi(run.key, { greenSha: headSha });
  const { conclusion } = result;
  const ciGreen = true;
  const reviewSessionId = conclusion.sessions.at(-1) ?? run.dev.reviewSessionId;
  if (reviewSessionId !== run.dev.reviewSessionId) await save({ dev: { reviewSessionId } });
  const verdict: ReviewVerdict | undefined = conclusion.verdict ?? undefined;
  const writeAndPostComment = async (body: string, decision: string) => {
    const posted = await commentOnce(h, reviewInput, worktree, decision, body);
    if (posted.ok && headSha !== "")
      await save({ dev: { reviewCommented: `${headSha}:${decision}` } });
    return posted;
  };

  // No valid conclusion even after retries (or read-only violation): review system failure, not a code issue.
  if (verdict === undefined) {
    const reason = conclusion.reason ?? "评审会话未给出有效结论。";
    const attempts = conclusion.attempts;
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
    const gate = mayMerge({
      verdict: conclusion.decision,
      reviewedSha: result.headSha,
      headNow: headSha,
      ciAtHead,
      changedPaths: changed.ok ? changed.paths : null,
    });
    const hits = gate.ok ? [] : gate.floorHits;
    if (!gate.ok) {
      const floorReason = changed.ok
        ? hits.length > 0
          ? `改动涉及需要人合并的路径：${hits.join("、")}`
          : `不满足合并门禁：${gate.reasons.join("；")}`
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
