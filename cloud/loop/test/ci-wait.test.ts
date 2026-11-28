import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { Engine } from "../src/engine/engine.ts";
import { designFlow } from "../src/flows/design/index.ts";
import { devFlow } from "../src/flows/dev/index.ts";
import { PlanFlow } from "../src/flows/plan.ts";
import { PrFlow } from "../src/flows/pr/index.ts";
import { ResearchFlow } from "../src/flows/research/index.ts";
import { todoIntake } from "../src/flows/ticket.ts";
import { gitWorkspace } from "../src/ports/git.ts";
import { githubForge } from "../src/ports/github.ts";
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
  type World,
} from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ci-wait-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An engine whose dev flow also has `watch`; `stop` ends a step after the phase under way. */
const setup = (issues: Issue[], watch?: () => Promise<void>) => {
  const cfg = config({ stateDir: dir });
  const tracker = new FakeTracker(issues);
  const sessions = new FakeSessions({ dev: [done(), done()], qa: [done(PASS), done(PASS)] });
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
  let now = new Date("2026-11-28T00:00:00Z");
  const clock = { now: () => now };
  const store = SqliteStore.open(cfg.stateDir, () => now);
  const exec = makeExec(world);
  const env = { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" };
  const engine = new Engine(
    {
      config: cfg,
      tracker,
      sessions,
      exec,
      store,
      clock,
      log: () => {},
      env,
      sleep: async () => {},
      stopped: () => stop.value,
      forge: githubForge({ exec, env }),
      workspace: gitWorkspace({
        exec,
        env,
        repoRoot: cfg.repoRoot,
        remote: cfg.remote,
        stateDir: cfg.stateDir,
      }),
    },
    (host) => ({
      flows: {
        dev: Object.assign(devFlow(host), watch === undefined ? {} : { watch }),
        research: new ResearchFlow(host),
        design: designFlow(host),
      },
      todo: todoIntake(host),
      plan: new PlanFlow(host),
      pr: new PrFlow(host),
    }),
  );
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { engine, tracker, sessions, store, stop, advance };
};

const ready = (over: Partial<Issue> = {}) => issue({ description: readyDescription, ...over });

/** A run that stopped after its dev phase, so it is unfinished and owned by nobody. */
const parked = async (s: ReturnType<typeof setup>) => {
  const turn = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (...args: Parameters<typeof turn>) => {
    const r = await turn(...args);
    s.stop.value = true;
    return r;
  };
  await s.engine.step();
  s.stop.value = false;
  s.sessions.turn = turn;
  return (await s.store.load("CYC-1"))?.phase;
};

const events = async (s: ReturnType<typeof setup>, kind: string) =>
  (await s.store.events()).filter((e) => e.kind === kind);

test("a run with a wait that is not due is skipped: the work item is not read, and the worker takes the next one", async () => {
  const s = setup([ready(), ready({ id: 2, number: 2, key: "CYC-2" })]);
  expect(await parked(s)).toBe("verify");
  s.store.wait("CYC-1", "ci:o/r@abc", new Date("2026-11-28T00:10:00Z").toISOString());
  let reads = 0;
  const get = s.tracker.get.bind(s.tracker);
  s.tracker.get = async (n: number) => {
    if (n === 1) reads++;
    return get(n);
  };
  const result = await s.engine.step();
  expect(reads).toBe(0);
  expect(result.status).not.toBe("blocked");
  // the second work item was claimed meanwhile
  expect((await s.store.load("CYC-2"))?.key).toBe("CYC-2");
  expect((await s.store.load("CYC-1"))?.phase).toBe("verify");
  expect(s.store.waits("CYC-1")).toHaveLength(1);
});

test("with nothing else to do, a step on a waiting run is idle", async () => {
  const s = setup([ready()]);
  await parked(s);
  s.store.wait("CYC-1", "ci:o/r@abc", new Date("2026-11-28T00:10:00Z").toISOString());
  expect((await s.engine.step()).status).toBe("idle");
  expect(await events(s, "woken")).toHaveLength(0);
});

test("a signal wakes the run: waits cleared, woken written, recovered not", async () => {
  const s = setup([ready()]);
  await parked(s);
  s.store.wait("CYC-1", "ci:o/r@abc", new Date("2026-11-28T00:10:00Z").toISOString());
  expect(s.store.signal("ci:o/r@abc:settled:1", "ci:o/r@abc", "poll")).toBe(true);
  const result = await s.engine.step();
  expect(result.status).toBe("delivered");
  expect(s.store.waits("CYC-1")).toHaveLength(0);
  expect(await events(s, "woken")).toHaveLength(1);
  expect(await events(s, "recovered")).toHaveLength(0);
});

test("the recheck time wakes a run too", async () => {
  const s = setup([ready()]);
  await parked(s);
  s.store.wait("CYC-1", "ci:o/r@abc", new Date("2026-11-28T00:10:00Z").toISOString());
  expect((await s.engine.step()).status).toBe("idle");
  s.advance(11 * 60_000);
  expect((await s.engine.step()).status).toBe("delivered");
  expect(await events(s, "woken")).toHaveLength(1);
  expect(await events(s, "recovered")).toHaveLength(0);
});

test("a run without a wait is recovered as before", async () => {
  const s = setup([ready()]);
  await parked(s);
  await s.engine.step();
  expect(await events(s, "recovered")).toHaveLength(1);
  expect(await events(s, "woken")).toHaveLength(0);
});

test("watch calls the flows' watch, one at a time, and a failure only goes to the log", async () => {
  let running = 0;
  let peak = 0;
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const s = setup([], async () => {
    calls++;
    running++;
    peak = Math.max(peak, running);
    await gate;
    running--;
    throw new Error("boom");
  });
  const first = s.engine.watch();
  await s.engine.watch(); // single flight: returns at once
  expect(calls).toBe(1);
  release();
  await first;
  expect(peak).toBe(1);
  // after it ended, the next call runs again
  await s.engine.watch();
  expect(calls).toBe(2);
});
