import type { CriteriaBook } from "../../criteria.ts";
import { Blocked, branchOf, type Flow, tail } from "../../engine/flow.ts";
import {
  formatFindings,
  listsWhatWasChecked,
  parseVerdict,
  qaBrief,
  type Verdict,
} from "../../prompts/index.ts";
import type { RunRecord } from "../../store.ts";
import { type Issue, SessionLost, type TurnResult } from "../../types.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { docTexts } from "./docs.ts";

/** The independent QA session of a dev run. */
export const DEV_QA: Flow["qa"] = {
  role: "qa",
  title: (key) => `[${key}] QA`,
  subject: "代码",
  readRoots: () => undefined,
};

export async function qa(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  book: CriteriaBook,
  save: Save,
): Promise<void> {
  const { config } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  if (run.qaSessionId === null) {
    const sessionId = await newQaSession(h, DEV_QA, run, issue);
    await save({ qaSessionId: sessionId });
    run = { ...run, qaSessionId: sessionId };
  }
  const before = await h.snapshot(worktree);
  const diff = await h.d.workspace.diff(where(h, worktree), config.baseRef);
  const checks = (await h.d.store.loadCi(run.key)).checks
    .map((c) => `- ${c.command}: ${c.passed ? "passed" : "failed"}`)
    .join("\n");
  const prompt = qaBrief(
    issue,
    book.items,
    diff,
    checks === "" ? "(none)" : checks,
    run.dev.resolvedFiles,
    await docTexts(h, run, issue, ["Spec", "Design", "Plan"]),
  );
  const verdict = await judge(h, DEV_QA, run, issue, worktree, before, prompt, save);
  if (!verdict.pass) {
    await nextRound(h, run, `Independent review found:\n${formatFindings(verdict)}`, save);
    return;
  }
  await save({ phase: "delivering" });
}

/**
 * The QA turn of a dev or a research run: a verdict that says what was checked, from a session that changed nothing.
 * An unusable answer is tried again in a fresh session, up to `maxQaRetries` times; then it blocks as a fault of QA.
 * `before` is the worktree as it was before the brief was made.
 */
export async function judge(
  h: FlowHost,
  qa: Flow["qa"],
  start: RunRecord,
  issue: Issue,
  worktree: string,
  before: string,
  prompt: string,
  save: Save,
): Promise<Verdict> {
  const { config, store } = h.d;
  let run = start;
  const maxAttempts = Math.max(1, config.maxQaRetries + 1);
  const readRoots = qa.readRoots(config);
  const turnOptions = {
    role: qa.role,
    worktree,
    timeoutMs: config.turnTimeoutMs,
    ...(readRoots !== undefined ? { readRoots } : {}),
  };
  let verdict: Verdict | undefined;
  let lastFailure = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // A retry is a new QA session from the same brief; the old one is not trusted.
      await store.event(run.key, "qa_retry", { round: run.round, attempt, reason: lastFailure });
      const created = await newQaSession(h, qa, run, issue);
      await save({ qaSessionId: created });
      run = { ...run, qaSessionId: created };
    }
    let result: TurnResult;
    try {
      result = await h.turn(run.key, h.need(run.qaSessionId ?? undefined), prompt, turnOptions);
    } catch (error) {
      if (!(error instanceof SessionLost)) throw error;
      // QA keeps nothing worth carrying over: a new one starts from the same brief.
      const created = await newQaSession(h, qa, run, issue);
      await save({ qaSessionId: created });
      run = { ...run, qaSessionId: created };
      result = await h.turn(run.key, created, prompt, turnOptions);
    }
    await store.event(run.key, "qa_turn", {
      round: run.round,
      attempt,
      stop: result.stopReason,
    });

    // Read-only, kept by a check and not by trust: the same commit and the same files as before.
    const after = await h.snapshot(worktree);
    if (before !== after) throw new Blocked("QA 会话修改了工作区，自动化不信任这次审查结果。");

    if (result.timedOut) {
      lastFailure = "QA 会话单回合超时被取消。";
      continue;
    }
    if (result.stopReason !== "end_turn") {
      lastFailure = `QA 会话回合异常结束（${result.stopReason}）。`;
      continue;
    }
    const parsed = parseVerdict(result.text);
    if (parsed === undefined) {
      lastFailure = "QA 没有给出可以读取的审查结论。";
      continue;
    }
    if (!listsWhatWasChecked(result.text)) {
      lastFailure = "QA 没有写明它检查了什么，自动化不接受没有依据的通过。";
      continue;
    }
    verdict = parsed;
    break;
  }
  if (verdict === undefined)
    throw new Blocked(
      `QA 系统故障（不是${qa.subject}问题）：共尝试 ${maxAttempts} 次仍没有可用的审查结论。最后一次：${lastFailure}`,
    );
  return verdict;
}

export async function nextRound(
  h: FlowHost,
  run: RunRecord,
  findings: string,
  save: Save,
  to: "dev" | "research" = "dev",
): Promise<void> {
  await h.d.store.event(run.key, "round_failed", { round: run.round });
  if (run.round >= h.d.config.maxFixRounds) {
    const message = `修复了 ${run.round} 轮仍未通过。最后一次的问题：\n${tail(findings, 1500)}`;
    // Research put back goes on in the research session with these findings; judging the same reply again would
    // only fail again.
    if (to === "research") {
      await save({ findings });
      throw new Blocked(message, "research");
    }
    throw new Blocked(message);
  }
  await save({ phase: to, round: run.round + 1, findings });
}

export async function newQaSession(
  h: FlowHost,
  qa: Flow["qa"],
  run: RunRecord,
  issue: Issue,
): Promise<string> {
  const { config } = h.d;
  const created = await h.d.sessions.create({
    role: qa.role,
    agent: config.qaAgent,
    ...(config.qaModel ? { model: config.qaModel } : {}),
    ...(config.qaEffort ? { effort: config.qaEffort } : {}),
    title: qa.title(run.key),
    // The same name again is the worktree that is there: the daemon reuses it, and files the session under it.
    cwd: config.repoRoot,
    worktree: { base: config.baseRef, name: branchOf(issue.number) },
  });
  return created.sessionId;
}
