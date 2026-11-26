import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pipeline } from "../src/pipeline.ts";
import { type RunRecord, RunStore } from "../src/store.ts";
import type { Exec } from "../src/types.ts";
import {
  type CiResponse,
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
  dir = await mkdtemp(join(tmpdir(), "auto-loop-conflict-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pending: CiResponse = {
  headRefOid: "abc",
  statusCheckRollup: [{ name: "check", status: "IN_PROGRESS", conclusion: null }],
};

type Git = {
  merge: number;
  mergeHead: boolean;
  conflicted: string;
  fetch: number;
  dirtyAtMerge: boolean;
};

const setup = (git: Partial<Git> = {}, over = {}) => {
  const cfg = config({ stateDir: dir, ciPollIntervalMs: 1000, ciTimeoutMs: 60_000, ...over });
  const tracker = new FakeTracker([issue({ description: readyDescription })]);
  const sessions = new FakeSessions({ dev: [done()], qa: [done(PASS), done(PASS), done(PASS)] });
  const world: World = {
    fail: new Set(),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [pending],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["OPEN", "CONFLICTING"]],
    mergeTreeOutput: "",
  };
  const state: Git = {
    merge: 0,
    mergeHead: false,
    conflicted: "",
    fetch: 0,
    dirtyAtMerge: false,
    ...git,
  };
  const base = makeExec(world);
  const raw: string[][] = [];
  const exec: Exec = async (argv, options) => {
    raw.push(argv);
    const line = argv.join(" ");
    if (line.includes(" merge --no-edit")) {
      world.calls.push(line);
      if (state.conflicted !== "") {
        state.mergeHead = true;
        return { code: 1, output: "CONFLICT", timedOut: false };
      }
      // A clean merge: GitHub no longer sees a conflict.
      world.prMerge = [["MERGED", "UNKNOWN"]];
      return { code: state.merge, output: "", timedOut: false };
    }
    if (line.includes("MERGE_HEAD")) {
      world.calls.push(line);
      if (state.dirtyAtMerge) world.dirty = true;
      return { code: state.mergeHead ? 0 : 1, output: "", timedOut: false };
    }
    if (line.includes("diff --name-only --diff-filter=U")) {
      world.calls.push(line);
      return { code: 0, output: state.conflicted, timedOut: false };
    }
    if (line.includes(" merge --abort")) {
      world.calls.push(line);
      state.mergeHead = false;
      return { code: 0, output: "", timedOut: false };
    }
    return base(argv, options);
  };
  const clock = { now: () => new Date("2026-11-25T00:00:00Z") };
  const store = new RunStore(cfg.stateDir, () => clock.now());
  const pipeline = new Pipeline({
    config: cfg,
    tracker,
    sessions,
    exec,
    store,
    clock,
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret" },
    sleep: async () => {},
    stopped: () => false,
  });
  return { pipeline, tracker, sessions, world, store, state, raw };
};

const load = async (store: RunStore): Promise<RunRecord> => {
  const run = await store.load("CYC-1");
  if (run === undefined) throw new Error("no run");
  return run;
};

/** Puts a run that has already made its PR back in the CI phase, as a restart finds it. */
const resumeInCi = async (s: ReturnType<typeof setup>, patch: Partial<RunRecord>) => {
  await s.pipeline.step();
  const run = await load(s.store);
  await s.store.save({ ...run, phase: "ci", blockedReason: null, resumeFrom: null, ...patch });
  s.tracker.issues[0] = issue({ description: readyDescription, columnId: 23 });
  s.world.calls.length = 0;
  s.world.prMerge = [["OPEN", "CONFLICTING"]];
  s.world.ciResponses = [pending];
};

const gitCalls = (calls: string[], what: string) => calls.filter((c) => c.includes(what));

test("a conflict found while waiting for CI is merged in the worktree, counted once, with GIT_SAFE", async () => {
  const s = setup();
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  const merges = gitCalls(s.world.calls, "merge --no-edit origin/main");
  expect(merges).toHaveLength(1);
  expect(gitCalls(s.world.calls, "fetch origin").length).toBeGreaterThanOrEqual(1);
  const run = await load(s.store);
  expect(run.conflictRound).toBe(1);
  expect(run.conflict).toBeNull();
  expect(run.round).toBe(0);
  expect(run.ciRound).toBe(0);
});

test("the loop's git commands for the merge carry GIT_SAFE", async () => {
  const s = setup();
  await s.pipeline.step();
  const merges = s.raw.filter(
    (a) =>
      a[0] === "git" && (a.includes("merge") || a.includes("MERGE_HEAD") || a.includes("fetch")),
  );
  expect(merges.length).toBeGreaterThan(0);
  for (const argv of merges)
    expect(argv.slice(0, 5)).toEqual([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
    ]);
});

test("a clean merge sends no Dev turn and goes on through verify, QA, push and CI; conflict_merge clean is recorded", async () => {
  const s = setup();
  await s.pipeline.step();
  expect(s.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(1);
  expect(s.sessions.prompts.filter((p) => p.role === "qa")).toHaveLength(2);
  const events = await s.store.events();
  const merge = events.find((e) => e.kind === "conflict_merge");
  expect(merge?.result).toBe("clean");
  expect(gitCalls(s.world.calls, "push origin").length).toBe(2);
});

test("a real conflict: merge --abort, Blocked, reason lists the --diff-filter=U files", async () => {
  const s = setup({ conflicted: "src/a.ts\nsrc/b.ts\n" });
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") {
    expect(result.reason).toContain("src/a.ts");
    expect(result.reason).toContain("src/b.ts");
  }
  const calls = s.world.calls;
  expect(gitCalls(calls, "merge --abort")).toHaveLength(1);
  expect(calls.findIndex((c) => c.includes("merge --abort"))).toBeGreaterThan(
    calls.findIndex((c) => c.includes("--diff-filter=U")),
  );
  const run = await load(s.store);
  expect(run.conflictRound).toBe(1);
  expect(run.conflict).toBeNull();
  expect(s.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(1);
  const merge = (await s.store.events()).find((e) => e.kind === "conflict_merge");
  expect(merge?.result).toBe("conflict");
});

test("at the limit a second conflict blocks at once, saying it was handled once already", async () => {
  const s = setup();
  await resumeInCi(s, { conflictRound: 1, conflict: null });
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("已自动处理过 1 次");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
});

test("an unclean worktree blocks before merging", async () => {
  const s = setup({ dirtyAtMerge: true });
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("未提交");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
});

test("a failed fetch blocks before merging", async () => {
  const s = setup();
  s.world.fail.add("fetch origin");
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
});

test("killed after the count was saved: the restart continues that merge, it is not a second one", async () => {
  const s = setup();
  await resumeInCi(s, { conflictRound: 1, conflict: { state: "merging" } });
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(1);
  const after = await load(s.store);
  expect(after.conflictRound).toBe(1);
  expect(after.conflict).toBeNull();
});

test("killed in the middle of a conflicted merge: the restart reads the files, aborts and blocks", async () => {
  const s = setup();
  await resumeInCi(s, { conflictRound: 1, conflict: { state: "merging" } });
  s.state.conflicted = "src/a.ts\n";
  s.state.mergeHead = true;
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("src/a.ts");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
  expect(gitCalls(s.world.calls, "merge --abort")).toHaveLength(1);
});
