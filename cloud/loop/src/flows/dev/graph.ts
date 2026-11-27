// Level-2 Task Graph execution steps inside `devFlow` (CYC-508).
//
// Each Task Node runs in its own fresh Dev session on the Level-1 work item's shared worktree and branch, verifies
// its node-local commands, and commits a checkpoint on pass. Whole-item verify/QA/CI/review failures append a new
// `fix-<n>` node (origin: "fix") at the end of the graph while keeping completed nodes monotonic.

import type { CriteriaBook } from "../../criteria.ts";
import { parseVerify, readSummary, withStrict } from "../../criteria.ts";
import type { StoreOps } from "../../db/store.ts";
import { Blocked, branchOf, NetworkWait, tail } from "../../engine/flow.ts";
import { writeIntent } from "../../engine/reconcile.ts";
import { verifyEnv } from "../../env.ts";
import { summarizeFailure } from "../../failure.ts";
import {
  appendFixNode,
  buildGraph,
  formatGraphTable,
  isGraphComplete,
  nextReadyNode,
  parsePlanGraph,
  type TaskGraph,
  type TaskNode,
  type TaskNodeSpec,
  updateGraphNode,
} from "../../graph.ts";
import { checkPlannerReply, PLANNER_MAX_TURNS, routeSmallItem } from "../../graph-plan.ts";
import {
  bodyChangedNotice,
  continueBrief,
  graphPlannerBrief,
  graphPlannerFixBrief,
  nodeDevBrief,
  nodeFixBrief,
  nodeHandoffBrief,
  parseProgress,
  parseQuestion,
} from "../../prompts/index.ts";
import type { RunPatch } from "../../store.ts";
import {
  type Exec,
  type ExecResult,
  type Issue,
  SessionLost,
  type TurnResult,
} from "../../types.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { docTexts } from "./docs.ts";
import { restoreNodeModules } from "./node-modules.ts";

/** Queues a one-way, idempotent summary comment on the Level-1 tracker issue when a multi-node graph begins. */
export const postGraphReadyComment = (
  tx: StoreOps,
  run: Pick<DevRun, "key">,
  issue: Issue,
  graph: TaskGraph,
): void => {
  if (graph.nodes.length <= 1) return;
  writeIntent(tx, {
    run: run.key,
    issue,
    kind: "comment",
    dedupe: `graph:${run.key}:plan:${graph.revision}`,
    payload: {
      body: `Loop 已按执行图（${graph.nodes.length} 个二级节点）开始执行：\n\n${formatGraphTable(graph)}`,
    },
  });
};

/** Ensures a Dev session exists for `node` on the shared worktree, creating a fresh one when entering a new node. */
const ensureNodeSession = async (
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  graph: TaskGraph,
  node: TaskNode,
  save: Save,
): Promise<{ graph: TaskGraph; node: TaskNode; sessionId: string }> => {
  if (node.sessionId !== null) return { graph, node, sessionId: node.sessionId };
  const { config } = h.d;
  const created = await h.d.sessions.create({
    role: "dev",
    agent: config.devAgent,
    ...(config.devModel ? { model: config.devModel } : {}),
    ...(config.devEffort ? { effort: config.devEffort } : {}),
    title: `[${run.key} · ${node.id}] Dev`,
    cwd: config.repoRoot,
    worktree: { base: config.baseRef, name: branchOf(issue.number) },
  });
  const nowIso = h.d.clock.now().toISOString();
  const nextGraph = updateGraphNode(
    graph,
    node.id,
    {
      status: "running",
      sessionId: created.sessionId,
      startedAt: node.startedAt ?? nowIso,
    },
    nowIso,
    node.id,
  );
  await save({ devSessionId: created.sessionId, dev: { activeNodeId: node.id } }, (tx) => {
    tx.saveGraph(nextGraph);
    tx.event(run.key, "graph_node_started", {
      nodeId: node.id,
      origin: node.origin,
      position: node.position,
    });
  });
  const nextNode = nextGraph.nodes.find((n) => n.id === node.id) as TaskNode;
  return { graph: nextGraph, node: nextNode, sessionId: created.sessionId };
};

/**
 * 小档 sizing (CYC-509): a simple Bug or a one-package Feature with few criteria goes straight to one node; anything
 * else gets a read-only planner session that must return 2–4 valid nodes. Returns the new graph (first node still
 * `pending`, reusing the claim's Dev session), or undefined for the single-node path. Never blocks the run.
 */
async function sizeSmallItem(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
): Promise<TaskGraph | undefined> {
  const { config, store, clock } = h.d;
  const route = routeSmallItem(issue, config);
  if (route.route === "single") {
    await store.event(run.key, "graph_plan_single", { reason: route.reason });
    return undefined;
  }
  const worktree = h.need(run.worktree ?? undefined);
  let specs: TaskNodeSpec[] | undefined;
  let failure = "";
  let turns = 0;
  try {
    const created = await h.d.sessions.create({
      role: "graph_planner",
      agent: config.devAgent,
      ...(config.devModel ? { model: config.devModel } : {}),
      ...(config.devEffort ? { effort: config.devEffort } : {}),
      title: `[${run.key}] Graph Planner`,
      cwd: config.repoRoot,
      worktree: { base: config.baseRef, name: branchOf(issue.number) },
    });
    let prompt = graphPlannerBrief(issue);
    while (turns < PLANNER_MAX_TURNS) {
      turns++;
      const result = await h.turn(run.key, created.sessionId, prompt, {
        role: "graph_planner",
        worktree,
        timeoutMs: config.turnTimeoutMs,
      });
      await store.event(run.key, "graph_planner_turn", { turn: turns, stop: result.stopReason });
      if (result.timedOut || result.stopReason !== "end_turn") {
        failure = `planner turn ended abnormally (${result.timedOut ? "timeout" : result.stopReason})`;
        break;
      }
      const checked = await checkPlannerReply(result.text, worktree);
      if (checked.ok) {
        specs = checked.specs;
        break;
      }
      failure = checked.reasons.join(" | ");
      prompt = graphPlannerFixBrief(checked.reasons, turns + 1, PLANNER_MAX_TURNS);
    }
  } catch (error) {
    if (error instanceof NetworkWait) throw error;
    failure = `planner failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (specs === undefined) {
    await store.event(run.key, "graph_plan_fallback", {
      reason: tail(failure, 400),
      turns,
      criteria: route.criteria,
      packages: route.packages,
    });
    return undefined;
  }
  const nowIso = clock.now().toISOString();
  const built = buildGraph(run.key, "auto_planner", specs, nowIso);
  const first = built.nodes[0] as TaskNode;
  // The first node continues in the Dev session the claim already made on this worktree.
  const planned = updateGraphNode(built, first.id, { sessionId: run.devSessionId }, nowIso, null);
  await store.event(run.key, "graph_plan_auto", {
    nodes: planned.nodes.length,
    turns,
    criteria: route.criteria,
    packages: route.packages,
  });
  return planned;
}

/**
 * `graph_plan` phase: loads (or initializes from Plan docs) the run's Task Graph and advances to the first ready
 * node, or directly to whole-item `verify` if every node is already complete.
 */
export async function graphPlan(h: FlowHost, run: DevRun, issue: Issue, save: Save): Promise<void> {
  const { store, clock } = h.d;
  let graph = await store.loadGraph(run.key);
  if (graph === undefined && run.dev.fullFlowDocs.length > 0) {
    const texts = await docTexts(h, run, issue, ["Plan"]);
    const parsed = texts !== undefined ? parsePlanGraph(texts.plan) : { found: false as const };
    if (parsed.found && parsed.ok) {
      graph = buildGraph(run.key, "plan_doc", parsed.specs, clock.now().toISOString());
    }
  }
  if (graph === undefined && run.dev.fullFlowDocs.length === 0) {
    graph = await sizeSmallItem(h, run, issue);
  }
  if (graph === undefined) {
    await save({ phase: "dev", dev: { activeNodeId: null } });
    return;
  }
  if (isGraphComplete(graph)) {
    const doneGraph: TaskGraph = {
      ...graph,
      currentNodeId: null,
      updatedAt: clock.now().toISOString(),
    };
    await save({ phase: "verify", dev: { activeNodeId: null } }, (tx) => {
      tx.saveGraph(doneGraph);
    });
    return;
  }
  const active =
    graph.currentNodeId !== null
      ? graph.nodes.find(
          (n) =>
            n.id === graph.currentNodeId &&
            (n.status === "running" || n.status === "blocked" || n.status === "pending"),
        )
      : undefined;
  const target = active ?? nextReadyNode(graph);
  if (target === undefined) {
    throw new Blocked("执行图没有可执行的就绪节点，请检查节点依赖或状态。");
  }
  const nowIso = clock.now().toISOString();
  const nextGraph = updateGraphNode(
    graph,
    target.id,
    { status: "running", startedAt: target.startedAt ?? nowIso },
    nowIso,
    target.id,
  );
  await save({ phase: "dev", dev: { activeNodeId: target.id } }, (tx) => {
    tx.saveGraph(nextGraph);
    postGraphReadyComment(tx, run, issue, nextGraph);
  });
}

/**
 * Executes one Dev turn for the currently active Level-2 Task Node in its own fresh session on the shared worktree.
 */
export async function nodeDev(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  book: CriteriaBook,
  byPerson: boolean,
  save: Save,
): Promise<void> {
  const { config, store, clock } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  const nodeId = h.need(run.dev.activeNodeId ?? undefined);
  await restoreNodeModules(h, run, worktree, save);

  let graph = await store.loadGraph(run.key);
  if (graph === undefined) {
    throw new Blocked(`找不到执行图（节点 ${nodeId}），请检查运行状态。`);
  }
  let node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined) {
    throw new Blocked(`执行图中不存在节点 ${nodeId}。`);
  }

  let sessionId: string;
  ({ graph, node, sessionId } = await ensureNodeSession(h, run, issue, graph, node, save));

  const gitLog = await h.d.workspace.log(where(h, worktree), config.baseRef);
  const fullDocs =
    run.dev.fullFlowDocs.length > 0 ? await docTexts(h, run, issue, ["Spec", "Design"]) : undefined;
  const notice = run.dev.bodyChanged === true ? bodyChangedNotice(issue, book.items) : "";
  const prompt =
    notice +
    (node.lastError !== null
      ? nodeFixBrief(node, node.rounds, node.lastError)
      : byPerson
        ? continueBrief(issue, true)
        : nodeDevBrief(issue, graph, node, gitLog, fullDocs));

  let result: TurnResult;
  try {
    result = await h.turn(run.key, sessionId, prompt, {
      role: "dev",
      worktree,
      timeoutMs: config.turnTimeoutMs,
    });
  } catch (error) {
    if (!(error instanceof SessionLost)) throw error;
    const created = await h.d.sessions.create({
      role: "dev",
      agent: config.devAgent,
      ...(config.devModel ? { model: config.devModel } : {}),
      ...(config.devEffort ? { effort: config.devEffort } : {}),
      title: `[${run.key} · ${node.id}] Dev`,
      cwd: config.repoRoot,
      worktree: { base: config.baseRef, name: branchOf(issue.number) },
    });
    const nowIso = clock.now().toISOString();
    graph = updateGraphNode(graph, nodeId, { sessionId: created.sessionId }, nowIso, nodeId);
    node = graph.nodes.find((n) => n.id === nodeId) as TaskNode;
    const savedGraph = graph;
    await save(
      {
        devSessionId: created.sessionId,
        replacedSessions: [...run.replacedSessions, sessionId],
      },
      (tx) => {
        tx.saveGraph(savedGraph);
        tx.event(run.key, "dev_session", { replaced: true, nodeId });
      },
    );
    sessionId = created.sessionId;
    result = await h.turn(
      run.key,
      sessionId,
      notice + nodeHandoffBrief(issue, graph, node, gitLog, fullDocs),
      { role: "dev", worktree, timeoutMs: config.turnTimeoutMs },
    );
  }

  if (run.dev.bodyChanged === true) await save({ dev: { bodyChanged: false } });
  await store.event(run.key, "dev_turn", {
    round: run.round,
    nodeId: node.id,
    nodeRound: node.rounds,
    stop: result.stopReason,
  });
  h.mustHaveEnded(`Dev (${node.id})`, result);

  const progressText = parseProgress(result.text) ?? "(the turn ended with no progress block)";
  await store.appendProgress(run.key, run.round, `[${node.id}] ${progressText}`);

  const question = parseQuestion(result.text);
  if (question !== undefined) {
    await h.d.workspace.checkpoint(
      where(h, worktree),
      `${run.key} [${node.id}]: checkpoint (auto-loop)`,
    );
    const nowIso = clock.now().toISOString();
    const blockedGraph = updateGraphNode(
      graph,
      node.id,
      { status: "blocked", summary: progressText },
      nowIso,
      node.id,
    );
    await save({ findings: null }, (tx) => {
      tx.saveGraph(blockedGraph);
      tx.event(run.key, "dev_asked", { chars: question.length, nodeId: node.id });
    });
    throw new Blocked("等人决定", "dev", {
      comment: `Loop 在执行节点 \`${node.id}\`（${node.title}）时需要你决定：\n\n${question}\n\n回答写在评论里，然后把工单放回 Todo`,
      notice: `节点 ${node.id} 需要人决定：${question}`,
      session: { kind: "dev", id: sessionId },
    });
  }

  await h.d.workspace.checkpoint(where(h, worktree), `${run.key} [${node.id}]: ${node.title}`);
  const nowIso = clock.now().toISOString();
  const updatedGraph = updateGraphNode(graph, node.id, { summary: progressText }, nowIso, node.id);
  await save({ phase: "verify", findings: null }, (tx) => {
    tx.saveGraph(updatedGraph);
  });
}

/**
 * Runs node-local verification commands for the active Task Node. On pass, records the checkpoint commit SHA and
 * advances to the next ready node, or transitions to whole-item `verify` (`activeNodeId = null`) once complete.
 */
export async function nodeVerify(h: FlowHost, run: DevRun, save: Save): Promise<void> {
  const { config, store, clock } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  const nodeId = h.need(run.dev.activeNodeId ?? undefined);
  await restoreNodeModules(h, run, worktree, save);

  const graph = await store.loadGraph(run.key);
  if (graph === undefined) {
    throw new Blocked(`找不到执行图（节点 ${nodeId}），请检查运行状态。`);
  }
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined) {
    throw new Blocked(`执行图中不存在节点 ${nodeId}。`);
  }

  const results = new Map<string, ExecResult>();
  const exec: Exec = async (argv, options) => {
    const key = argv.join(" ");
    const known = results.get(key);
    if (known !== undefined) return known;
    let done = await h.d.exec(argv, options);
    for (
      let attempt = 1;
      attempt <= config.maxVerifyRetries && done.code !== 0 && !done.timedOut;
      attempt++
    ) {
      done = await h.d.exec(argv, options);
      await store.event(run.key, "verify_retried", {
        round: run.round,
        nodeId: node.id,
        command: key,
        attempt,
        passed: done.code === 0 && !done.timedOut,
      });
    }
    results.set(key, done);
    return done;
  };

  const env = verifyEnv(h.d.env);
  const failures: string[] = [];
  for (const rawCommand of node.verify) {
    const parsed = parseVerify(rawCommand);
    if (parsed === undefined) {
      failures.push(`Disallowed node verify command: \`${rawCommand}\``);
      break;
    }
    const argv = withStrict(parsed);
    const done = await exec(argv, { cwd: worktree, env, timeoutMs: config.commandTimeoutMs });
    let failed = done.code !== 0 || done.timedOut;
    let note = "";
    if (!failed && argv[0] === "bun" && argv[1] === "test") {
      const { pass, skip } = readSummary(done.output);
      if (pass === undefined) {
        failed = true;
        note = "no test summary in the output: cannot tell that any test ran\n";
      } else if (pass === 0) {
        failed = true;
        note = `${pass} pass, ${skip} skip: no test passed\n`;
      }
    }
    if (failed) {
      const outcome = done.timedOut ? "timed out" : `exit ${done.code}`;
      failures.push(
        `\`${argv.join(" ")}\` ${outcome}:\n${note}${summarizeFailure(done.output).trim()}`,
      );
      break;
    }
  }

  const nowIso = clock.now().toISOString();
  if (failures.length > 0) {
    const errorText = failures.join("\n\n");
    const nextRounds = node.rounds + 1;
    const limit = Math.max(1, config.maxFixRounds);
    if (nextRounds >= limit) {
      const blockedGraph = updateGraphNode(
        graph,
        node.id,
        { status: "blocked", rounds: nextRounds, lastError: errorText },
        nowIso,
        node.id,
      );
      await store.saveGraph(blockedGraph);
      await store.event(run.key, "graph_node_failed", {
        nodeId: node.id,
        rounds: nextRounds,
        blocked: true,
      });
      throw new Blocked(
        `节点 \`${node.id}\`（${node.title}）局部验证失败 ${nextRounds} 次达到上限：\n${tail(errorText, 1200)}`,
        "dev",
      );
    }
    const retryGraph = updateGraphNode(
      graph,
      node.id,
      { status: "running", rounds: nextRounds, lastError: errorText },
      nowIso,
      node.id,
    );
    await save({ phase: "dev" }, (tx) => {
      tx.saveGraph(retryGraph);
      tx.event(run.key, "graph_node_failed", {
        nodeId: node.id,
        rounds: nextRounds,
        blocked: false,
      });
    });
    return;
  }

  await h.d.workspace.checkpoint(where(h, worktree), `${run.key} [${node.id}]: ${node.title}`);
  const head = await h.d.workspace.head(where(h, worktree));
  const commitSha = head.ok ? head.sha : null;

  let nextGraph = updateGraphNode(
    graph,
    node.id,
    {
      status: "passed",
      commitSha,
      lastError: null,
      finishedAt: nowIso,
    },
    nowIso,
    null,
  );

  const next = nextReadyNode(nextGraph);
  if (next !== undefined) {
    nextGraph = updateGraphNode(
      nextGraph,
      next.id,
      { status: "running", startedAt: next.startedAt ?? nowIso },
      nowIso,
      next.id,
    );
    await save({ phase: "dev", findings: null, dev: { activeNodeId: next.id } }, (tx) => {
      tx.saveGraph(nextGraph);
      tx.event(run.key, "graph_node_passed", {
        nodeId: node.id,
        origin: node.origin,
        rounds: node.rounds,
      });
    });
    return;
  }

  if (!isGraphComplete(nextGraph)) {
    await store.saveGraph(nextGraph);
    throw new Blocked("执行图存在未完成但无法就绪的节点，请检查节点状态。");
  }

  // All Task Nodes passed -> enter whole-item verify (activeNodeId = null).
  await save({ phase: "verify", findings: null, dev: { activeNodeId: null } }, (tx) => {
    tx.saveGraph(nextGraph);
    tx.event(run.key, "graph_node_passed", {
      nodeId: node.id,
      origin: node.origin,
      rounds: node.rounds,
    });
    tx.event(run.key, "graph_completed", { nodes: nextGraph.nodes.length });
  });
}

/**
 * Appends a `fix-<n>` node (`origin: "fix"`) at the tail of a Graph run when whole-item verify, QA, CI, or PR review
 * rejects the branch, then routes execution back to `dev` on that fix node. Returns `false` when the run has no graph
 * so callers can fall back to the legacy single-session fix round.
 */
export async function scheduleGraphFix(
  h: FlowHost,
  run: DevRun,
  input: {
    title: string;
    findings: string;
    verify?: string[];
    save: Save;
    extraPatch?: RunPatch;
  },
): Promise<boolean> {
  const graph = await h.d.store.loadGraph(run.key);
  if (graph === undefined) return false;
  const nowIso = h.d.clock.now().toISOString();
  const appended = appendFixNode(graph, {
    title: input.title,
    goal: input.findings,
    verify: input.verify ?? ["bun run check"],
    nowIso,
  });
  if (!appended.ok) throw new Blocked(appended.reason);

  const activeGraph = updateGraphNode(
    appended.graph,
    appended.node.id,
    { status: "running", startedAt: nowIso },
    nowIso,
    appended.node.id,
  );
  await input.save(
    {
      ...input.extraPatch,
      phase: "dev",
      round: run.round + 1,
      findings: input.findings,
      dev: { ...input.extraPatch?.dev, activeNodeId: appended.node.id },
    },
    (tx) => {
      tx.saveGraph(activeGraph);
      tx.event(run.key, "graph_fix_added", {
        nodeId: appended.node.id,
        round: run.round + 1,
        totalNodes: activeGraph.nodes.length,
      });
    },
  );
  return true;
}

/** On human put-back after Blocked, resets a blocked/failed active node so Dev resumes cleanly in its preserved session. */
export async function resetBlockedNodeOnResume(h: FlowHost, run: DevRun): Promise<void> {
  const nodeId = run.dev.activeNodeId;
  if (nodeId == null) return;
  const graph = await h.d.store.loadGraph(run.key);
  if (graph === undefined) return;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return;
  if (node.status === "blocked" || node.status === "failed") {
    const nowIso = h.d.clock.now().toISOString();
    const next = updateGraphNode(
      graph,
      node.id,
      { status: "running", rounds: 0, lastError: null },
      nowIso,
      node.id,
    );
    await h.d.store.saveGraph(next);
  }
}
