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
import { applyPatch, devOf } from "../src/store.ts";
import type { Issue } from "../src/types.ts";
import {
  type CiResponse,
  config,
  done,
  FakeSessions,
  FakeTracker,
  greenCi,
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
const setup = (
  issues: Issue[],
  watch?: () => Promise<void>,
  ci: CiResponse[] = [],
  over: Parameters<typeof config>[0] = {},
) => {
  const cfg = config({ stateDir: dir, ...over });
  const tracker = new FakeTracker(issues);
  const sessions = new FakeSessions({ dev: [done(), done()], qa: [done(PASS), done(PASS)] });
  const world: World = {
    fail: new Set(),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [...ci],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["MERGED", "UNKNOWN"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  const stop = { value: false };
  let now = new Date("2026-11-28T00:00:00Z");
  const sleeps = { count: 0 };
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
      sleep: async () => {
        sleeps.count++;
      },
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
  return { engine, tracker, sessions, store, stop, advance, world, sleeps };
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

const pending: CiResponse = {
  headRefOid: "abc",
  statusCheckRollup: [
    { name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "browser", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "integration", status: "IN_PROGRESS", conclusion: null },
  ],
};
const subjectOf = "ci:https://github.com/o/r/pull/9@abc";

/** What the checker does: a signal on the waiting run's subject. */
const wakeRun = (s: ReturnType<typeof setup>, n = 0) => {
  for (const w of s.store.waits("CYC-1")) s.store.signal(`${w.subject}:t${n}`, w.subject, "poll");
};

test("a ci step with CI still running registers a wait and returns waiting, without sleeping", async () => {
  const s = setup([ready()], undefined, [pending], { ciTimeoutMs: 30 * 60_000 });
  const result = await s.engine.step();
  expect(result).toEqual({ status: "waiting", key: "CYC-1", on: "ci" });
  expect(s.sleeps.count).toBe(0);
  const waits = s.store.waits("CYC-1");
  expect(waits).toHaveLength(1);
  expect(waits[0]?.subject).toBe(subjectOf);
  // the recheck is 10 minutes out at most
  expect(new Date(waits[0]?.recheckAt ?? "").getTime()).toBe(
    new Date("2026-11-28T00:10:00Z").getTime(),
  );
  const run = await s.store.load("CYC-1");
  const wait = run && devOf(run).ciWait;
  expect(wait?.sha).toBe("abc");
  expect(wait?.since).toBe("2026-11-28T00:00:00.000Z");
  const beat = s.store.heartbeats().find((b) => b.runKey === "CYC-1");
  expect(beat?.detail).toContain('"waitingOn":"ci"');
  expect(await events(s, "ci_waiting")).toHaveLength(1);
});

test("while a run waits for CI the worker takes the next work item", async () => {
  const s = setup([ready(), ready({ id: 2, number: 2, key: "CYC-2" })], undefined, [pending]);
  expect((await s.engine.step()).status).toBe("waiting");
  const next = await s.engine.step();
  expect(next.status).not.toBe("idle");
  expect((await s.store.load("CYC-2"))?.key).toBe("CYC-2");
  expect(s.store.waits("CYC-1")).toHaveLength(1);
});

test("a wake that finds CI still running registers again, keeps the start time and writes ci_waiting once", async () => {
  const s = setup([ready()], undefined, [pending, pending, greenCi("abc")]);
  await s.engine.step();
  s.advance(60_000);
  wakeRun(s);
  expect((await s.engine.step()).status).toBe("waiting");
  const run = await s.store.load("CYC-1");
  expect(run && devOf(run).ciWait?.since).toBe("2026-11-28T00:00:00.000Z");
  expect(await events(s, "ci_waiting")).toHaveLength(1);
  expect(await events(s, "woken")).toHaveLength(1);
  wakeRun(s, 1);
  expect((await s.engine.step()).status).toBe("delivered");
  expect(s.store.waits("CYC-1")).toHaveLength(0);
  expect((await s.store.load("CYC-1"))?.phase).toBe("done");
  expect(await events(s, "recovered")).toHaveLength(0);
});

test("the recheck at the deadline finds the timeout, counted from when waiting began", async () => {
  const s = setup([ready()], undefined, [pending, pending, pending], { ciTimeoutMs: 15 * 60_000 });
  await s.engine.step();
  s.advance(11 * 60_000);
  // woken by the recheck time, still running, not yet timed out: waits on, recheck is capped by the deadline
  expect((await s.engine.step()).status).toBe("waiting");
  expect(new Date(s.store.waits("CYC-1")[0]?.recheckAt ?? "").getTime()).toBe(
    new Date("2026-11-28T00:15:00Z").getTime(),
  );
  s.advance(5 * 60_000);
  const result = await s.engine.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("等待 CI 结果超时");
  expect(await events(s, "ci_timeout")).toHaveLength(1);
  expect(s.store.waits("CYC-1")).toHaveLength(0);
  const run = await s.store.load("CYC-1");
  expect(run && devOf(run).ciWait).toBeNull();
});

test("a restart keeps waiting: same start time, no second wait registration or rerun", async () => {
  const first = setup([ready()], undefined, [pending]);
  await first.engine.step();
  const since = devOf((await first.store.load("CYC-1")) as never).ciWait?.since;
  const second = setup([ready()], undefined, [pending, greenCi("abc")]);
  expect((await second.engine.step()).status).toBe("idle");
  wakeRun(second);
  second.advance(1000);
  expect((await second.engine.step()).status).toBe("waiting");
  const run = await second.store.load("CYC-1");
  expect(run && devOf(run).ciWait?.since).toBe(since);
  expect(second.world.calls.filter((c) => c.includes("gh run rerun"))).toHaveLength(0);
});

test("a run stopped in ci before this change, with no wait registered, registers one when it goes on", async () => {
  const s = setup([ready()], undefined, [pending, pending]);
  await s.engine.step();
  s.store.clearWaits("CYC-1");
  const run = await s.store.load("CYC-1");
  if (run === undefined) throw new Error("no run");
  await s.store.save(applyPatch(run, { dev: { ciWait: null } }));
  expect((await s.engine.step()).status).toBe("waiting");
  expect(s.store.waits("CYC-1")).toHaveLength(1);
  expect(await events(s, "recovered")).toHaveLength(1);
});

test("a red run is rerun once and a wake on the same commit does not rerun or release again", async () => {
  const red = (job: string): CiResponse => ({
    headRefOid: "abc",
    statusCheckRollup: [
      { name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "browser", status: "COMPLETED", conclusion: "SUCCESS" },
      {
        name: "integration",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: `https://github.com/o/r/actions/runs/20/job/${job}`,
      },
    ],
  });
  const s = setup([ready()], undefined, [
    red("777"), // first read: red, back to Dev
    red("777"), // before the rerun
    red("777"), // the rerun has not shown up
    red("777"), // a wake: still only the old attempt
    greenCi("abc"),
  ]);
  expect((await s.engine.step()).status).toBe("waiting");
  const waitedSince = devOf((await s.store.load("CYC-1")) as never).ciWait?.since;
  s.advance(1000);
  wakeRun(s);
  expect((await s.engine.step()).status).toBe("waiting");
  wakeRun(s, 1);
  expect((await s.engine.step()).status).toBe("delivered");
  expect(s.world.calls.filter((c) => c.includes("gh run rerun"))).toEqual([
    "gh run rerun 20 --failed",
  ]);
  expect(await events(s, "ci_rerun")).toHaveLength(1);
  expect(await events(s, "ci_waiting")).toHaveLength(1);
  expect(waitedSince).toBe("2026-11-28T00:00:00.000Z");
});

test("a person closing the PR while the run waits stops it at the next wake instead of waiting again", async () => {
  const s = setup([ready()], undefined, [pending, pending]);
  await s.engine.step();
  s.world.prState = "CLOSED";
  wakeRun(s);
  const result = await s.engine.step();
  expect(result.status).toBe("blocked");
  expect(s.store.waits("CYC-1")).toHaveLength(0);
});
