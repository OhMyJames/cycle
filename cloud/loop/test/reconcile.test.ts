import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CriteriaBook } from "../src/criteria.ts";
import { openLoopStore, SqliteStore } from "../src/db/store.ts";
import { MAX_ATTEMPTS, marker, Reconciler, writeIntent } from "../src/engine/reconcile.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  makeExec,
  readyDescription,
  type Script,
} from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-reconcile-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-25T00:00:00Z");

const setup = (
  issues = [issue({ description: readyDescription })],
  script: Script,
  world: { prState?: string } = {},
) => {
  const cfg = config({ stateDir: dir });
  const tracker = new FakeTracker(issues);
  const store = SqliteStore.open(dir, () => NOW);
  const pipeline = new Pipeline({
    config: cfg,
    tracker,
    sessions: new FakeSessions(script),
    exec: makeExec({
      fail: new Set(["bun run check"]),
      calls: [],
      dirty: false,
      qaWrites: false,
      headSha: "abc",
      ciResponses: [],
      ciLogs: {},
      prState: world.prState ?? "OPEN",
      prMerge: [["MERGED", "UNKNOWN"]],
      mergeTreeOutput: "",
      ignoredDirs: "",
    }),
    store,
    clock: { now: () => NOW },
    log: () => {},
    env: { PATH: "/bin" },
    sleep: async () => {},
  });
  return { pipeline, tracker, store, cfg };
};

const reconciler = (s: ReturnType<typeof setup>) =>
  new Reconciler(() => ({
    tracker: s.tracker,
    store: s.store,
    config: s.cfg,
    clock: { now: () => NOW },
    log: () => {},
  }));

const pending = (store: SqliteStore) => store.transaction((tx) => tx.pendingIntents());

test("a comment that fails on Blocked is made up on the next step: Blocked, one comment", async () => {
  const s = setup(undefined, { dev: [done(), done(), done(), done()], qa: [] });
  const send = s.tracker.comment.bind(s.tracker);
  let failing = true;
  s.tracker.comment = async (i, text) => {
    if (failing) throw new Error("tracker down");
    return send(i, text);
  };
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect((await s.store.load("CYC-1"))?.phase).toBe("blocked");
  expect(pending(s.store).map((i) => i.kind)).toEqual(["comment", "move"]);
  expect(pending(s.store)[0]?.lastError).toBe("error");
  expect(s.tracker.issues[0]?.columnId).toBe(23);

  failing = false;
  expect((await s.pipeline.step()).status).toBe("idle");
  expect(pending(s.store)).toEqual([]);
  expect(s.tracker.issues[0]?.columnId).toBe(35);
  expect(s.tracker.comments).toHaveLength(1);
  await s.pipeline.step();
  expect(s.tracker.comments).toHaveLength(1);
});

test("a comment already carrying its marker is not sent again; a work item already in place is done", async () => {
  const s = setup([issue({ description: readyDescription, columnId: 35 })], { dev: [], qa: [] });
  const target = s.tracker.issues[0] as ReturnType<typeof issue>;
  s.tracker.threads["CYC-1"] = [
    {
      id: 1,
      replyToId: null,
      authorId: "loop",
      authorName: "loop",
      body: `hello\n\n${marker("c1")}`,
      createdAt: "2026-11-25T00:00:00Z",
    },
  ];
  s.store.transaction((tx) => {
    writeIntent(tx, {
      run: "CYC-1",
      issue: target,
      kind: "comment",
      dedupe: "c1",
      payload: { body: "hello" },
    });
    writeIntent(tx, {
      run: "CYC-1",
      issue: target,
      kind: "move",
      dedupe: "m1",
      payload: { to: "blocked" },
    });
  });
  await reconciler(s).flush();
  expect(pending(s.store)).toEqual([]);
  expect(s.tracker.comments).toEqual([]);
  expect(s.tracker.moves).toEqual([]);
});

test("an intent that fails more than ten times is stuck, with an event and a Notice", async () => {
  const s = setup(undefined, { dev: [], qa: [] });
  const target = s.tracker.issues[0] as ReturnType<typeof issue>;
  s.tracker.comment = async () => {
    throw new Error("secret detail from the tracker");
  };
  s.store.transaction((tx) => {
    writeIntent(tx, {
      run: "CYC-1",
      issue: target,
      kind: "comment",
      dedupe: "c2",
      payload: { body: "x" },
    });
  });
  const r = reconciler(s);
  for (let i = 0; i < MAX_ATTEMPTS; i++) await r.flush();
  expect(pending(s.store)).toHaveLength(1);
  expect(s.store.transaction((tx) => tx.notices())).toEqual([]);
  await r.flush();
  expect(pending(s.store)).toEqual([]);
  const notices = s.store.transaction((tx) => tx.notices());
  expect(notices).toHaveLength(1);
  expect(notices[0]?.kind).toBe("intent_stuck");
  expect((await s.store.events()).some((e) => e.kind === "intent_stuck")).toBe(true);
  const row = s.store.transaction((tx) =>
    tx.db.query("SELECT status, last_error FROM intents").get(),
  );
  expect(row).toEqual({ status: "stuck", last_error: "error" });
  await r.flush();
  expect(s.store.transaction((tx) => tx.notices())).toHaveLength(1);
});

test("the same preflight reason is commented once, however many rounds see it", async () => {
  const s = setup([issue({ description: "no criteria" })], { dev: [], qa: [] });
  expect((await s.pipeline.step()).status).toBe("rejected");
  // A person puts it back without fixing it.
  (s.tracker.issues[0] as ReturnType<typeof issue>).columnId = 22;
  expect((await s.pipeline.step()).status).toBe("rejected");
  expect(s.tracker.comments).toHaveLength(1);
  expect(s.tracker.moves).toEqual(["CYC-1:blocked", "CYC-1:blocked"]);
  expect(s.tracker.issues[0]?.columnId).toBe(35);
});

test("a real run on an empty state directory gets loop.db and can claim a ticket", async () => {
  const store = openLoopStore(dir, () => NOW, false);
  expect(store).toBeInstanceOf(SqliteStore);
  const s = setup(undefined, { dev: [done(), done(), done(), done()], qa: [] });
  const pipeline = new Pipeline({
    config: s.cfg,
    tracker: s.tracker,
    sessions: new FakeSessions({ dev: [done(), done(), done(), done()], qa: [] }),
    exec: makeExec({
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
    }),
    store,
    clock: { now: () => NOW },
    log: () => {},
    env: { PATH: "/bin" },
    sleep: async () => {},
  });
  await pipeline.step().catch(() => {});
  expect((await store.load("CYC-1"))?.key).toBe("CYC-1");
  expect(s.tracker.moves[0]).toBe("CYC-1:inProgress");
});

test("a stale move does not undo what the run has become", async () => {
  const s = setup(undefined, { dev: [], qa: [] });
  const target = s.tracker.issues[0] as ReturnType<typeof issue>;
  target.columnId = 24;
  const base = {
    key: "CYC-1",
    kind: "dev" as const,
    issueId: target.id,
    issueNumber: target.number,
    title: "t",
  };
  void base;
  // A delivered run: a pending move to In Progress is dropped.
  const run = {
    ...(await (async () => {
      const w = setup(undefined, { dev: [done(), done(), done(), done()], qa: [] });
      await w.pipeline.step();
      return (await w.store.load("CYC-1")) as NonNullable<Awaited<ReturnType<SqliteStore["load"]>>>;
    })()),
  };
  s.store.transaction((tx) => {
    tx.save({ ...run, phase: "done" });
    writeIntent(tx, {
      run: "CYC-1",
      issue: target,
      kind: "move",
      dedupe: "stale1",
      payload: { to: "inProgress" },
    });
  });
  await reconciler(s).flush();
  expect(s.tracker.moves).toEqual([]);
  expect(pending(s.store)).toEqual([]);
  // A person resumed: a stale move to Blocked is dropped.
  s.store.transaction((tx) => {
    tx.save({ ...run, phase: "dev" });
    writeIntent(tx, {
      run: "CYC-1",
      issue: target,
      kind: "move",
      dedupe: "stale2",
      payload: { to: "blocked", from: "inProgress" },
    });
  });
  await reconciler(s).flush();
  expect(s.tracker.moves).toEqual([]);
  // Two moves for one run: only the newer is made.
  target.columnId = 23;
  s.store.transaction((tx) => {
    tx.save({ ...run, phase: "blocked" });
    writeIntent(tx, {
      run: "CYC-1",
      issue: target,
      kind: "move",
      dedupe: "m-old",
      payload: { to: "inProgress", from: "todo" },
    });
    writeIntent(tx, {
      run: "CYC-1",
      issue: target,
      kind: "move",
      dedupe: "m-new",
      payload: { to: "blocked", from: "inProgress" },
    });
  });
  await reconciler(s).flush();
  expect(s.tracker.moves).toEqual(["CYC-1:blocked"]);
});

test("a phase write that always fails does not hold the Blocked comment and move", async () => {
  const s = setup(undefined, { dev: [done(), done(), done(), done()], qa: [] });
  s.tracker.failPhase = true;
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.tracker.comments).toHaveLength(1);
  expect(s.tracker.issues[0]?.columnId).toBe(35);
  expect(pending(s.store).every((i) => i.kind === "phase")).toBe(true);
});

const events = (s: ReturnType<typeof setup>, kind: string) =>
  s.store.transaction((tx) => tx.countEvents("CYC-1", kind));

const moveIntent = (
  s: ReturnType<typeof setup>,
  payload: Record<string, unknown>,
  dedupe = "mv",
) => {
  const target = s.tracker.issues[0] as ReturnType<typeof issue>;
  s.store.transaction((tx) => {
    writeIntent(tx, { run: "CYC-1", issue: target, kind: "move", dedupe, payload });
  });
};

test("a move to Blocked that failed is dropped when a person has put the work item in Todo; the loop goes on", async () => {
  const s = setup(undefined, { dev: Array.from({ length: 12 }, () => done()), qa: [] });
  const move = s.tracker.move.bind(s.tracker);
  let failing = true;
  s.tracker.move = async (i, stage) => {
    if (failing && stage === "blocked") throw new Error("tracker timeout");
    return move(i, stage);
  };
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(pending(s.store).map((i) => i.kind)).toEqual(["move"]);
  failing = false;
  const target = s.tracker.issues[0] as ReturnType<typeof issue>;
  target.columnId = 22; // a person puts it back in Todo
  await reconciler(s).flush();
  expect(pending(s.store)).toEqual([]);
  expect(events(s, "intent_overridden")).toBe(1);
  expect(s.tracker.moves).not.toContain("CYC-1:blocked");
  expect(s.tracker.issues[0]?.columnId).toBe(22);
  // The loop then takes it as put back by a person: it resumes.
  await s.pipeline.step();
  expect(events(s, "resumed")).toBe(1);
});

test("a claim move is not made once a person has moved the work item; one still in Todo is moved", async () => {
  const s = setup(undefined, { dev: [], qa: [] });
  const target = s.tracker.issues[0] as ReturnType<typeof issue>;
  target.columnId = 21; // Backlog
  moveIntent(s, { to: "inProgress", from: "todo" });
  await reconciler(s).flush();
  expect(pending(s.store)).toEqual([]);
  expect(s.tracker.moves).toEqual([]);
  expect(events(s, "intent_overridden")).toBe(1);

  target.columnId = 22;
  moveIntent(s, { to: "inProgress", from: "todo" }, "mv2");
  await reconciler(s).flush();
  expect(s.tracker.moves).toEqual(["CYC-1:inProgress"]);
});

test("a rejected-preflight move, and one without `from`, is not made for a work item elsewhere", async () => {
  const s = setup(undefined, { dev: [], qa: [] });
  const target = s.tracker.issues[0] as ReturnType<typeof issue>;
  target.columnId = 23;
  moveIntent(s, { to: "blocked", from: "todo" });
  moveIntent(s, { to: "blocked" }, "old");
  await reconciler(s).flush();
  expect(pending(s.store)).toEqual([]);
  expect(s.tracker.moves).toEqual([]);
  expect(events(s, "intent_overridden")).toBe(1);
  target.columnId = 22;
  moveIntent(s, { to: "blocked", from: "todo" }, "again");
  await reconciler(s).flush();
  expect(s.tracker.moves).toEqual(["CYC-1:blocked"]);
});

test("a PR merged outside the loop: the move fails, the next step does not comment again, and the run is done", async () => {
  const s = setup(undefined, { dev: [], qa: [] }, { prState: "MERGED" });
  await s.store.saveCriteria("CYC-1", CriteriaBook.fromSpecs([{ text: "x", verify: [["true"]] }]));
  await s.store.save({
    key: "CYC-1",
    issueId: 1,
    issueNumber: 1,
    title: "t",
    phase: "ci",
    round: 0,
    worktree: "/tmp/wt",
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "dev-1",
    qaSessionId: "qa-1",
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    kind: "dev",
    startedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    dev: {
      ciRound: 0,
      ciFailedSha: null,
      nodeModulesReleased: false,
      fullFlowDocs: [],
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      prUrl: "https://github.com/o/r/pull/9",
    },
  });
  for (const i of s.tracker.issues) i.columnId = 23;
  const move = s.tracker.move.bind(s.tracker);
  let failing = true;
  s.tracker.move = async (i, stage) => {
    if (failing) throw new Error("tracker down");
    return move(i, stage);
  };
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect((await s.store.load("CYC-1"))?.phase).toBe("done");
  expect(s.tracker.comments).toHaveLength(1);
  expect(pending(s.store).map((i) => i.kind)).toEqual(["move"]);

  failing = false;
  await s.pipeline.step();
  expect(pending(s.store)).toEqual([]);
  expect(s.tracker.issues[0]?.columnId).toBe(34);
  expect(s.tracker.comments).toHaveLength(1);
});

test("flows write the tracker through intents: no direct comment or move, but the planning node", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../src/flows/", import.meta.url).pathname;
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts"));
  const direct: string[] = [];
  for (const f of files) {
    if (f === "plan.ts") continue;
    const text = await readFile(join(root, f), "utf8");
    if (/tracker\s*\.\s*(comment|move)\s*\(/.test(text)) direct.push(f);
  }
  expect(direct).toEqual([]);
});
