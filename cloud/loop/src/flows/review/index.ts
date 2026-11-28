// The review task (CYC-540): one read-only review of one commit of one pull request, whoever asked for it. It
// delivers a conclusion bound to that commit and decides nothing else: the dev flow and the flow for pull requests a
// person opened both call it and act on the conclusion themselves.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewTask } from "../../db/store.ts";
import { branchOf, type FlowHost, NetworkWait, tail } from "../../engine/flow.ts";
import type { At } from "../../ports/forge.ts";
import { renderReviewComment } from "../../pr.ts";
import {
  listsWhatWasChecked,
  parseReviewVerdict,
  type ReviewContext,
  type ReviewVerdict,
  reviewContextBrief,
} from "../../prompts/index.ts";

export type ReviewInput = {
  repo: string;
  pr: number;
  /** The commit to review: the conclusion belongs to it and to no other. */
  headSha: string;
  /** The pull request for `gh`: its URL or number. */
  prRef: string;
  /** The key the task's events, network waits and comment files go under. */
  key: string;
  /** `dev:<run key>` or `pr`. */
  origin: string;
  /** The worktree that holds `headSha`; absent for a pull request of a person, whose branch is fetched first. */
  worktree?: string;
  /** For a pull request of a person: its head branch on the repository. */
  branch?: string;
  context: ReviewContext;
  /** The comment for a conclusion, when the caller has more to say than the default. */
  render?: (what: RenderInput) => string;
  /** False when the caller writes the comment itself (with `commentOnce`), for example to put a note of its own in it. */
  comment?: boolean;
  /** True when the caller has seen CI green on this commit itself, so GitHub is not asked again. */
  ciKnownGreen?: boolean;
};

export type RenderInput = {
  verdict?: ReviewVerdict;
  systemError?: { reason: string; attempts: number };
  sessionId: string | null;
};

export type ReviewConclusion = {
  decision: "merge" | "reject" | "escalate" | "system_error";
  verdict: ReviewVerdict | null;
  /** The reason, when `decision` is `system_error`. */
  reason: string | null;
  /** The session id of every attempt, the last last. */
  sessions: string[];
  /** How many attempts this call made (a failed attempt may have opened no session). */
  attempts: number;
  /** False when the comment could not be written to the pull request. */
  commented: boolean;
  commentError: string | null;
};

export type ReviewResult =
  | {
      kind: "concluded";
      headSha: string;
      conclusion: ReviewConclusion;
      /** True when this call read CI on the commit and found it green (not when the conclusion was kept from before). */
      ciReadGreen: boolean;
    }
  /** CI is not green on this commit, so no session was opened. */
  | { kind: "ci_not_green"; reason: string; state: string }
  /** CI or the branch could not be read now; nothing is concluded, and asking again is fine. */
  | { kind: "unavailable"; reason: string }
  /** Another caller holds the task. */
  | { kind: "busy" };

const at = (h: FlowHost, cwd: string): At => ({ cwd, timeoutMs: h.d.config.commandTimeoutMs });

const asConclusion = (task: ReviewTask): ReviewConclusion => {
  const decision = (task.decision ?? "system_error") as ReviewConclusion["decision"];
  const stored = (task.verdict ?? null) as (ReviewVerdict & { systemError?: string }) | null;
  return {
    decision,
    verdict: decision === "system_error" ? null : stored,
    reason: decision === "system_error" ? (stored?.systemError ?? null) : null,
    sessions: task.sessions,
    attempts: task.sessions.length,
    commented: true,
    commentError: null,
  };
};

/**
 * Posts `body` on the pull request once for "<commit>:<what>": the task's own comment, or one more the caller makes
 * about the same commit (the dev flow's path-floor note). A second ask for the same entry does nothing.
 */
export async function commentOnce(
  h: FlowHost,
  input: Pick<ReviewInput, "repo" | "pr" | "headSha" | "prRef" | "key">,
  cwd: string,
  what: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { store, config } = h.d;
  const entry = `${input.headSha}:${what}`;
  const task = store.transaction((tx) => tx.findReviewTask(input.repo, input.pr, input.headSha));
  if (task === undefined || task.commented.includes(entry)) return { ok: true };
  const give = (error: string) => ({ ok: false as const, error });
  try {
    const dir = join(config.stateDir, "runs", input.key.replace(/[^A-Za-z0-9._-]/g, "_"));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "review-comment.md");
    await writeFile(path, body, { mode: 0o600 });
    const posted = await h.net(
      input.key,
      "gh pr comment",
      () => h.d.forge.comment(at(h, cwd), input.prRef, path),
      (r) => (r.ok ? undefined : r.error),
    );
    if (!posted.ok) return give(posted.error);
    // Marked once it is on the pull request: a failed post is tried again at the next entry.
    store.transaction((tx) => tx.markReviewCommented(task.id, entry));
    return { ok: true };
  } catch (error) {
    // A network wait belongs to the engine: it parks the run and comes back.
    if (error instanceof NetworkWait) throw error;
    return give(error instanceof Error ? error.message : String(error));
  }
}

export async function reviewTask(h: FlowHost, input: ReviewInput): Promise<ReviewResult> {
  const { config, store } = h.d;
  const { repo, pr, headSha, key } = input;
  const task = store.transaction((tx) => tx.reviewTask(repo, pr, headSha, input.origin));

  // The cwd of the commands on GitHub: the worktree when there is one, the main checkout otherwise.
  const cwd = input.worktree ?? config.repoRoot;

  const render =
    input.render ??
    ((r: RenderInput) =>
      renderReviewComment({
        issueKey: input.context.kind === "ticket" ? input.context.issue.key : `PR #${pr}`,
        ciChecks: config.ciChecks,
        ciGreen: true,
        sessionId: r.sessionId,
        verdict: r.verdict,
        systemError: r.systemError ?? null,
      }));

  let ciReadGreen = false;
  const finish = async (t: ReviewTask, live?: ReviewConclusion): Promise<ReviewResult> => {
    const c = live ?? asConclusion(t);
    const lastSession = t.sessions.at(-1) ?? null;
    const body = render({
      ...(c.verdict !== null ? { verdict: c.verdict } : {}),
      ...(c.decision === "system_error"
        ? {
            systemError: {
              reason: c.reason ?? "评审会话未给出有效结论。",
              attempts: c.attempts,
            },
          }
        : {}),
      sessionId: lastSession,
    });
    const posted =
      input.comment === false
        ? ({ ok: true } as const)
        : await commentOnce(h, input, cwd, c.decision, body);
    return {
      kind: "concluded",
      headSha,
      ciReadGreen,
      conclusion: {
        ...c,
        commented: posted.ok,
        commentError: posted.ok ? null : posted.error,
      },
    };
  };

  // Reviewed already: the same conclusion, whoever asks again.
  if (task.status === "done") return finish(task);

  // CI first: a commit whose required checks are not all green is not reviewed.
  if (input.ciKnownGreen !== true) {
    const read = await h.net(
      key,
      "gh pr view",
      () => h.d.forge.ciStatus(at(h, cwd), input.prRef, headSha, config.ciChecks),
      (r) => (r.ok ? undefined : r.error),
    );
    if (!read.ok) {
      return { kind: "unavailable", reason: `读取 CI 状态失败：${tail(read.error)}` };
    }
    if (read.status.state !== "passed") {
      return {
        kind: "ci_not_green",
        reason: `CI 状态未全绿（当前为 ${read.status.state}）。`,
        state: read.status.state,
      };
    }
    ciReadGreen = true;
  }

  // A claim older than a turn plus its commands belongs to a process that died: it is taken over.
  const lease = config.turnTimeoutMs + 4 * config.commandTimeoutMs;
  if (!store.transaction((tx) => tx.claimReviewTask(task.id, lease))) return { kind: "busy" };
  let concluded = false;
  try {
    if (input.worktree === undefined) {
      // A pull request of a person: its branch comes to a local one, with credentials only in the delivery repository.
      if (input.branch === undefined)
        throw new Error("a pull request review needs its head branch");
      const fetched = await h.d.workspace.fetchPrBranch(
        at(h, config.repoRoot),
        input.branch,
        `loop-pr/${pr}`,
      );
      if (fetched.code !== 0 || fetched.timedOut) {
        return { kind: "unavailable", reason: `拉取 PR 分支失败：${tail(fetched.output)}` };
      }
      // The diff is against the base: a stale base would show the person's PR wrongly.
      const main = await h.d.workspace.fetchMain(at(h, config.repoRoot));
      if (main.code !== 0 || main.timedOut) {
        return { kind: "unavailable", reason: `刷新基线分支失败：${tail(main.output)}` };
      }
    }

    const maxAttempts = Math.max(1, config.maxReviewRetries + 1);
    const sessions: string[] = [];
    let verdict: ReviewVerdict | undefined;
    let lastFailure: string | null = null;
    let tried = 0;
    let diff: string | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let worktreeModified = false;
      tried = attempt + 1;
      try {
        const created = await h.d.sessions.create({
          role: "review",
          run: key,
          agent: config.reviewAgent,
          ...(config.reviewModel ? { model: config.reviewModel } : {}),
          ...(config.reviewEffort ? { effort: config.reviewEffort } : {}),
          title: `[${key}] Review`,
          cwd: config.repoRoot,
          worktree: {
            // A pull request of a person: the worktree starts at the reviewed commit itself, not at the base.
            base: input.worktree === undefined ? headSha : config.baseRef,
            name:
              input.context.kind === "ticket"
                ? branchOf(input.context.issue.number)
                : `loop-pr/${pr}-${headSha.slice(0, 12)}`,
          },
        });
        sessions.push(created.sessionId);
        store.transaction((tx) => tx.addReviewSession(task.id, created.sessionId));
        // A pull request of a person gets its worktree from the session each attempt; the dev flow's is its own.
        const worktree = input.worktree ?? created.cwd;
        // What is read must be the commit the conclusion will be bound to.
        const at0 = await h.d.workspace.head(at(h, worktree));
        if (!at0.ok || at0.sha !== headSha)
          throw new Error(
            `评审工作区不在待审提交 ${headSha.slice(0, 12)} 上（${at0.ok ? at0.sha.slice(0, 12) : tail(at0.error)}）。`,
          );
        diff ??= await h.d.workspace.diff(at(h, worktree), config.baseRef);

        const before = await h.snapshot(worktree);
        const retryNote =
          attempt > 0 && lastFailure !== null
            ? `Previous review attempt #${attempt} failed (${lastFailure}). Make sure to include a "What I checked" list and end with a valid <review> JSON block choosing "merge", "reject", or "escalate".`
            : undefined;
        const prompt = reviewContextBrief(
          input.context,
          input.prRef,
          diff,
          config.ciChecks,
          retryNote,
        );
        const result = await h.turn(key, created.sessionId, prompt, {
          role: "review",
          worktree,
          timeoutMs: config.turnTimeoutMs,
        });
        await store.event(key, "review_turn", { attempt, stop: result.stopReason });

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
        if (error instanceof NetworkWait) throw error;
        lastFailure = `评审会话执行失败：${error instanceof Error ? error.message : String(error)}`;
      }
      if (worktreeModified) break;
      if (attempt + 1 < maxAttempts)
        await store.event(key, "review_retry", { attempt: attempt + 1 });
    }

    if (verdict === undefined) {
      // A failure of the review system is not a conclusion about the commit: the task goes back to pending, so
      // asking again reviews again. The sessions of the attempts stay on the task.
      const reason = lastFailure ?? "评审会话未给出有效结论。";
      await store.event(key, "review_decided", { decision: "system_error" });
      const current = store.transaction((tx) => tx.findReviewTask(repo, pr, headSha)) as ReviewTask;
      return await finish(current, {
        decision: "system_error",
        verdict: null,
        reason,
        sessions: current.sessions,
        attempts: tried,
        commented: true,
        commentError: null,
      });
    }
    const decision = verdict.decision;
    store.transaction((tx) => tx.finishReviewTask(task.id, decision, verdict));
    concluded = true;
    const done = store.transaction((tx) => tx.findReviewTask(repo, pr, headSha)) as ReviewTask;
    await store.event(key, "review_decided", { decision });
    return await finish(done);
  } finally {
    if (!concluded) store.transaction((tx) => tx.releaseReviewTask(task.id));
  }
}
