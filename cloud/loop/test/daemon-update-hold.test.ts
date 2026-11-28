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
