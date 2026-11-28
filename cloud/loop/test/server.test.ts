import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOOP_MAX_LINE_BYTES,
  LoopApiRunsListResultSchema,
  LoopBoardSchema,
  LoopNoticesListResultSchema,
  LoopProjectsListResultSchema,
  LoopRunDetailSchema,
  LoopStatusResultSchema,
  type LoopTicketAction,
  type LoopTicketChat,
  LoopTicketDetailSchema,
  LoopTicketsActResultSchema,
} from "@cycle/protocol/loop";
import { type ApiTracker, sessionOfId } from "../src/api.ts";
import { loadConfig } from "../src/config.ts";
import { SqliteStore } from "../src/db/store.ts";
import { toIssue } from "../src/plan-mcp.ts";
import { listen } from "../src/server.ts";
import { type RunRecord, RunRecordSchema } from "../src/store.ts";
import type { Issue, IssueComment } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "loop-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let clock = Date.parse("2026-11-26T10:00:00.000Z");
const now = () => new Date(clock);

/** An itsaplan that lives in memory: columns, labels, issues, comments. Label names can be changed under it. */
class FakeTracker implements ApiTracker {
  down = false;
  projectReads = 0;
  labels = [
    { id: 11, name: "auto" },
    { id: 12, name: "待批准" },
    { id: 13, name: "Loop 跳过" },
  ];
  columns = [
    { id: 1, name: "Backlog", stateType: "backlog", position: 0 },
    { id: 2, name: "Todo", stateType: "unstarted", position: 1 },
    { id: 3, name: "Doing", stateType: "started", position: 2 },
    { id: 4, name: "Done", stateType: "completed", position: 5 },
  ];
  issues = new Map<number, Record<string, unknown>>();
  comments: { number: number; text: string }[] = [];
  writes: string[] = [];
  seed(n: number, column: number, labelIds: number[], title = `ticket ${n}`, parent?: string) {
    this.issues.set(n, {
      id: 100 + n,
      sequenceNumber: n,
      title,
      columnId: column,
      labelIds,
      typeId: 20,
      priority: "high",
      ...(parent ? { parentId: 101, parent: { id: 101, identifier: "CYC-1", title: parent } } : {}),
    });
  }
  #check() {
    if (this.down) throw new Error("tracker request timed out");
  }
  async getProject() {
    this.#check();
    this.projectReads++;
    return {
      data: {
        columns: this.columns,
        labels: this.labels,
        issueTypes: [{ id: 20, name: "Feature" }],
      },
    };
  }
  async listRows(columnId: number) {
    this.#check();
    return [...this.issues.values()].filter((i) => i.columnId === columnId);
  }
  async get(number: number): Promise<Issue> {
    this.#check();
    const row = this.issues.get(number);
    if (row === undefined) throw new Error("not found 404");
    return toIssue(row, "CYC");
  }
  async listComments(): Promise<IssueComment[]> {
    this.#check();
    return [
      {
        id: 1,
        replyToId: null,
        authorId: "a",
        authorName: "loop",
        body: "## 拆分结果\n第二行",
        createdAt: "2026-11-26T09:00:00.000Z",
      },
    ];
  }
  async moveToColumn(issue: Pick<Issue, "id">, columnId: number) {
    this.#check();
    this.writes.push(`move ${issue.id} ${columnId}`);
    for (const row of this.issues.values()) if (row.id === issue.id) row.columnId = columnId;
  }
  async setLabelIds(issue: Pick<Issue, "id">, labelIds: number[]) {
    this.#check();
    this.writes.push(`labels ${issue.id} ${labelIds.join(",")}`);
    for (const row of this.issues.values()) if (row.id === issue.id) row.labelIds = labelIds;
  }
  async comment(issue: Issue, text: string) {
    this.#check();
    this.writes.push(`comment ${issue.number}`);
    this.comments.push({ number: issue.number, text });
  }
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

const tracker = new FakeTracker();
let store: SqliteStore;
let socketPath: string;
let server: Awaited<ReturnType<typeof listen>>;
const logs: string[] = [];

beforeAll(async () => {
  const configPath = join(dir, "loop.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      projects: [
        {
          name: "Cycle",
          projectKey: "CYC",
          repo: { url: "https://github.com/clawdot/cycle.git", forge: "github" },
          token: "ghp_SECRET_API",
        },
      ],
    }),
  );
  chmodSync(configPath, 0o600);
  store = SqliteStore.open(join(dir), now);
  socketPath = join(dir, "loop.sock");
  server = await listen(await loadConfig(configPath), socketPath, () => undefined, {
    version: "9.9.9",
    startedAt: new Date("2026-11-26T07:00:00.000Z"),
    now,
    log: (line) => logs.push(line),
    projects: [
      {
        projectKey: "CYC",
        tracker,
        store,
        labels: { auto: "auto", pending: "待批准", skip: "Loop 跳过" },
        workers: 2,
      },
    ],
  });
});
afterAll(() => server.close());

type Reply = {
  result?: unknown;
  error?: { code: number; message: string; data?: { reason?: string } };
};
const call = (method: string, params?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let text = "";
    const timer = setTimeout(() => reject(new Error("no reply")), 3000);
    socket.on("data", (data) => {
      text += data.toString();
      if (text.includes("\n")) {
        clearTimeout(timer);
        socket.end();
        resolve(JSON.parse(text) as Reply);
      }
    });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
  });

describe("loop/ methods answer in their schemas", () => {
  test("projects, board, runs, run, notices, status", async () => {
    tracker.seed(1, 1, [12], "wait for approval");
    tracker.seed(2, 3, [11], "in doing", "the epic");
    tracker.seed(3, 4, [], "done one");
    await store.save(run("CYC-2", { phase: "qa", qaSessionId: "s-qa" }));
    await store.save(run("CYC-9", { phase: "done" }));
    for (let i = 0; i < 60; i++) await store.event("CYC-2", `e${i}`);

    const projects = await call("loop/projects/list");
    expect(LoopProjectsListResultSchema.parse(projects.result).projects).toHaveLength(1);
    expect(JSON.stringify(projects)).not.toContain("ghp_SECRET_API");

    const board = LoopBoardSchema.parse((await call("loop/board/get", { project: "CYC" })).result);
    expect(board.stale).toBe(false);
    expect(board.columns.map((c) => c.stateType)).toEqual([
      "backlog",
      "unstarted",
      "started",
      "completed",
    ]);
    const backlog = board.columns[0]?.cards[0];
    expect(backlog).toMatchObject({
      key: "CYC-1",
      type: "Feature",
      priority: "high",
      labels: ["待批准"],
      pendingReason: "拆分结果",
    });
    expect(backlog?.parent).toBeNull();
    expect(board.columns[2]?.cards[0]?.parent).toEqual({ key: "CYC-1", title: "the epic" });
    expect(board.columns[2]?.cards[0]?.phase).toEqual({
      name: "qa",
      since: "2026-11-26T10:00:00.000Z",
    });

    const all = LoopApiRunsListResultSchema.parse(
      (await call("loop/runs/list", { project: "CYC" })).result,
    );
    expect(all.runs.map((r) => r.key)).toEqual(["CYC-2", "CYC-9"]);
    const active = LoopApiRunsListResultSchema.parse(
      (await call("loop/runs/list", { project: "CYC", filter: { state: "active" } })).result,
    );
    expect(active.runs.map((r) => r.key)).toEqual(["CYC-2"]);

    store.beat("CYC-2", "qa");
    const detail = LoopRunDetailSchema.parse(
      (await call("loop/run/get", { project: "CYC", key: "CYC-2" })).result,
    );
    expect(detail.events).toHaveLength(50);
    expect(detail.events.at(-1)?.kind).toBe("e59");
    expect(detail.sessions).toEqual([{ kind: "qa", id: "s-qa" }]);
    expect(detail.heartbeat?.detail).toBe("qa");
    expect((await call("loop/run/get", { project: "CYC", key: "CYC-77" })).error?.code).toBe(
      -32602,
    );

    const status = LoopStatusResultSchema.parse((await call("loop/status")).result);
    expect(status.version).toBe("9.9.9");
    expect(status.projects[0]).toMatchObject({ project: "CYC", workers: 2 });
    expect(status.projects[0]?.working.map((w) => w.key)).toEqual(["CYC-2"]);

    expect((await call("loop/board/get", { project: "NOPE" })).error?.data?.reason).toBe(
      "unknown_project",
    );
    // Behaviour only: names and counts, nothing from a ticket.
    expect(logs.join("\n")).toContain("loop api loop/board/get cards=3 stale=false");
    expect(logs.join("\n")).not.toContain("wait for approval");
  });
});

describe("board cache", () => {
  test("a failed read returns the last board as stale; a first read that fails is an error", async () => {
    const fresh = new FakeTracker();
    fresh.seed(5, 1, []);
    const { LoopApiHandler } = await import("../src/api.ts");
    const handler = new LoopApiHandler({
      version: "x",
      startedAt: now(),
      now,
      log: () => {},
      projects: [
        {
          projectKey: "CYC",
          tracker: fresh,
          store,
          labels: { auto: "auto", pending: "待批准", skip: "Loop 跳过" },
          workers: 1,
        },
      ],
    });
    fresh.down = true;
    await expect(handler.call("loop/board/get", { project: "CYC" })).rejects.toMatchObject({
      code: -32603,
    });
    fresh.down = false;
    const first = LoopBoardSchema.parse(await handler.call("loop/board/get", { project: "CYC" }));
    expect(first.stale).toBe(false);
    fresh.down = true;
    // Inside 15 seconds the cache answers without a read.
    clock += 10_000;
    const reads = fresh.projectReads;
    expect(
      LoopBoardSchema.parse(await handler.call("loop/board/get", { project: "CYC" })).stale,
    ).toBe(false);
    expect(fresh.projectReads).toBe(reads);
    clock += 10_000;
    const stale = LoopBoardSchema.parse(await handler.call("loop/board/get", { project: "CYC" }));
    expect(stale.stale).toBe(true);
    expect(stale.readAt).toBe(first.readAt);
    expect(stale.columns).toEqual(first.columns);
  });
});

describe("loop/notices/list", () => {
  test("permission waits of Dev, QA and research sessions, and Blocked, carry the session kind and id", async () => {
    const dev = run("CYC-21", { devSessionId: "s-dev", qaSessionId: "s-qa" });
    const research = run("CYC-22", {
      kind: "research",
      phase: "research",
      devSessionId: "s-res",
      qaSessionId: "s-resqa",
      dev: undefined,
      research: {
        questions: [],
        output: null,
        docId: null,
        docLinked: false,
        conclusionDone: false,
        followups: [],
        commented: false,
      },
    });
    const blocked = run("CYC-23", {
      phase: "blocked",
      resumeFrom: "qa",
      blockedReason: "tests keep failing",
      devSessionId: "s-b-dev",
      qaSessionId: "s-b-qa",
    });
    for (const r of [dev, research, blocked]) await store.save(r);
    // What `assemble.ts` does when a session waits: the kind comes from the run, not from the title.
    for (const [r, id] of [
      [dev, "s-dev"],
      [dev, "s-qa"],
      [research, "s-resqa"],
    ] as const) {
      const session = sessionOfId(r, id);
      expect(session).toBeDefined();
      store.notice(r.key, "permission", "wants to run a command", `p:${id}`, session);
    }
    const { notices } = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list", { project: "CYC" })).result,
    );
    const by = (key: string) => notices.filter((n) => n.key === key);
    // One per run: the latest permission wait is the one to show.
    expect(by("CYC-21").map((n) => n.session)).toEqual([{ kind: "qa", id: "s-qa" }]);
    expect(by("CYC-22")[0]).toMatchObject({
      kind: "permission",
      session: { kind: "research_qa", id: "s-resqa" },
    });
    expect(by("CYC-23")[0]).toMatchObject({
      kind: "blocked",
      text: "tests keep failing",
      session: { kind: "qa", id: "s-b-qa" },
    });
    // A run that has moved on takes its permission Notice away.
    clock += 1000;
    await store.save(run("CYC-21", { devSessionId: "s-dev" }));
    const after = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list")).result,
    ).notices;
    expect(after.some((n) => n.key === "CYC-21")).toBe(false);
  });

  test("a supervisor Notice is about the Project: it names no work item", async () => {
    // `assemble.ts` and the updater write it with the project key as the run key.
    store.notice(
      "CYC",
      "supervisor",
      "守护者有新版本，需要你重启它。",
      "supervisor:new-version:CYC:abc",
    );
    const { notices } = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list", { project: "CYC" })).result,
    );
    expect(notices.find((n) => n.kind === "supervisor")).toMatchObject({
      key: null,
      session: null,
    });
  });

  test("a stuck intent is a Notice", async () => {
    store.intent("CYC-30", "move", {}, "stuck-1");
    const intent = store.pendingIntents().find((i) => i.dedupe === "stuck-1");
    store.markIntent(intent?.id ?? 0, "stuck", "tracker said no");
    const { notices } = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list", { project: "CYC" })).result,
    );
    expect(notices.find((n) => n.kind === "intent_stuck")).toMatchObject({
      key: "CYC-30",
      text: expect.stringContaining("tracker said no"),
    });
  });

  test("a stuck intent is one Notice, even when an older version also wrote one to the notices table", async () => {
    store.intent("CYC-31", "comment", {}, "stuck-2");
    const intent = store.pendingIntents().find((i) => i.dedupe === "stuck-2");
    store.markIntent(intent?.id ?? 0, "stuck", "error");
    store.transaction((tx) => tx.notice("CYC-31", "intent_stuck", "old text", "intent_stuck:old"));
    const { notices } = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list", { project: "CYC" })).result,
    );
    expect(notices.filter((n) => n.key === "CYC-31")).toHaveLength(1);
  });
});

describe("loop/intents/retry", () => {
  const stick = (key: string, dedupe: string) => {
    store.intent(key, "comment", { issueId: 1, issueNumber: Number(key.slice(4)) }, dedupe);
    const id = store.pendingIntents().find((i) => i.dedupe === dedupe)?.id ?? 0;
    store.markIntent(id, "stuck", "error");
    return id;
  };
  const retry = (over: Record<string, unknown>) =>
    call("loop/intents/retry", {
      project: "CYC",
      actor: "james",
      actorKind: "desktop",
      ...over,
    });

  test("by id: back to pending with attempts cleared, one action, and the Notice is gone", async () => {
    const id = stick("CYC-70", "r-1");
    const before = store.actions("CYC-70").length;
    expect((await retry({ id })).result).toEqual({ retried: 1 });
    const intent = store.pendingIntents().find((i) => i.id === id);
    expect(intent).toMatchObject({ status: "pending", attempts: 0, nextAt: null });
    const actions = store.actions("CYC-70");
    expect(actions).toHaveLength(before + 1);
    expect(actions.at(-1)?.kind).toBe("intent_retry");
    const { notices } = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list", { project: "CYC" })).result,
    );
    expect(notices.some((n) => n.key === "CYC-70")).toBe(false);
  });

  test("by key: every stuck intent of the ticket, and no other ticket's", async () => {
    stick("CYC-71", "r-2");
    stick("CYC-71", "r-3");
    const other = stick("CYC-72", "r-4");
    expect((await retry({ key: "CYC-71" })).result).toEqual({ retried: 2 });
    expect(store.stuckIntents().some((i) => i.id === other)).toBe(true);
  });

  test("an intent that is not stuck is left alone", async () => {
    store.intent("CYC-73", "comment", {}, "r-5");
    const id = store.pendingIntents().find((i) => i.dedupe === "r-5")?.id ?? 0;
    expect((await retry({ id })).result).toEqual({ retried: 0 });
  });

  test("without actor, or with neither or both of id and key, nothing is changed", async () => {
    const id = stick("CYC-74", "r-6");
    const before = store.actions().length;
    for (const over of [
      { id, actor: undefined },
      { id, actorKind: "stranger" },
      { id, actor: "" },
    ])
      expect((await retry(over)).error).toMatchObject({
        code: -32602,
        data: { reason: "actor_required" },
      });
    for (const over of [{}, { id, key: "CYC-74" }])
      expect((await retry(over)).error).toMatchObject({
        code: -32602,
        data: { reason: "invalid_params" },
      });
    expect((await retry({ id: 999999 })).error).toMatchObject({ data: { reason: "not_found" } });
    expect(store.stuckIntents().some((i) => i.id === id)).toBe(true);
    expect(store.actions().length).toBe(before);
  });
});

describe("loop/tickets/act", () => {
  const act = (over: Record<string, unknown>) =>
    call("loop/tickets/act", {
      project: "CYC",
      verb: "approve",
      keys: ["CYC-40"],
      confirmed: true,
      actor: "james",
      actorKind: "desktop",
      ...over,
    });

  test("approve and return, one result per ticket, a moved one is skipped", async () => {
    tracker.writes.length = 0;
    tracker.comments.length = 0;
    tracker.seed(40, 1, [12, 5]);
    tracker.seed(41, 3, [12]);
    tracker.seed(42, 1, []);
    tracker.seed(43, 1, [12]);
    const reply = await act({ keys: ["CYC-40", "CYC-41", "CYC-42", "CYC-99", "CYC-43"] });
    const { results } = LoopTicketsActResultSchema.parse(reply.result);
    expect(results).toEqual([
      { key: "CYC-40", status: "ok" },
      { key: "CYC-41", status: "skipped", reason: "not_in_backlog" },
      { key: "CYC-42", status: "skipped", reason: "not_pending" },
      { key: "CYC-99", status: "skipped", reason: "not_found" },
      { key: "CYC-43", status: "ok" },
    ]);
    expect(tracker.issues.get(40)).toMatchObject({ columnId: 2, labelIds: [5, 11] });
    expect(tracker.issues.get(41)).toMatchObject({ columnId: 3, labelIds: [12] });
    expect(tracker.comments[0]?.text.endsWith("由 james 在桌面端批准")).toBe(true);

    const back = await act({ verb: "return", keys: ["CYC-44"], reason: "范围太大" });
    expect(LoopTicketsActResultSchema.parse(back.result).results[0]?.status).toBe("skipped");
    tracker.seed(44, 1, [12]);
    const returned = await act({ verb: "return", keys: ["CYC-44"], reason: "范围太大" });
    expect(LoopTicketsActResultSchema.parse(returned.result).results).toEqual([
      { key: "CYC-44", status: "ok" },
    ]);
    expect(tracker.issues.get(44)).toMatchObject({ columnId: 1, labelIds: [13] });
    expect(tracker.comments.at(-1)?.text).toBe("范围太大\n\n由 james 在桌面端退回");

    // One action per ticket asked, including those skipped.
    const actions = store.actions().filter((a) => a.kind.startsWith("ticket_"));
    expect(actions.map((a) => [a.runKey, (a.data as { status: string }).status])).toEqual([
      ["CYC-40", "ok"],
      ["CYC-41", "skipped"],
      ["CYC-42", "skipped"],
      ["CYC-99", "skipped"],
      ["CYC-43", "ok"],
      ["CYC-44", "skipped"],
      ["CYC-44", "ok"],
    ]);
    expect(actions[0]?.data).toMatchObject({ actor: "james", actorKind: "desktop" });
  });

  test("a renamed label is found by its new name without a restart", async () => {
    tracker.seed(50, 1, [12]);
    // The label is renamed in the tracker and given a new id; the Loop's config still says 待批准 / auto.
    tracker.labels = [
      { id: 71, name: "auto" },
      { id: 72, name: "待批准" },
      { id: 73, name: "Loop 跳过" },
    ];
    tracker.seed(51, 1, [72]);
    const { results } = LoopTicketsActResultSchema.parse((await act({ keys: ["CYC-51"] })).result);
    expect(results[0]?.status).toBe("ok");
    expect(tracker.issues.get(51)?.labelIds).toEqual([71]);
    // The label the config names is gone: a fixed word, nothing written.
    tracker.labels = tracker.labels.filter((l) => l.name !== "待批准");
    tracker.writes.length = 0;
    tracker.seed(52, 1, [72]);
    const gone = LoopTicketsActResultSchema.parse((await act({ keys: ["CYC-52"] })).result);
    expect(gone.results).toEqual([{ key: "CYC-52", status: "failed", reason: "label_missing" }]);
    expect(tracker.writes).toEqual([]);
  });

  test("a tracker that is down fails each ticket with a word", async () => {
    tracker.down = true;
    const { results } = LoopTicketsActResultSchema.parse(
      (await act({ keys: ["CYC-1", "CYC-2"] })).result,
    );
    tracker.down = false;
    expect(results).toEqual([
      { key: "CYC-1", status: "failed", reason: "offline" },
      { key: "CYC-2", status: "failed", reason: "offline" },
    ]);
  });

  test("a write without actor or actorKind is refused and nothing is written", async () => {
    tracker.seed(60, 1, [72]);
    tracker.writes.length = 0;
    const before = store.actions().length;
    for (const over of [
      { actor: undefined },
      { actorKind: undefined },
      { actorKind: "stranger" },
      { actor: "" },
    ]) {
      const reply = await act({ keys: ["CYC-60"], ...over });
      expect(reply.error).toMatchObject({ code: -32602, data: { reason: "actor_required" } });
    }
    const unconfirmed = await act({ keys: ["CYC-60"], confirmed: false });
    expect(unconfirmed.error?.data?.reason).toBe("unconfirmed");
    expect(tracker.writes).toEqual([]);
    expect(store.actions().length).toBe(before);
  });

  test("an operator cannot approve: refused, nothing is written", async () => {
    tracker.seed(61, 1, [72]);
    tracker.writes.length = 0;
    const before = store.actions().length;
    const reply = await act({ keys: ["CYC-61"], actorKind: "operator", actor: "ops" });
    expect(reply.error).toMatchObject({ code: -32602, data: { reason: "desktop_only" } });
    expect(tracker.writes).toEqual([]);
    expect(store.actions().length).toBe(before);
    const ok = await act({ keys: ["CYC-61"] });
    expect(ok.error).toBeUndefined();
  });
});

describe("loop/ticket/get and the move verbs", () => {
  const baseColumns = [...tracker.columns];
  const get = (key: string) => call("loop/ticket/get", { project: "CYC", key });
  const detail = async (key: string) => LoopTicketDetailSchema.parse((await get(key)).result);
  const act = (verb: string, keys: string[], over: Record<string, unknown> = {}) =>
    call("loop/tickets/act", {
      project: "CYC",
      verb,
      keys,
      confirmed: false,
      actor: "james",
      actorKind: "desktop",
      ...over,
    });
  const set = (n: number, over: Record<string, unknown>) => {
    tracker.issues.set(n, { ...tracker.issues.get(n), ...over });
  };

  beforeAll(() => {
    tracker.labels = [
      { id: 11, name: "auto" },
      { id: 12, name: "待批准" },
      { id: 13, name: "Loop 跳过" },
    ];
    tracker.columns = [
      // Paused is unstarted too, listed first but later on the board.
      { id: 8, name: "Paused", stateType: "unstarted", position: 2 },
      ...baseColumns,
      { id: 5, name: "Review", stateType: "started", position: 3 },
      { id: 6, name: "Blocked", stateType: "started", position: 4 },
    ];
  });
  afterAll(() => {
    tracker.columns = baseColumns;
  });

  test("actions and chat by column, with and without auto", async () => {
    const cases: [number, number, number[], LoopTicketAction[], LoopTicketChat][] = [
      [70, 1, [], ["approve"], "new"],
      [85, 1, [12], ["approve", "return"], "new"],
      [71, 2, [], ["to_backlog"], "new"],
      [72, 2, [11], ["to_backlog"], "none"],
      [73, 3, [], ["to_backlog", "to_todo"], "watch"],
      [74, 3, [11], [], "watch"],
      [75, 5, [11], [], "none"],
      [76, 6, [11], ["to_backlog", "to_todo"], "none"],
      [77, 4, [], [], "none"],
    ];
    for (const [n, column, labels, actions, chat] of cases) {
      tracker.seed(n, column, labels);
      const ticket = await detail(`CYC-${n}`);
      expect([n, ticket.actions, ticket.chat]).toEqual([n, actions, chat]);
    }
    expect((await detail("CYC-71")).column).toBe("Todo");
    expect((await get("CYC-9999")).error).toMatchObject({
      code: -32602,
      data: { reason: "not_found" },
    });
  });

  test("acceptance and links come out of the body", async () => {
    tracker.seed(78, 1, []);
    set(78, {
      description:
        "说明 https://github.com/a/b/pull/3 和 http://x.test/pull/4\n\n## 验收标准\n1. 第一条\n   续行\n- 第二条\n\n## 其他\n- 不算",
      development: [{ url: "https://gitlab.com/g/p/-/merge_requests/9" }],
    });
    const ticket = await detail("CYC-78");
    expect(ticket.acceptance).toEqual(["第一条 续行", "第二条"]);
    expect(ticket.links.sort()).toEqual([
      "https://github.com/a/b/pull/3",
      "https://gitlab.com/g/p/-/merge_requests/9",
    ]);
    expect(ticket.body).toContain("说明");
    expect(ticket.attention).toBeUndefined();
  });

  test("attention comes from the Loop's run, not comments; a hand-moved Blocked ticket has none", async () => {
    tracker.seed(79, 6, [11]);
    tracker.seed(80, 6, []);
    await store.save(
      run("CYC-79", {
        phase: "blocked",
        blockedReason: "tests fail",
        resumeFrom: "dev",
        devSessionId: "s-dev",
      }),
    );
    expect((await detail("CYC-79")).attention).toEqual({
      kind: "blocked",
      text: "tests fail",
      session: { kind: "dev", id: "s-dev" },
    });
    expect((await detail("CYC-80")).attention).toBeUndefined();
  });

  test("escalated review Notice stays visible while In Review and uncleaned, and drops after cleanup or reopen", async () => {
    tracker.seed(85, 5, [11]);
    tracker.seed(86, 5, [11]);
    tracker.seed(87, 5, [11]);
    await store.save(
      run("CYC-85", {
        phase: "done",
        dev: {
          ciRound: 0,
          ciFailedSha: null,
          nodeModulesReleased: false,
          conflictRound: 0,
          conflict: null,
          resolvedFiles: [],
          reviewSessionId: "s-rev-85",
          reviewCommented: "abc:escalate",
          prUrl: "https://github.com/o/r/pull/85",
          fullFlowDocs: [],
        },
      }),
    );
    store.notice("CYC-85", "review", "older escalated summary", "review:CYC-85:abc:escalate:1");
    clock += 500;
    store.notice(
      "CYC-85",
      "review",
      "needs human sign-off\n- scope question",
      "review:CYC-85:abc:escalate:2",
    );
    // Older escalated run without a stored Notice falls back to reviewCommented.
    await store.save(
      run("CYC-86", {
        phase: "done",
        dev: {
          ciRound: 0,
          ciFailedSha: null,
          nodeModulesReleased: false,
          conflictRound: 0,
          conflict: null,
          resolvedFiles: [],
          reviewSessionId: "s-rev-86",
          reviewCommented: "def:escalate",
          prUrl: "https://github.com/o/r/pull/86",
          fullFlowDocs: [],
        },
      }),
    );
    // Auto-merged run in In Review without a review Notice does not fabricate attention.
    await store.save(
      run("CYC-87", {
        phase: "done",
        dev: {
          ciRound: 0,
          ciFailedSha: null,
          nodeModulesReleased: false,
          conflictRound: 0,
          conflict: null,
          resolvedFiles: [],
          reviewSessionId: "s-rev-87",
          reviewCommented: "ghi:merge",
          prUrl: "https://github.com/o/r/pull/87",
          fullFlowDocs: [],
        },
      }),
    );

    const listed = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list", { project: "CYC" })).result,
    );
    expect(listed.notices.filter((n) => n.key === "CYC-85" && n.kind === "review")).toEqual([
      expect.objectContaining({
        key: "CYC-85",
        kind: "review",
        session: null,
        text: "needs human sign-off\n- scope question",
      }),
    ]);
    expect((await detail("CYC-85")).attention).toEqual({
      kind: "review",
      text: "needs human sign-off\n- scope question",
      prUrl: "https://github.com/o/r/pull/85",
    });
    expect((await detail("CYC-86")).attention).toEqual({
      kind: "review",
      text: "",
      prUrl: "https://github.com/o/r/pull/86",
    });
    expect((await detail("CYC-87")).attention).toBeUndefined();

    // Reopening the run (back to dev) drops the review Notice.
    clock += 1000;
    const reopened85 = await store.load("CYC-85");
    if (reopened85 !== undefined) {
      await store.save({ ...reopened85, phase: "dev" });
    }
    const afterReopen = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list", { project: "CYC" })).result,
    );
    expect(afterReopen.notices.filter((n) => n.key === "CYC-85" && n.kind === "review")).toEqual(
      [],
    );
    expect((await detail("CYC-85")).attention).toBeUndefined();

    // Escalating again brings back a fresh Notice, and cleanup after merge/Done drops it again.
    clock += 1000;
    const redone85 = await store.load("CYC-85");
    if (redone85 !== undefined) {
      await store.save({ ...redone85, phase: "done" });
    }
    store.notice("CYC-85", "review", "second review escalate", "review:CYC-85:abc:escalate:3");
    expect((await detail("CYC-85")).attention).toEqual({
      kind: "review",
      text: "second review escalate",
      prUrl: "https://github.com/o/r/pull/85",
    });

    clock += 1000;
    const current85 = await store.load("CYC-85");
    if (current85 !== undefined) {
      await store.save({ ...current85, cleanedAt: now().toISOString() });
    }
    const afterCleanup = LoopNoticesListResultSchema.parse(
      (await call("loop/notices/list", { project: "CYC" })).result,
    );
    expect(afterCleanup.notices.filter((n) => n.key === "CYC-85" && n.kind === "review")).toEqual(
      [],
    );
    expect((await detail("CYC-85")).attention).toBeUndefined();
  });

  test("to_backlog drops auto, to_todo goes to the first unstarted column, a moved one is skipped", async () => {
    tracker.writes.length = 0;
    tracker.comments.length = 0;
    tracker.seed(81, 6, [11, 5]);
    tracker.seed(82, 3, [5]);
    tracker.seed(83, 3, [11]);
    tracker.seed(84, 4, []);
    const before = store.actions().length;
    const back = LoopTicketsActResultSchema.parse(
      (await act("to_backlog", ["CYC-81", "CYC-84", "CYC-98"], { reason: "先细化" })).result,
    );
    expect(back.results).toEqual([
      { key: "CYC-81", status: "ok" },
      { key: "CYC-84", status: "skipped", reason: "not_allowed" },
      { key: "CYC-98", status: "skipped", reason: "not_found" },
    ]);
    expect(tracker.issues.get(81)).toMatchObject({ columnId: 1, labelIds: [5] });
    expect(tracker.comments).toEqual([
      { number: 81, text: "先细化\n\n由 james 在桌面端退回 Backlog" },
    ]);

    const todo = LoopTicketsActResultSchema.parse(
      (await act("to_todo", ["CYC-82", "CYC-83"], { actorKind: "operator" })).result,
    );
    expect(todo.results).toEqual([
      { key: "CYC-82", status: "ok" },
      { key: "CYC-83", status: "skipped", reason: "not_allowed" },
    ]);
    expect(tracker.issues.get(82)).toMatchObject({ columnId: 2, labelIds: [5] });
    expect(tracker.issues.get(83)).toMatchObject({ columnId: 3 });
    expect(tracker.comments).toHaveLength(1);

    const actions = store.actions().slice(before);
    expect(actions.map((a) => [a.runKey, a.kind, (a.data as { status: string }).status])).toEqual([
      ["CYC-81", "ticket_to_backlog", "ok"],
      ["CYC-84", "ticket_to_backlog", "skipped"],
      ["CYC-98", "ticket_to_backlog", "skipped"],
      ["CYC-82", "ticket_to_todo", "ok"],
      ["CYC-83", "ticket_to_todo", "skipped"],
    ]);
    expect(actions[0]?.data).toMatchObject({ actor: "james", actorKind: "desktop" });
  });
});

describe("the socket", () => {
  test("is 0600", () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  test("a line over 1 MB closes the connection, a line under it is answered", async () => {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => resolve(false), 3000);
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      socket.write(Buffer.alloc(LOOP_MAX_LINE_BYTES + 10, 0x61));
    });
    expect(closed).toBe(true);
    const padded = await call("loop/status", { pad: "x".repeat(900_000) });
    expect(padded.result).toBeDefined();
  });
});
