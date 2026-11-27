import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { Pipeline } from "../src/pipeline.ts";
import type { Issue } from "../src/types.ts";
import {
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  makeExec,
  PASS,
  readyDescription,
  type Script,
  type World,
} from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BLOCKED = 35;
const CANCELED = 25;
const BACKLOG = 21;

const setup = (issues: Issue[], script: Script) => {
  const cfg = config({ stateDir: dir });
  const tracker = new FakeTracker(issues);
  const sessions = new FakeSessions(script);
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
  const stop = { value: false };
  const clock = { now: () => new Date("2026-11-25T00:00:00Z") };
  const store = SqliteStore.open(cfg.stateDir, () => clock.now());
  const pipeline = new Pipeline({
    config: cfg,
    tracker,
    sessions,
    exec: makeExec(world),
    store,
    clock,
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async () => {},
    stopped: () => stop.value,
  });
  return { pipeline, tracker, sessions, world, store, stop };
};

const ready = (over: Partial<Issue> = {}) => issue({ description: readyDescription, ...over });
const first = (t: FakeTracker) => t.issues[0] as Issue;

/** After the first turn of the Dev session, `after` runs: a person at the board. */
const afterDevTurn = (sessions: FakeSessions, after: () => void) => {
  const turn = sessions.turn.bind(sessions);
  let fired = false;
  sessions.turn = async (...args: Parameters<typeof turn>) => {
    const result = await turn(...args);
    if (!fired) {
      fired = true;
      after();
    }
    return result;
  };
};

for (const [name, column, stateType] of [
  ["Blocked", BLOCKED, "blocked"],
  ["Backlog", BACKLOG, "other"],
  ["Canceled", CANCELED, "canceled"],
] as const) {
  test(`a work item a person moved to ${name} stops the run before verify; put back in Todo it goes on`, async () => {
    const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
    afterDevTurn(s.sessions, () => {
      first(s.tracker).columnId = column;
    });
    const result = await s.pipeline.step();
    expect(result.status).toBe("idle");
    const run = await s.store.load("CYC-1");
    expect(run?.phase).toBe("blocked");
    expect(run?.resumeFrom).toBe("verify");
    expect(run?.blockedReason).toBe("人把工单移出了 Todo/In Progress");
    const events = await s.store.events();
    const stopped = events.filter((e) => e.kind === "stopped_by_person");
    expect(stopped).toHaveLength(1);
    expect(Object.keys(stopped[0] ?? {}).sort()).toEqual(["kind", "run", "stateType", "ts"]);
    expect(s.tracker.comments).toEqual([]);
    expect(s.tracker.moves).toEqual(["CYC-1:inProgress"]);
    expect(s.sessions.created).toEqual(["dev-1"]);
    expect(stopped[0]?.stateType).toBe(stateType);

    // Nothing happens while it stays where the person put it.
    // (Canceled is tidied by the next step, which removes the worktree: that is another path, not tested here.)
    if (column !== CANCELED) expect((await s.pipeline.step()).status).toBe("idle");
    first(s.tracker).columnId = 22;
    const again = await s.pipeline.step();
    expect(again.status).toBe("delivered");
    expect(s.sessions.created.filter((id) => id.startsWith("dev"))).toEqual(["dev-1"]);
    expect((await s.store.events()).some((e) => e.kind === "resumed")).toBe(true);
  });
}

test("the stopped_by_person event carries only the state type", async () => {
  const s = setup([ready()], { dev: [done()], qa: [] });
  afterDevTurn(s.sessions, () => {
    first(s.tracker).columnId = CANCELED;
  });
  await s.pipeline.step();
  const event = (await s.store.events()).find((e) => e.kind === "stopped_by_person");
  expect(event?.stateType).toBe("canceled");
});

test("an auto label taken off also stops the run", async () => {
  const s = setup([ready()], { dev: [done()], qa: [] });
  afterDevTurn(s.sessions, () => {
    first(s.tracker).labelIds = [];
  });
  await s.pipeline.step();
  expect((await s.store.load("CYC-1"))?.phase).toBe("blocked");
});

const blockRun = async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  afterDevTurn(s.sessions, () => {
    first(s.tracker).columnId = BLOCKED;
  });
  await s.pipeline.step();
  return s;
};

test("a blocked run put back in Todo waits for an unfinished blocker, one event per blocker set", async () => {
  const s = await blockRun();
  first(s.tracker).columnId = 22;
  first(s.tracker).blockerColumnIds = [23];
  expect((await s.pipeline.step()).status).toBe("idle");
  expect((await s.pipeline.step()).status).toBe("idle");
  const waiting = () =>
    s.store.events().then((e) => e.filter((x) => x.kind === "resume_waiting_blockers"));
  expect(await waiting()).toHaveLength(1);
  expect((await s.store.load("CYC-1"))?.phase).toBe("blocked");
  expect(s.sessions.created).toEqual(["dev-1"]);

  // A different set is told again; once the blocker is done it goes on.
  first(s.tracker).blockerColumnIds = [23, 22];
  await s.pipeline.step();
  expect(await waiting()).toHaveLength(2);
  first(s.tracker).blockerColumnIds = [24];
  expect((await s.pipeline.step()).status).toBe("delivered");
});

test("blockers that are unknown keep a put-back run waiting", async () => {
  const s = await blockRun();
  first(s.tracker).columnId = 22;
  first(s.tracker).blockerColumnIds = null;
  expect((await s.pipeline.step()).status).toBe("idle");
  expect((await s.store.load("CYC-1"))?.phase).toBe("blocked");
});

test("after a stop signal the phase under way ends and the next one does not begin", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  afterDevTurn(s.sessions, () => {
    s.stop.value = true;
  });
  const result = await s.pipeline.step();
  expect(result.status).toBe("idle");
  const run = await s.store.load("CYC-1");
  expect(run?.phase).toBe("verify");
  expect(s.sessions.created).toEqual(["dev-1"]);
  expect(s.world.calls.some((c) => c.includes("gh pr create"))).toBe(false);

  // Restarted: it goes on from there.
  s.stop.value = false;
  expect((await s.pipeline.step()).status).toBe("delivered");
});
