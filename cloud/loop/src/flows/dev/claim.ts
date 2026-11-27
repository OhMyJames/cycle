import { Blocked, branchOf, tail } from "../../engine/flow.ts";
import { nextReadyNode, updateGraphNode } from "../../graph.ts";
import type { Issue } from "../../types.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { postGraphReadyComment } from "./graph.ts";
import { freeKb, install, recordInstall } from "./node-modules.ts";

export async function claim(h: FlowHost, run: DevRun, issue: Issue, save: Save): Promise<void> {
  const { config, sessions, store, clock } = h.d;
  let worktree = run.worktree ?? "";
  const graph = await store.loadGraph(run.key);
  const firstNode = graph !== undefined ? nextReadyNode(graph) : undefined;
  // Only a worktree made in this call gets a real install; on resume `bun install` is a no-op.
  const fresh = run.devSessionId === null;
  let createdSessionId: string | null = null;
  if (fresh) {
    // The loop fetches itself: whether the daemon may is undecided (docs/protocol.md, "待定").
    // Fetching needs the remote's credentials; no session has run in the main checkout, so this is safe to give them.
    const fetched = await h.netExec(run.key, "git fetch", () =>
      h.d.workspace.fetchMain(where(h, config.repoRoot)),
    );
    if (fetched.code !== 0) throw new Blocked(`git fetch 失败：${tail(fetched.output)}`);
    const created = await sessions.create({
      role: "dev",
      agent: config.devAgent,
      ...(config.devModel ? { model: config.devModel } : {}),
      ...(config.devEffort ? { effort: config.devEffort } : {}),
      title: firstNode !== undefined ? `[${run.key} · ${firstNode.id}] Dev` : `[${run.key}] Dev`,
      cwd: config.repoRoot,
      worktree: { base: config.baseRef, name: branchOf(issue.number) },
    });
    createdSessionId = created.sessionId;
    await save({
      devSessionId: created.sessionId,
      worktree: created.cwd,
      localBranch: created.branch,
    });
    worktree = created.cwd;
    await store.event(run.key, "dev_session", { new: true });
  }
  // A worktree made now has no node_modules.
  worktree = h.need(worktree === "" ? undefined : worktree);
  const before = fresh ? await freeKb(h, worktree) : undefined;
  await install(h, worktree);
  if (fresh) await recordInstall(h, run.key, worktree, before);

  if (graph !== undefined && firstNode !== undefined) {
    const nowIso = clock.now().toISOString();
    const activeGraph = updateGraphNode(
      graph,
      firstNode.id,
      {
        status: "running",
        sessionId: createdSessionId ?? firstNode.sessionId,
        startedAt: firstNode.startedAt ?? nowIso,
      },
      nowIso,
      firstNode.id,
    );
    await save(
      { phase: "dev", dev: { nodeModulesReleased: false, activeNodeId: firstNode.id } },
      (tx) => {
        tx.saveGraph(activeGraph);
        tx.event(run.key, "graph_node_started", {
          nodeId: firstNode.id,
          origin: firstNode.origin,
          position: firstNode.position,
        });
        postGraphReadyComment(tx, run, issue, activeGraph);
      },
    );
    return;
  }
  // A small item with no graph yet is sized in `graph_plan`: one node, or 2–4 from the read-only planner (CYC-509).
  const sizing = graph === undefined && run.dev.fullFlowDocs.length === 0;
  await save({
    phase: sizing ? "graph_plan" : "dev",
    dev: { nodeModulesReleased: false },
  });
}
