import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
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

const setup = (issues = [issue({ description: readyDescription })], script: Script) => {
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
