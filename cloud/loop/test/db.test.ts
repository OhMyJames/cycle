import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CriteriaBook } from "../src/criteria.ts";
import { openDb } from "../src/db/db.ts";
import { ALLOWED, MIGRATIONS, schemaVersion } from "../src/db/schema.ts";
import { openStore, SqliteStore } from "../src/db/store.ts";
import { appendFixNode, appendQaNode, buildGraph, updateGraphNode } from "../src/graph.ts";
import { Pipeline } from "../src/pipeline.ts";
import { RunStore } from "../src/store.ts";
import {
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  makeExec,
  REVIEW_MERGE,
  readyDescription,
  type World,
  WT,
} from "./helpers.ts";

const now = () => new Date("2026-11-26T00:00:00Z");
const tmp = () => mkdtemp(join(tmpdir(), "al-db-"));

test("migrations only add: no DROP or RENAME, each is a table, a column or an index", () => {
  for (const sql of MIGRATIONS) {
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i);
    expect(sql).toMatch(ALLOWED);
  }
  expect(ALLOWED.test("DROP TABLE runs")).toBe(false);
  expect(ALLOWED.test("ALTER TABLE runs RENAME TO x")).toBe(false);
  expect(ALLOWED.test("ALTER TABLE runs ADD COLUMN x TEXT")).toBe(true);
});

test("a new database is at the last version, owner-only, in WAL with foreign keys on", async () => {
  const dir = await tmp();
  const db = openDb(dir);
  expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
    "wal",
  );
  expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
  expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
  db.run("INSERT INTO meta (key, value) VALUES ('x', 'y')");
  expect((await stat(join(dir, "loop.db"))).mode & 0o777).toBe(0o600);
  for (const f of await readdir(dir)) {
    expect((await stat(join(dir, f))).mode & 0o077).toBe(0);
  }
  db.close();
  expect(await readdir(dir).then((n) => n.filter((f) => f.includes(".bak-")))).toEqual([]);
});

test("an upgrade copies the database first, then runs the new migrations in order", async () => {
  const dir = await tmp();
  const first = MIGRATIONS.slice(0, 3);
  openDb(dir, first).close();
  const old = openDb(dir, first);
  old.run(
    "INSERT INTO runs (key, kind, phase, round, issue_id, issue_number, title, started_at, updated_at, state) VALUES ('CYC-1','dev','dev',0,1,1,'t','a','b','{}')",
  );
  old.close();
  const next = [...MIGRATIONS.slice(0, 3), "ALTER TABLE runs ADD COLUMN extra TEXT"];
  const db = openDb(dir, next);
  expect(schemaVersion(db)).toBe(4);
  expect(db.query("SELECT key, extra FROM runs").all()).toEqual([{ key: "CYC-1", extra: null }]);
  db.close();
  const backup = join(dir, "loop.db.bak-3");
  expect((await stat(backup)).mode & 0o777).toBe(0o600);
  // The copy has the row and not the new column.
  const { Database } = await import("bun:sqlite");
  const b = new Database(backup, { readonly: true });
  expect(b.query("SELECT * FROM runs").all()).toHaveLength(1);
  expect(() => b.query("SELECT extra FROM runs").all()).toThrow();
  b.close();
});

test("a database ahead of the code opens as it is, with no copy and no change", async () => {
  const dir = await tmp();
  const ahead = [...MIGRATIONS, "CREATE TABLE later (id INTEGER PRIMARY KEY)"];
  openDb(dir, ahead).close();
  const db = openDb(dir);
  expect(schemaVersion(db)).toBe(ahead.length);
  db.close();
  const store = SqliteStore.open(dir, now);
  await store.event("CYC-1", "x");
  expect((await store.events()).map((e) => e.kind)).toEqual(["x"]);
  store.close();
  expect((await readdir(dir)).filter((f) => f.includes(".bak-"))).toEqual([]);
});

test("a migration that is not an addition is refused before anything is changed", async () => {
  const dir = await tmp();
  expect(() => openDb(dir, ["CREATE TABLE a (x)", "DROP TABLE a"])).toThrow("only add");
});

test("a transaction that fails in one place changes nothing", async () => {
  const store = SqliteStore.open(await tmp(), now);
  expect(() =>
    store.transaction((tx) => {
      tx.event("CYC-1", "before");
      tx.intent("CYC-1", "comment", { text: "hi" }, "d1");
      tx.notice("CYC-1", "n", "text", "n1");
      tx.beat("CYC-1");
      tx.action("CYC-1", "a");
      tx.appendProgress("CYC-1", 0, "p");
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(await store.events()).toEqual([]);
  expect(store.pendingIntents()).toEqual([]);
  expect(store.notices()).toEqual([]);
  expect(store.heartbeats()).toEqual([]);
  expect(await store.readProgress("CYC-1")).toBe("");
  // A database error part-way (a second row with the same dedupe made by a raw insert) undoes the first too.
  expect(() =>
    store.transaction((tx) => {
      tx.event("CYC-1", "kept?");
      tx.db.run("INSERT INTO meta (key, value) VALUES ('a', '1'), ('a', '2')");
    }),
  ).toThrow();
  expect(await store.events()).toEqual([]);
  expect(() => store.transaction(async () => {})).toThrow("async");
  store.transaction((tx) => tx.event("CYC-1", "ok"));
  expect((await store.events()).map((e) => e.kind)).toEqual(["ok"]);
});

test("intents: one per dedupe, pending in order, marked with their attempts", async () => {
  const store = SqliteStore.open(await tmp(), now);
  expect(store.intent("CYC-1", "comment", { a: 1 }, "k1")).toBe(true);
  expect(store.intent("CYC-1", "comment", { a: 2 }, "k1")).toBe(false);
  expect(store.intent("CYC-2", "move", { to: "done" }, "k2")).toBe(true);
  const [one, two] = store.pendingIntents();
  expect(one).toMatchObject({ runKey: "CYC-1", payload: { a: 1 }, status: "pending", attempts: 0 });
  store.markIntent(one?.id ?? 0, "pending", "tracker down");
  store.markIntent(two?.id ?? 0, "done");
  expect(store.pendingIntents().map((i) => [i.dedupe, i.attempts, i.lastError])).toEqual([
    ["k1", 1, "tracker down"],
  ]);
  store.markIntent(one?.id ?? 0, "stuck", "gave up");
  expect(store.pendingIntents()).toEqual([]);
  expect(() => store.markIntent(999, "done")).toThrow("no intent");
});

test("heartbeats, notices and actions", async () => {
  const store = SqliteStore.open(await tmp(), now);
  store.beat("CYC-1");
  store.beat("CYC-1", "ci");
  expect(store.heartbeats()).toEqual([{ runKey: "CYC-1", at: now().toISOString(), detail: "ci" }]);
  expect(store.notice("CYC-1", "blocked", "stuck", "b1")).toBe(true);
  expect(store.notice("CYC-1", "blocked", "stuck again", "b1")).toBe(false);
  expect(store.notices().map((n) => n.text)).toEqual(["stuck"]);
  store.action("CYC-1", "merge", { pr: 3 });
  expect(store.actions("CYC-1")).toMatchObject([{ kind: "merge", data: { pr: 3 } }]);
});

test("openStore: files without a loop.db, the database with one, and it makes none", async () => {
  const dir = await tmp();
  expect(openStore(dir, now)).toBeInstanceOf(RunStore);
  expect(await readdir(dir)).toEqual([]);
  await writeFile(join(dir, "other"), "");
  openDb(dir).close();
  const store = openStore(dir, now);
  expect(store).toBeInstanceOf(SqliteStore);
  (store as SqliteStore).close();
});

test("CI that went green is recorded, but a reopened store asks GitHub again before review", async () => {
  const dir = await tmp();
  const first = SqliteStore.open(dir, now);
  await mkdir(join(dir, "runs", "CYC-1"), { recursive: true });
  await first.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "门禁通过", verify: [["bun", "run", "check"]] }]),
  );
  await first.save({
    key: "CYC-1",
    issueId: 1,
    issueNumber: 1,
    title: "title",
    phase: "review",
    round: 0,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "dev-1",
    qaSessionId: "qa-2",
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    kind: "dev",
    startedAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
    dev: {
      ciRound: 0,
      ciFailedSha: null,
      ciWait: null,
      nodeModulesReleased: false,
      fullFlowDocs: [],
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      prUrl: "https://github.com/o/r/pull/9",
    },
  });
  await first.saveCi("CYC-1", {
    greenSha: "abc",
    checks: [{ command: "bun run check", passed: true }],
  });
  first.close();

  const store = SqliteStore.open(dir, now);
  expect((await store.loadCi("CYC-1")).greenSha).toBe("abc");
  const world: World = {
    fail: new Set(),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["MERGED", "UNKNOWN"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  const pipeline = new Pipeline({
    config: config({ stateDir: dir }),
    tracker: new FakeTracker([issue({ description: readyDescription })]),
    sessions: new FakeSessions({ dev: [], qa: [], review: [done(REVIEW_MERGE)] }),
    exec: makeExec(world),
    store,
    clock: { now },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async () => {},
    stopped: () => false,
  });
  expect((await pipeline.step()).status).toBe("delivered");
  expect(world.calls.filter((c) => c.includes("statusCheckRollup"))).toHaveLength(1);
  store.close();
});

test("CI that went green seen green in this process is not asked again in review", async () => {
  const dir = await tmp();
  const first = SqliteStore.open(dir, now);
  await mkdir(join(dir, "runs", "CYC-1"), { recursive: true });
  await first.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "门禁通过", verify: [["bun", "run", "check"]] }]),
  );
  await first.save({
    key: "CYC-1",
    issueId: 1,
    issueNumber: 1,
    title: "title",
    phase: "ci",
    round: 0,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "dev-1",
    qaSessionId: "qa-2",
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    kind: "dev",
    startedAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
    dev: {
      ciRound: 0,
      ciFailedSha: null,
      ciWait: null,
      nodeModulesReleased: false,
      fullFlowDocs: [],
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      prUrl: "https://github.com/o/r/pull/9",
    },
  });
  await first.saveCi("CYC-1", {
    checks: [{ command: "bun run check", passed: true }],
  });
  first.close();

  const store = SqliteStore.open(dir, now);
  const world: World = {
    fail: new Set(),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["MERGED", "UNKNOWN"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  const pipeline = new Pipeline({
    config: config({ stateDir: dir }),
    tracker: new FakeTracker([issue({ description: readyDescription })]),
    sessions: new FakeSessions({ dev: [], qa: [], review: [done(REVIEW_MERGE)] }),
    exec: makeExec(world),
    store,
    clock: { now },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async () => {},
    stopped: () => false,
  });
  expect((await pipeline.step()).status).toBe("delivered");
  expect(world.calls.filter((c) => c.includes("statusCheckRollup"))).toHaveLength(1);
  store.close();
});

test("graph nodes store role, verdict and report; rows from before read as dev with no verdict", async () => {
  const dir = await tmp();
  const store = SqliteStore.open(dir, now);
  const g = buildGraph(
    "CYC-542",
    "plan_doc",
    [{ id: "n1", title: "A", goal: "a", dependsOn: [], filesHint: [], verify: ["bun run check"] }],
    now().toISOString(),
  );
  const done = updateGraphNode(g, "n1", { status: "passed" }, now().toISOString(), null);
  const { graph: withQa } = appendQaNode(done, {
    commitSha: "deadbeefcafe",
    verify: ["bun run check"],
    nowIso: now().toISOString(),
  });
  const judged = updateGraphNode(
    withQa,
    "qa-1",
    { status: "passed", verdict: "fail", report: "found a bug", commitSha: "deadbeefcafe" },
    now().toISOString(),
    null,
  );
  await store.saveGraph(judged);
  const loaded = await store.loadGraph("CYC-542");
  expect(loaded?.nodes.map((n) => [n.id, n.role, n.verdict, n.report])).toEqual([
    ["n1", "dev", null, null],
    ["qa-1", "qa", "fail", "found a bug"],
  ]);
  store.close();
});

test("an older database gains the role, verdict and report columns with dev defaults", async () => {
  const dir = await tmp();
  const cut = MIGRATIONS.findIndex((m) => /ADD COLUMN role\b/.test(m));
  expect(cut).toBeGreaterThan(0);
  const old = openDb(dir, MIGRATIONS.slice(0, cut));
  old.run(
    `INSERT INTO graph_nodes (run_key, node_id, position, origin, title, goal, depends_on, files_hint, verify, status, updated_at)
     VALUES ('K', 'n1', 0, 'planned', 't', 'g', '[]', '[]', '["bun run check"]', 'passed', 'x')`,
  );
  old.close();
  const db = openDb(dir);
  const row = db.query("SELECT role, verdict, report FROM graph_nodes").get();
  expect(row).toEqual({ role: "dev", verdict: null, report: null });
  db.close();
});

test("Task Graph persists atomically in SqliteStore and supports node updates and fix-* append", async () => {
  const dir = await tmp();
  const store = SqliteStore.open(dir, now);
  expect(await store.loadGraph("CYC-508")).toBeUndefined();

  const initial = buildGraph(
    "CYC-508",
    "plan_doc",
    [
      {
        id: "n1",
        title: "Schema",
        goal: "Add run_graphs and graph_nodes",
        dependsOn: [],
        filesHint: ["cloud/loop/src/db/schema.ts"],
        verify: ["bun test ./cloud/loop/test/db.test.ts"],
      },
      {
        id: "n2",
        title: "Engine",
        goal: "Wire node loop",
        dependsOn: ["n1"],
        filesHint: [],
        verify: ["bun run check"],
      },
    ],
    now().toISOString(),
  );
  await store.saveGraph(initial);

  const loaded = await store.loadGraph("CYC-508");
  expect(loaded?.source).toBe("plan_doc");
  expect(loaded?.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
  expect(loaded?.nodes[1]?.dependsOn).toEqual(["n1"]);

  // Update node + append fix-1 inside one transaction, and verify rollback on failure.
  const passedN1 = updateGraphNode(
    loaded as NonNullable<typeof loaded>,
    "n1",
    { status: "passed", commitSha: "deadbeef", summary: "done schema" },
    now().toISOString(),
    "n2",
  );
  const fixed = appendFixNode(passedN1, {
    title: "修复整单 QA",
    goal: "Fix lint warning",
    verify: ["bun run check"],
    nowIso: now().toISOString(),
  });
  if (!fixed.ok) throw new Error("expected fix node");

  expect(() =>
    store.transaction((tx) => {
      tx.saveGraph(fixed.graph);
      throw new Error("abort");
    }),
  ).toThrow("abort");
  expect((await store.loadGraph("CYC-508"))?.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);

  store.transaction((tx) => {
    tx.saveGraph(fixed.graph);
  });
  const after = await store.loadGraph("CYC-508");
  expect(after?.nodes.map((n) => [n.id, n.origin, n.status])).toEqual([
    ["n1", "planned", "passed"],
    ["n2", "planned", "pending"],
    ["fix-1", "fix", "pending"],
  ]);
  expect(after?.nodes[0]?.commitSha).toBe("deadbeef");
  expect(after?.nodes[2]?.dependsOn).toEqual(["n1"]);
  store.close();
});

test("Task Graph round-trips through RunStore fallback (graph.json)", async () => {
  const dir = await tmp();
  const store = new RunStore(dir, now);
  expect(await store.loadGraph("CYC-508")).toBeUndefined();
  const g = buildGraph(
    "CYC-508",
    "single",
    [
      {
        id: "n1",
        title: "Only step",
        goal: "Implement feature",
        dependsOn: [],
        filesHint: [],
        verify: ["bun run check"],
      },
    ],
    now().toISOString(),
  );
  await store.saveGraph(g);
  const loaded = await store.loadGraph("CYC-508");
  expect(loaded?.nodes[0]?.id).toBe("n1");
});
