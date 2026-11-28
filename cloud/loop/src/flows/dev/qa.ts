import type { CriteriaBook } from "../../criteria.ts";
import { Blocked, branchOf, type Flow, tail } from "../../engine/flow.ts";
import { appendQaNode, type TaskGraph, type TaskNode, updateGraphNode } from "../../graph.ts";
import {
  formatFindings,
  listsWhatWasChecked,
  parseVerdict,
  qaBrief,
  type Verdict,
} from "../../prompts/index.ts";
import type { RunRecord } from "../../store.ts";
import { type Issue, SessionLost, type TurnResult } from "../../types.ts";
import { asDev, type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { docTexts } from "./docs.ts";
import { scheduleGraphFix } from "./graph.ts";

/** The independent QA session of a dev run. */
export const DEV_QA: Flow["qa"] = {
  role: "qa",
  title: (key) => `[${key}] QA`,
  subject: "代码",
  readRoots: () => undefined,
};

/**
 * Finds the QA node this execution belongs to, or appends one: a run that is back in `qa` after a put-back or a
 * crash goes on in its unfinished QA node; a run that arrives from whole-item verify, or one begun before QA nodes
 * existed, gets a new `qa-<n>` after the last Dev node. A run without a graph has none.
 */
async function enterQaNode(
  h: FlowHost,
  run: DevRun,
  save: Save,
): Promise<{ graph: TaskGraph; node: TaskNode } | undefined> {
  const graph = await h.d.store.loadGraph(run.key);
  if (graph === undefined) return undefined;
  const nowIso = h.d.clock.now().toISOString();
  const open = graph.nodes.find(
    (n) =>
      n.id === run.dev.activeNodeId &&
      n.role === "qa" &&
      (n.status === "running" || n.status === "blocked" || n.status === "pending"),
  );
  let base = graph;
  let id: string;
  let startedAt = nowIso;
  if (open !== undefined) {
    id = open.id;
    startedAt = open.startedAt ?? nowIso;
  } else {
    const head = await h.d.workspace.head(where(h, h.need(run.worktree ?? undefined)));
    const checks = (await h.d.store.loadCi(run.key)).checks.map((c) => c.command);
    const appended = appendQaNode(graph, {
      commitSha: head.ok ? head.sha : "",
      verify: checks,
      nowIso,
    });
    base = appended.graph;
    id = appended.node.id;
  }
  const started = updateGraphNode(base, id, { status: "running", startedAt }, nowIso, id);
  await save({ dev: { activeNodeId: id } }, (tx) => {
    tx.saveGraph(started);
    if (open === undefined) tx.event(run.key, "graph_qa_added", { nodeId: id });
  });
  return { graph: started, node: started.nodes.find((n) => n.id === id) as TaskNode };
}

export async function qa(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  book: CriteriaBook,
  save: Save,
): Promise<void> {
  const { config, store, clock } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  const entered = await enterQaNode(h, run, save);
  let graph = entered?.graph;
  const node = entered?.node;
  if (node !== undefined) run = { ...run, dev: { ...run.dev, activeNodeId: node.id } };

  // Every execution is its own QA session; a QA node keeps the id of the last one it used.
  const first = await newQaSession(h, DEV_QA, run, issue);
  const recordSession: Save = async (patch, also) => {
    const sessionId = patch.qaSessionId;
    if (node === undefined || sessionId == null) return save(patch, also);
    graph = updateGraphNode(
      graph as TaskGraph,
      node.id,
      { sessionId },
      clock.now().toISOString(),
      node.id,
    );
    const next = graph;
    return save(patch, (tx) => {
      also?.(tx);
      tx.saveGraph(next);
    });
  };
  // Going on in an open QA node starts a new session: the one it had is replaced, so it is cleaned up later.
  const replaced = node?.sessionId;
  await recordSession({
    qaSessionId: first,
    ...(replaced != null ? { replacedSessions: [...run.replacedSessions, replaced] } : {}),
  });
  run = { ...run, qaSessionId: first };

  const before = await h.snapshot(worktree);
  const diff = await h.d.workspace.diff(where(h, worktree), config.baseRef);
  const checks = (await store.loadCi(run.key)).checks
    .map((c) => `- ${c.command}: ${c.passed ? "passed" : "failed"}`)
    .join("\n");
  const earlier = graph?.nodes
    .filter((n) => n.role === "qa" && n.id !== node?.id && n.report !== null)
    .at(-1)?.report;
  const prompt = qaBrief(
    issue,
    book.items,
    diff,
    checks === "" ? "(none)" : checks,
    run.dev.resolvedFiles,
    await docTexts(h, run, issue, ["Spec", "Design", "Plan"]),
    graph,
    earlier ?? undefined,
  );
  let verdict: Verdict;
  try {
    verdict = await judge(h, DEV_QA, run, issue, worktree, before, prompt, recordSession);
  } catch (error) {
    if (error instanceof Blocked && node !== undefined && graph !== undefined) {
      await store.saveGraph(
        updateGraphNode(
          graph,
          node.id,
          { status: "blocked", lastError: error.message },
          clock.now().toISOString(),
          node.id,
        ),
      );
    }
    throw error;
  }

  // The result of this QA node is written with the change of phase, in one transaction: a crash between the two
  // must not leave a finished node in a run that is still in `qa` (recovery would pay for a second QA session).
  let finished: TaskGraph | undefined;
  if (node !== undefined && graph !== undefined) {
    const head = await h.d.workspace.head(where(h, worktree));
    const nowIso = clock.now().toISOString();
    finished = updateGraphNode(
      graph,
      node.id,
      {
        status: "passed",
        verdict: verdict.pass ? "pass" : "fail",
        commitSha: head.ok ? head.sha : null,
        report: verdict.pass && verdict.findings.length === 0 ? null : formatFindings(verdict),
        lastError: null,
        finishedAt: nowIso,
      },
      nowIso,
      null,
    );
  }
  const persist = (tx: Parameters<NonNullable<Parameters<Save>[1]>>[0]) => {
    if (finished === undefined || node === undefined) return;
    tx.saveGraph(finished);
    tx.event(run.key, "graph_qa_done", {
      nodeId: node.id,
      verdict: verdict.pass ? "pass" : "fail",
    });
  };
  const commit: Save = (patch, also) =>
    save(patch, (tx) => {
      persist(tx);
      also?.(tx);
    });
  if (!verdict.pass) {
    // At the round limit nothing is saved by the fix round: keep the node's result before it blocks.
    if (finished !== undefined && run.round >= config.maxFixRounds) {
      await store.saveGraph(finished);
      await store.event(run.key, "graph_qa_done", { nodeId: node?.id ?? "", verdict: "fail" });
    }
    await nextRound(
      h,
      run,
      `Independent review found:\n${formatFindings(verdict)}`,
      commit,
      "dev",
      {
        fixTitle: "修复独立 QA 审查问题",
        fixVerify: ["bun run check"],
        ...(finished !== undefined ? { graph: finished } : {}),
      },
    );
    return;
  }
  await commit({ phase: "delivering", dev: { activeNodeId: null } });
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
  graphFix?: { fixTitle: string; fixVerify?: string[]; graph?: TaskGraph },
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
  if (to === "dev" && run.kind === "dev") {
    const scheduled = await scheduleGraphFix(h, asDev(run), {
      title: graphFix?.fixTitle ?? `修复整单问题 #${run.round + 1}`,
      findings,
      ...(graphFix?.fixVerify !== undefined ? { verify: graphFix.fixVerify } : {}),
      ...(graphFix?.graph !== undefined ? { graph: graphFix.graph } : {}),
      save,
    });
    if (scheduled) return;
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
    run: run.key,
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
