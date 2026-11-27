import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOOP_BOARD_GET,
  LOOP_GRAPH_ACT,
  LOOP_RUN_GET,
  LOOP_TICKET_GET,
  LoopBoardSchema,
  LoopGraphActResultSchema,
  LoopRunDetailSchema,
  LoopTicketDetailSchema,
} from "@cycle/protocol";
import { type ApiError, type ApiTracker, LoopApiHandler } from "../src/api.ts";
import { SqliteStore } from "../src/db/store.ts";
import type { TaskGraph, TaskNode } from "../src/graph.ts";
import { toIssue } from "../src/plan-mcp.ts";
import { type RunRecord, RunRecordSchema } from "../src/store.ts";
import type { Issue, IssueComment } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "loop-graph-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const now = () => new Date("2026-11-26T10:00:00.000Z");

class Tracker implements ApiTracker {
  issues = [2, 3].map((n) => ({
    id: 100 + n,
    sequenceNumber: n,
    title: `ticket ${n}`,
    columnId: 3,
    labelIds: [],
    typeId: null,
    priority: null,
    description: "",
  }));
  async getProject() {
    return { data: { columns: [{ id: 3, name: "Doing", stateType: "started", position: 0 }] } };
  }
  async listRows() {
    return this.issues;
  }
  async get(number: number): Promise<Issue> {
    const row = this.issues.find((i) => i.sequenceNumber === number);
    if (row === undefined) throw new Error("not found 404");
    return toIssue(row, "CYC");
  }
  async listComments(): Promise<IssueComment[]> {
    return [];
  }
  async moveToColumn() {}
  async setLabelIds() {}
  async comment() {}
}

const run = (key: string, over: Record<string, unknown> = {}): RunRecord =>
  RunRecordSchema.parse({
    key,
    kind: "dev",
    issueId: 1,
    issueNumber: Number(key.split("-")[1]),
    title: `run ${key}`,
    phase: "dev",
    round: 0,
    worktree: null,
    localBranch: null,
    remoteBranch: `auto/${key}`,
    devSessionId: null,
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    startedAt: "2026-11-26T08:00:00.000Z",
    updatedAt: "2026-11-26T08:30:00.000Z",
    dev: {},
    ...over,
  });

const node = (id: string, position: number, over: Partial<TaskNode> = {}): TaskNode => ({
  id,
  position,
  origin: "planned",
  title: `Node ${id}`,
  goal: `Goal ${id}`,
  dependsOn: [],
  filesHint: [],
  verify: ["bun run check"],
  status: "pending",
  sessionId: null,
  commitSha: null,
  rounds: 0,
  lastError: null,
  summary: null,
  startedAt: null,
  finishedAt: null,
  ...over,
});

const graphOf = (nodes: TaskNode[], currentNodeId: string | null = null): TaskGraph => ({
  runKey: "CYC-2",
  source: "auto_plan",
  revision: 1,
  currentNodeId,
  nodes,
  createdAt: "2026-11-26T08:00:00.000Z",
  updatedAt: "2026-11-26T08:00:00.000Z",
});

let store: SqliteStore;
let api: LoopApiHandler;
let n = 0;

beforeEach(async () => {
  store = SqliteStore.open(join(dir, `db-${n++}`), now);
  api = new LoopApiHandler({
    version: "1",
    startedAt: now(),
    now,
    log: () => {},
    projects: [
      {
        projectKey: "CYC",
        tracker: new Tracker(),
        store,
        labels: { auto: "auto", pending: "待批准", skip: "Loop 跳过" },
        workers: 1,
      },
    ],
  });
  await store.save(
    run("CYC-2", { phase: "blocked", blockedReason: "node n2 failed", resumeFrom: "dev" }),
  );
  await store.save(run("CYC-3"));
  await store.saveGraph(
    graphOf(
      [
        node("n3", 2),
        node("n1", 0, { status: "passed" }),
        node("n2", 1, { status: "failed", rounds: 3, lastError: "boom", sessionId: "s-1" }),
        node("n4", 3, { status: "running" }),
        node("n5", 4, { status: "blocked" }),
        node("n6", 5, { status: "skipped" }),
      ],
      "n2",
    ),
  );
});

const act = (over: Record<string, unknown>) =>
  api.call(LOOP_GRAPH_ACT, {
    project: "CYC",
    key: "CYC-2",
    nodeId: "n2",
    action: "retry_node",
    actor: "me",
    actorKind: "desktop",
    ...over,
  });

const reasonOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (error) {
    return (error as ApiError).reason;
  }
  return undefined;
};

describe("graph in reads", () => {
  test("card summary, ticket and run detail carry the graph; none means no field", async () => {
    const board = LoopBoardSchema.parse(await api.call(LOOP_BOARD_GET, { project: "CYC" }));
    const cards = board.columns[0]?.cards ?? [];
    const two = cards.find((c) => c.key === "CYC-2");
    expect(two?.graph).toEqual({
      source: "auto_plan",
      total: 6,
      passed: 1,
      failed: 1,
      blocked: 1,
      running: 1,
      currentNodeId: "n2",
      currentNodeTitle: "Node n2",
    });
    const three = cards.find((c) => c.key === "CYC-3");
    expect(three).toBeDefined();
    expect("graph" in (three ?? {})).toBe(false);

    const ticket = LoopTicketDetailSchema.parse(
      await api.call(LOOP_TICKET_GET, { project: "CYC", key: "CYC-2" }),
    );
    expect(ticket.graph?.nodes.map((x) => x.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    const plain = (await api.call(LOOP_TICKET_GET, { project: "CYC", key: "CYC-3" })) as object;
    expect("graph" in plain).toBe(false);

    const detail = LoopRunDetailSchema.parse(
      await api.call(LOOP_RUN_GET, { project: "CYC", key: "CYC-2" }),
    );
    expect(detail.graph?.nodes.map((x) => x.position)).toEqual([0, 1, 2, 3, 4, 5]);
    const plainRun = (await api.call(LOOP_RUN_GET, { project: "CYC", key: "CYC-3" })) as object;
    expect("graph" in plainRun).toBe(false);
  });
});

describe("loop/graph/act", () => {
  test("retry_node resets the node and puts a blocked run back at graph_plan", async () => {
    const result = LoopGraphActResultSchema.parse(await act({ action: "retry_node" }));
    expect(result.phase).toBe("graph_plan");
    const saved = (await store.loadGraph("CYC-2"))?.nodes.find((x) => x.id === "n2");
    expect(saved).toMatchObject({ status: "pending", rounds: 0, lastError: null, sessionId: null });
    const after = await store.load("CYC-2");
    expect(after).toMatchObject({ phase: "graph_plan", blockedReason: null, resumeFrom: null });
    expect(store.actions("CYC-2").map((a) => a.kind)).toEqual(["graph_retry_node"]);
  });

  test("retry_node works on a blocked node and leaves a run that is not blocked alone", async () => {
    await store.save(run("CYC-2", { phase: "dev" }));
    const result = LoopGraphActResultSchema.parse(await act({ nodeId: "n5" }));
    expect(result.phase).toBe("dev");
    expect((await store.load("CYC-2"))?.phase).toBe("dev");
  });

  test("skip_node marks the node skipped and resumes the run", async () => {
    await act({ action: "skip_node" });
    expect((await store.loadGraph("CYC-2"))?.nodes.find((x) => x.id === "n2")?.status).toBe(
      "skipped",
    );
    expect((await store.load("CYC-2"))?.phase).toBe("graph_plan");
    expect(store.actions("CYC-2").map((a) => a.kind)).toEqual(["graph_skip_node"]);
  });

  test("edit_node changes title, goal and verify on an allowed node", async () => {
    await act({
      action: "edit_node",
      nodeId: "n3",
      title: "New title",
      goal: "New goal",
      verify: ["bun test ./cloud/loop/test/graph.test.ts"],
    });
    expect((await store.loadGraph("CYC-2"))?.nodes.find((x) => x.id === "n3")).toMatchObject({
      title: "New title",
      goal: "New goal",
      verify: ["bun test ./cloud/loop/test/graph.test.ts"],
      status: "pending",
    });
    expect(store.actions("CYC-2").map((a) => a.kind)).toEqual(["graph_edit_node"]);
  });

  test("retry and skip refuse every status but blocked and failed; nothing changes, nothing is audited", async () => {
    const before = JSON.stringify(await store.loadGraph("CYC-2"));
    for (const action of ["retry_node", "skip_node"])
      for (const nodeId of ["n1", "n3", "n4", "n6"])
        expect(await reasonOf(act({ action, nodeId }))).toBe("node_not_allowed");
    expect(JSON.stringify(await store.loadGraph("CYC-2"))).toBe(before);
    expect((await store.load("CYC-2"))?.phase).toBe("blocked");
    expect(store.actions()).toHaveLength(0);
  });

  test("edit_node refuses running, passed and skipped nodes", async () => {
    for (const nodeId of ["n1", "n4", "n6"])
      expect(await reasonOf(act({ action: "edit_node", nodeId, title: "x" }))).toBe(
        "node_not_allowed",
      );
    expect(store.actions()).toHaveLength(0);
  });

  test("edit_node refuses a verify command off the whitelist and changes nothing", async () => {
    const before = JSON.stringify(await store.loadGraph("CYC-2"));
    expect(
      await reasonOf(act({ action: "edit_node", nodeId: "n3", title: "x", verify: ["rm -rf /"] })),
    ).toBe("invalid_verify");
    expect(JSON.stringify(await store.loadGraph("CYC-2"))).toBe(before);
    expect(store.actions()).toHaveLength(0);
  });

  test("unknown project, run, graph, node and bad params are errors", async () => {
    expect(await reasonOf(act({ project: "NOPE" }))).toBe("unknown_project");
    expect(await reasonOf(act({ key: "CYC-99" }))).toBe("unknown_run");
    expect(await reasonOf(act({ key: "CYC-3" }))).toBe("no_graph");
    expect(await reasonOf(act({ nodeId: "zzz" }))).toBe("node_not_found");
    expect(await reasonOf(act({ action: "delete_node" }))).toBe("invalid_params");
    expect(await reasonOf(act({ action: "edit_node" }))).toBe("invalid_params");
    expect(await reasonOf(act({ actor: "" }))).toBe("actor_required");
    expect(store.actions()).toHaveLength(0);
    expect((await store.load("CYC-2"))?.phase).toBe("blocked");
  });
});
