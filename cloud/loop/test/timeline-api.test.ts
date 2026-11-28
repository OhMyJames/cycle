import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP_TIMELINE_LIST, LoopTimelineListResultSchema } from "@cycle/protocol";
import { type ApiError, type ApiTracker, LoopApiHandler } from "../src/api.ts";
import { SqliteStore } from "../src/db/store.ts";
import type { TaskGraph, TaskNode } from "../src/graph.ts";
import { toIssue } from "../src/plan-mcp.ts";
import { type PlanRoundInput, type RunRecord, RunRecordSchema } from "../src/store.ts";
import type { Issue, IssueComment } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "loop-timeline-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const now = () => new Date("2026-11-28T03:00:00.000Z");

class StubTracker implements ApiTracker {
  async getProject() {
    return { data: { columns: [{ id: 3, name: "Doing", stateType: "started", position: 0 }] } };
  }
  async listRows() {
    return [];
  }
  async get(number: number): Promise<Issue> {
    return toIssue(
      {
        id: 100 + number,
        sequenceNumber: number,
        title: `ticket ${number}`,
        columnId: 3,
        labelIds: [],
        typeId: null,
        priority: null,
        description: "",
      },
      "CYC",
    );
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
    title: `Run ${key}`,
    phase: "dev",
    round: 1,
    worktree: "/secret/local/worktree/path",
    localBranch: null,
    remoteBranch: `auto/${key}`,
    devSessionId: null,
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    startedAt: "2026-11-28T01:00:00.000Z",
    updatedAt: "2026-11-28T02:00:00.000Z",
    dev: {},
    ...over,
  });

const node = (id: string, position: number, over: Partial<TaskNode> = {}): TaskNode => ({
  id,
  position,
  origin: "planned",
  role: "dev",
  verdict: null,
  report: null,
  title: `Node ${id}`,
  goal: `Goal ${id}`,
  dependsOn: [],
  filesHint: [],
  verify: ["bun run check"],
  status: "passed",
  sessionId: null,
  commitSha: null,
  rounds: 1,
  lastError: null,
  summary: "Done",
  startedAt: "2026-11-28T01:05:00.000Z",
  finishedAt: "2026-11-28T01:15:00.000Z",
  ...over,
});

const graphOf = (runKey: string, nodes: TaskNode[]): TaskGraph => ({
  runKey,
  source: "plan_doc",
  revision: 1,
  currentNodeId: null,
  nodes,
  createdAt: "2026-11-28T01:00:00.000Z",
  updatedAt: "2026-11-28T02:00:00.000Z",
});

const planOf = (id: string, over: Partial<PlanRoundInput> = {}): PlanRoundInput => ({
  id,
  startedAt: "2026-11-28T00:10:00.000Z",
  updatedAt: "2026-11-28T00:30:00.000Z",
  phase: "finished",
  worktree: "/secret/local/plan/worktree",
  triageSessionId: "sess-triage-1",
  candidates: ["CYC-517", "CYC-518"],
  triage: null,
  queue: [
    {
      key: "CYC-517",
      issueId: 517,
      number: 517,
      hash: "h1",
      state: "done",
      round: 0,
      shapeSessionId: "sess-shape-517",
      qaSessionId: "sess-qa-517",
      stoppedReason: null,
      originalCommented: false,
      rewritten: true,
      created: [],
      pendingCreate: null,
      linked: false,
      notesCommented: true,
      labelled: true,
      output: {
        kind: "rewrite",
        title: "t",
        description: "d",
        notes: "n",
        parts: [],
        epic: null,
      },
    },
  ],
  endedAt: "2026-11-28T00:30:00.000Z",
  ...over,
});

let store: SqliteStore;
let handler: LoopApiHandler;
let logs: string[];
let seq = 0;

beforeEach(() => {
  store = SqliteStore.open(mkdtempSync(join(dir, `case-${++seq}-`)), now);
  logs = [];
  handler = new LoopApiHandler({
    version: "0.3.39",
    startedAt: now(),
    now,
    log: (line) => logs.push(line),
    projects: [
      {
        projectKey: "CYC",
        tracker: new StubTracker(),
        store,
        labels: { auto: "auto", pending: "待批准", skip: "Loop 跳过" },
        workers: 1,
      },
    ],
  });
});

describe("loop/timeline/list (CYC-534)", () => {
  test("aggregates runs (with graph nodes + phase sessions) and plans newest-first without leaking local paths", async () => {
    store.transaction((tx) => {
      tx.put(
        run("CYC-510", {
          phase: "qa",
          devSessionId: "sess-dev-510",
          qaSessionId: "sess-qa-510",
          replacedSessions: ["sess-dev-510-old"],
          updatedAt: "2026-11-28T02:30:00.000Z",
          dev: { prUrl: "https://github.com/clawdot/cycle/pull/10" },
        }),
      );
      tx.saveGraph(
        graphOf("CYC-510", [
          node("n1", 0, { title: "Protocol schema", sessionId: "sess-dev-510", status: "passed" }),
          node("n2", 1, {
            title: "Wire UI",
            sessionId: "sess-dev-510-n2",
            status: "running",
            dependsOn: ["n1"],
          }),
        ]),
      );
      tx.put(
        run("CYC-509", {
          kind: "research",
          phase: "done",
          devSessionId: "sess-res-509",
          updatedAt: "2026-11-28T01:00:00.000Z",
          research: {
            questions: [],
            output: null,
            docId: 1,
            docLinked: true,
            conclusionDone: true,
            followups: [],
            commented: true,
          },
        }),
      );
      tx.putPlan(
        planOf("2026-11-28T00-10-00-000Z", {
          updatedAt: "2026-11-28T01:30:00.000Z",
        }) as ReturnType<typeof tx.putPlan>,
      );
    });

    const raw = await handler.call(LOOP_TIMELINE_LIST, { project: "CYC" });
    const parsed = LoopTimelineListResultSchema.parse(raw);

    expect(parsed.project).toBe("CYC");
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextBefore).toBeNull();
    expect(parsed.entries.map((e) => e.id)).toEqual([
      "run:CYC-510",
      "plan:2026-11-28T00-10-00-000Z",
      "run:CYC-509",
    ]);

    const devRun = parsed.entries[0];
    expect(devRun?.entryKind).toBe("run");
    if (devRun?.entryKind === "run") {
      expect(devRun.graph?.total).toBe(2);
      expect(devRun.graph?.passed).toBe(1);
      // Node n1 already uses sess-dev-510, so devSessionId is not duplicated; QA is appended.
      expect(devRun.steps.map((s) => [s.role, s.sessionId, s.status])).toEqual([
        ["dev", "sess-dev-510", "passed"],
        ["dev", "sess-dev-510-n2", "running"],
        ["qa", "sess-qa-510", "running"],
      ]);
      // A node says which nodes it waits for, by step id; a phase session waits for none.
      expect(devRun.steps.map((s) => s.dependsOn)).toEqual([[], ["node:n1"], []]);
      expect(devRun.prUrl).toBe("https://github.com/clawdot/cycle/pull/10");
    }

    const planEntry = parsed.entries[1];
    expect(planEntry?.entryKind).toBe("plan");
    if (planEntry?.entryKind === "plan") {
      expect(planEntry.triageSessionId).toBe("sess-triage-1");
      expect(planEntry.items[0]?.shapeSessionId).toBe("sess-shape-517");
      expect(planEntry.items[0]?.qaSessionId).toBe("sess-qa-517");
      expect(planEntry.items[0]?.resultKind).toBe("rewrite");
    }

    expect(new Set(parsed.knownSessionIds)).toEqual(
      new Set([
        "sess-dev-510",
        "sess-dev-510-old",
        "sess-dev-510-n2",
        "sess-qa-510",
        "sess-res-509",
        "sess-triage-1",
        "sess-shape-517",
        "sess-qa-517",
      ]),
    );

    // Local worktree paths must never leak into the response or behavior log.
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("/secret/local/");
    expect(logs[0]).toBe("loop api loop/timeline/list entries=3 hasMore=false");
  });

  test("a QA node is a qa step and its session is not listed twice", async () => {
    store.transaction((tx) => {
      tx.put(run("CYC-520", { phase: "delivering", qaSessionId: "sess-qa-520" }));
      tx.saveGraph(
        graphOf("CYC-520", [
          node("n1", 0, { sessionId: "sess-dev-520", status: "passed" }),
          node("qa-1", 1, {
            role: "qa",
            sessionId: "sess-qa-520",
            status: "passed",
            verdict: "pass",
            dependsOn: ["n1"],
          }),
        ]),
      );
    });
    const parsed = LoopTimelineListResultSchema.parse(
      await handler.call(LOOP_TIMELINE_LIST, { project: "CYC" }),
    );
    const entry = parsed.entries.find((e) => e.id === "run:CYC-520");
    if (entry?.entryKind !== "run") throw new Error("expected a run entry");
    expect(entry.steps.map((x) => [x.role, x.sessionId])).toEqual([
      ["dev", "sess-dev-520"],
      ["qa", "sess-qa-520"],
    ]);
    // QA nodes are not progress: the summary counts the Dev node only.
    expect(entry.graph?.total).toBe(1);
    expect(entry.graph?.passed).toBe(1);
  });

  test("paginates deterministically with limit and before cursor (including tied updatedAt)", async () => {
    store.transaction((tx) => {
      tx.put(run("CYC-1", { updatedAt: "2026-11-28T02:00:00.000Z" }));
      tx.put(run("CYC-2", { updatedAt: "2026-11-28T02:00:00.000Z" }));
      tx.put(run("CYC-3", { updatedAt: "2026-11-28T01:00:00.000Z" }));
    });

    const page1 = LoopTimelineListResultSchema.parse(
      await handler.call(LOOP_TIMELINE_LIST, { project: "CYC", limit: 2 }),
    );
    expect(page1.entries.map((e) => e.id)).toEqual(["run:CYC-2", "run:CYC-1"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextBefore).toBe("2026-11-28T02:00:00.000Z|run:CYC-1");

    const page2 = LoopTimelineListResultSchema.parse(
      await handler.call(LOOP_TIMELINE_LIST, {
        project: "CYC",
        limit: 2,
        before: page1.nextBefore ?? undefined,
      }),
    );
    expect(page2.entries.map((e) => e.id)).toEqual(["run:CYC-3"]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextBefore).toBeNull();
  });

  test("rejects unknown project and invalid params", async () => {
    await expect(handler.call(LOOP_TIMELINE_LIST, { project: "NOPE" })).rejects.toMatchObject({
      code: -32602,
      reason: "unknown_project",
    } satisfies Partial<ApiError>);
    await expect(
      handler.call(LOOP_TIMELINE_LIST, { project: "CYC", limit: 0 }),
    ).rejects.toMatchObject({
      code: -32602,
      reason: "invalid_params",
    } satisfies Partial<ApiError>);
  });
});
