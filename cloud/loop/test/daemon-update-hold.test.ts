// While the daemon has a new version of itself waiting to switch to once idle, the loop takes no new work item, so the
// daemon gets to idle; once it has switched the loop takes work again (docs/protocol.md §3, CYC-538).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  makeExec,
  readyDescription,
  type World,
} from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-daemon-update-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a daemon update waiting holds new work items back, and they are taken once it has switched", async () => {
  const cfg = config({ stateDir: dir });
  const tracker = new FakeTracker([issue({ description: readyDescription })]);
  const sessions = new FakeSessions({
    dev: [done("<progress>done: x\nnext: y</progress>")],
    qa: [],
  });
  let pending = true;
  sessions.updatePending = async () => (pending ? "0.3.1060" : null);
  const world: World = {
    fail: new Set(),
    calls: [],
    dirty: true,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["MERGED", "UNKNOWN"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  const clock = { now: () => new Date("2026-11-25T00:00:00Z") };
  const store = SqliteStore.open(cfg.stateDir, () => clock.now());
  const logged: string[] = [];
  const pipeline = new Pipeline({
    config: cfg,
    tracker,
    sessions,
    exec: makeExec(world),
    store,
    clock,
    log: (line) => logged.push(line),
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async () => {},
    stopped: () => false,
  });
  expect(await pipeline.step()).toEqual({ status: "idle" });
  expect(await store.load("CYC-1")).toBeUndefined();
  expect(sessions.created).toEqual([]);
  expect(logged.some((l) => l.includes("daemon update waiting"))).toBe(true);

  pending = false;
  // The run goes on past the claim; only the claim matters here.
  await pipeline.step().catch(() => undefined);
  expect(await store.load("CYC-1")).toBeDefined();
  expect(logged.some((l) => l.includes("daemon update done"))).toBe(true);
});

test("a daemon that cannot say is taken as having nothing waiting", async () => {
  const sessions = new FakeSessions({ dev: [], qa: [] });
  sessions.updatePending = async () => {
    throw new Error("method not found");
  };
  const cfg = config({ stateDir: dir });
  const store = SqliteStore.open(cfg.stateDir, () => new Date("2026-11-25T00:00:00Z"));
  const pipeline = new Pipeline({
    config: cfg,
    tracker: new FakeTracker([]),
    sessions,
    exec: makeExec({
      fail: new Set(),
      calls: [],
      dirty: true,
      qaWrites: false,
      headSha: "abc",
      ciResponses: [],
      ciLogs: {},
      prState: "OPEN",
      prMerge: [],
      mergeTreeOutput: "",
      ignoredDirs: "",
    }),
    store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin" },
    sleep: async () => {},
    stopped: () => false,
  });
  expect(await pipeline.step()).toEqual({ status: "idle" });
});

function holdRig(dir: string, holdMinutes: number) {
  const cfg = config({ stateDir: dir, daemonUpdateHoldMinutes: holdMinutes });
  const sessions = new FakeSessions({
    dev: [done("<progress>done: x\nnext: y</progress>")],
    qa: [],
  });
  const state: { pending: string | null } = { pending: "0.3.1060" };
  sessions.updatePending = async () => state.pending;
  const world: World = {
    fail: new Set(),
    calls: [],
    dirty: true,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["MERGED", "UNKNOWN"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  let at = new Date("2026-11-25T00:00:00Z").getTime();
  const clock = { now: () => new Date(at) };
  const store = SqliteStore.open(cfg.stateDir, () => clock.now());
  const logged: string[] = [];
  const pipeline = new Pipeline({
    config: cfg,
    tracker: new FakeTracker([issue({ description: readyDescription })]),
    sessions,
    exec: makeExec(world),
    store,
    clock,
    log: (line) => logged.push(line),
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async () => {},
    stopped: () => false,
  });
  return {
    state,
    logged,
    advance: (minutes: number) => {
      at += minutes * 60_000;
    },
    /** One step; true when it took the work item. */
    async took() {
      const result = await pipeline.step().catch(() => ({ status: "error" }));
      return (result as { status: string }).status !== "idle";
    },
    waited: () => logged.filter((l) => l.includes("daemon update waited")),
  };
}

test("within the hold new work items wait; past it they are taken, with one log line", async () => {
  const rig = holdRig(dir, 10);
  expect(await rig.took()).toBe(false);
  rig.advance(9);
  expect(await rig.took()).toBe(false);
  expect(rig.waited()).toEqual([]);
  rig.advance(1);
  expect(await rig.took()).toBe(true);
  expect(rig.waited()).toEqual([
    "daemon update waited 10 min: taking new work items; it switches when idle",
  ]);
  await rig.took();
  expect(rig.waited().length).toBe(1);
});

test("the same version is not held again once its hold has run out", async () => {
  const rig = holdRig(dir, 10);
  await rig.took();
  rig.advance(11);
  expect(await rig.took()).toBe(true);
  rig.advance(30);
  expect(await rig.took()).toBe(true); // same version: still not held
});

test("a newer pending version restarts the hold", async () => {
  const rig = holdRig(dir, 10);
  expect(await rig.took()).toBe(false);
  rig.advance(8);
  rig.state.pending = "0.3.1061";
  expect(await rig.took()).toBe(false);
  rig.advance(8); // 16 min since the first version, 8 since the second
  expect(await rig.took()).toBe(false);
  rig.advance(2);
  expect(await rig.took()).toBe(true);
});

test("when pending goes away the state clears, so the next one is held again", async () => {
  const rig = holdRig(dir, 10);
  expect(await rig.took()).toBe(false);
  rig.advance(9);
  rig.state.pending = null;
  expect(await rig.took()).toBe(true);
  expect(rig.logged.some((l) => l.includes("daemon update done"))).toBe(true);
});

test("a hold of 0 does not wait and logs nothing about waiting", async () => {
  const rig = holdRig(dir, 0);
  expect(await rig.took()).toBe(true);
  expect(rig.logged.filter((l) => l.includes("daemon update"))).toEqual([]);
});
