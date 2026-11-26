import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pipeline } from "../src/pipeline.ts";
import { applyPatch, devOf, type RunPatch, type RunRecord, RunStore } from "../src/store.ts";
import { type Exec, SessionLost } from "../src/types.ts";
import {
  type CiResponse,
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  makeExec,
  PASS,
  REVIEW_MERGE,
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
  /** Files git still lists as unmerged while a merge is open. */
  unmerged: string;
  markers: boolean;
  ancestor: boolean;
  theirs: string;
  keepsOwn: boolean;
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
    ignoredDirs: "",
  };
  const state: Git = {
    merge: 0,
    mergeHead: false,
    conflicted: "",
    fetch: 0,
    dirtyAtMerge: false,
    unmerged: git.conflicted ?? "",
    markers: false,
    ancestor: true,
    keepsOwn: true,
    theirs: "main: rename the widget\n",
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
        state.ancestor = false;
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
      return { code: 0, output: state.mergeHead ? state.unmerged : "", timedOut: false };
    }
    if (line.includes("merge-base --is-ancestor")) {
      world.calls.push(line);
      if (line.includes("is-ancestor abc "))
        return { code: state.keepsOwn ? 0 : 1, output: "", timedOut: false };
      return { code: state.ancestor ? 0 : 1, output: "", timedOut: false };
    }
    if (line.includes(" grep ")) {
      world.calls.push(line);
      return state.markers
        ? { code: 0, output: "src/a.ts\n", timedOut: false }
        : { code: 1, output: "", timedOut: false };
    }
    if (line.includes(" commit --no-edit")) {
      world.calls.push(line);
      state.mergeHead = false;
      state.ancestor = true;
      world.prMerge = [["MERGED", "UNKNOWN"]];
      return { code: 0, output: "", timedOut: false };
    }
    if (line.includes("log --format=%s")) {
      world.calls.push(line);
      return { code: 0, output: state.theirs, timedOut: false };
    }
    if (line.includes(" merge --abort")) {
      world.calls.push(line);
      state.mergeHead = false;
      return { code: 0, output: "", timedOut: false };
    }
    return base(argv, options);
  };
  // What the Dev conflict turn does to the repository: set by each test, run on every Dev turn after the first.
  const hook: { onConflictTurn: () => void } = { onConflictTurn: () => {} };
  const realTurn = sessions.turn.bind(sessions);
  let devTurns = 0;
  sessions.turn = async (id, prompt, ctx) => {
    if (ctx.role === "dev" && ++devTurns > 1) hook.onConflictTurn();
    return realTurn(id, prompt, ctx);
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
  return {
    pipeline,
    tracker,
    sessions,
    world,
    store,
    state,
    raw,
    hook,
    setDevTurns: (n: number) => {
      devTurns = n;
    },
  };
};

const load = async (store: RunStore): Promise<RunRecord> => {
  const run = await store.load("CYC-1");
  if (run === undefined) throw new Error("no run");
  return run;
};

/** Puts a run that has already made its PR back in the CI phase, as a restart finds it. */
const resumeInCi = async (s: ReturnType<typeof setup>, patch: RunPatch) => {
  await s.pipeline.step();
  const run = await load(s.store);
  await s.store.save(
    applyPatch(run, { phase: "ci", blockedReason: null, resumeFrom: null, ...patch }),
  );
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
  expect(devOf(run).conflictRound).toBe(1);
  expect(devOf(run).conflict).toBeNull();
  expect(run.round).toBe(0);
  expect(devOf(run).ciRound).toBe(0);
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

test("at the limit a second conflict blocks at once, saying it was handled once already", async () => {
  const s = setup();
  await resumeInCi(s, { dev: { conflictRound: 1, conflict: null } });
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("已自动处理过 1 次");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
});

test("a merge that cannot start blocks with git's output and runs no abort", async () => {
  const s = setup({ merge: 1 });
  await resumeInCi(s, { dev: { conflictRound: 0, conflict: null } });
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).not.toContain("撤回合并失败");
  expect(gitCalls(s.world.calls, "merge --abort")).toHaveLength(0);
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
  await resumeInCi(s, { dev: { conflictRound: 1, conflict: { state: "merging" } } });
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(1);
  const after = await load(s.store);
  expect(devOf(after).conflictRound).toBe(1);
  expect(devOf(after).conflict).toBeNull();
});

const resolve = (s: ReturnType<typeof setup>, commit: boolean) => {
  s.hook.onConflictTurn = () => {
    s.state.unmerged = "";
    // GitHub no longer sees a conflict once the merge is committed.
    s.world.prMerge = [["MERGED", "UNKNOWN"]];
    if (commit) {
      s.state.mergeHead = false;
      s.state.ancestor = true;
    }
  };
};
const devPrompts = (s: ReturnType<typeof setup>) =>
  s.sessions.prompts.filter((p) => p.role === "dev").map((p) => p.prompt);

test("a real conflict goes to the Dev session: the brief names the files, the work item and main's commits", async () => {
  const s = setup({ conflicted: "src/a.ts\nsrc/b.ts\n" });
  s.sessions.script.dev.push(done());
  resolve(s, true);
  await s.pipeline.step();
  const prompts = devPrompts(s);
  expect(prompts).toHaveLength(2);
  const brief = prompts[1] ?? "";
  expect(brief).toContain("src/a.ts");
  expect(brief).toContain("src/b.ts");
  expect(brief).toContain("title");
  expect(brief).toContain("## 验收标准");
  expect(brief).toContain("main: rename the widget");
  expect(brief).toContain("git merge --abort");
  expect(s.sessions.prompts.filter((p) => p.role === "dev")[1]?.sessionId).toBe(
    s.sessions.prompts[0]?.sessionId,
  );
  const log = gitCalls(s.world.calls, "log --format=%s")[0] ?? "";
  expect(log).toContain("src/a.ts");
  expect(log).toContain("abc..origin/main");
});

test("Dev resolves and commits the merge: conflict_resolved, then verify, QA and a push without --force", async () => {
  const s = setup({ conflicted: "src/a.ts\n" });
  s.sessions.script.dev.push(done());
  resolve(s, true);
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  const events = await s.store.events();
  expect(events.some((e) => e.kind === "conflict_resolved")).toBe(true);
  expect(gitCalls(s.world.calls, "merge --abort")).toHaveLength(0);
  expect(gitCalls(s.world.calls, "commit --no-edit")).toHaveLength(0);
  const pushes = gitCalls(s.world.calls, "push origin");
  expect(pushes.length).toBeGreaterThan(0);
  for (const push of pushes) expect(push).not.toContain("--force");
  const qa = s.sessions.prompts.filter((p) => p.role === "qa");
  expect(qa.length).toBeGreaterThan(0);
  expect(qa[qa.length - 1]?.prompt).toContain("src/a.ts");
  const run = await load(s.store);
  expect(devOf(run).conflict).toBeNull();
  expect(devOf(run).resolvedFiles).toEqual(["src/a.ts"]);
});

test("Dev resolves but leaves the merge open: the loop finishes it with commit --no-edit before the checkpoint", async () => {
  const s = setup({ conflicted: "src/a.ts\n" });
  s.sessions.script.dev.push(done());
  resolve(s, false);
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  const calls = s.world.calls;
  const commit = calls.findIndex((c) => c.includes("commit --no-edit"));
  expect(commit).toBeGreaterThan(-1);
  expect(calls.findLastIndex((c) => c.includes("merge-base --is-ancestor"))).toBeGreaterThan(
    commit,
  );
  expect((await s.store.events()).some((e) => e.kind === "conflict_resolved")).toBe(true);
});

const checkpoints = (calls: string[]) => gitCalls(calls, "checkpoint (auto-loop)");

test("files still unmerged after the turn: abort, no checkpoint, Blocked naming the files", async () => {
  const s = setup({ conflicted: "src/a.ts\nsrc/b.ts\n" });
  s.sessions.script.dev.push(done());
  s.hook.onConflictTurn = () => {
    s.state.unmerged = "src/b.ts\n";
    s.world.dirty = true;
  };
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") {
    expect(result.reason).toContain("src/a.ts");
    expect(result.reason).toContain("src/b.ts");
  }
  expect(gitCalls(s.world.calls, "merge --abort")).toHaveLength(1);
  expect(gitCalls(s.world.calls, "commit --no-edit")).toHaveLength(0);
  expect(checkpoints(s.world.calls)).toHaveLength(0);
  // Only the first delivery pushed; the conflict turn pushed nothing.
  expect(gitCalls(s.world.calls, "push origin")).toHaveLength(1);
  const run = await load(s.store);
  expect(devOf(run).conflict).toBeNull();
});

test("conflict markers left in a file: not committed, rolled back, Blocked", async () => {
  const s = setup({ conflicted: "src/a.ts\n", markers: true });
  s.sessions.script.dev.push(done());
  resolve(s, false);
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("src/a.ts");
  expect(gitCalls(s.world.calls, "commit --no-edit")).toHaveLength(0);
  expect(gitCalls(s.world.calls, "merge --abort")).toHaveLength(1);
  expect(checkpoints(s.world.calls)).toHaveLength(0);
});

test("Dev aborted the merge itself: nothing is checkpointed, Blocked", async () => {
  const s = setup({ conflicted: "src/a.ts\n" });
  s.sessions.script.dev.push(done());
  s.hook.onConflictTurn = () => {
    s.state.mergeHead = false;
  };
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("src/a.ts");
  expect(checkpoints(s.world.calls)).toHaveLength(0);
  expect(gitCalls(s.world.calls, "reset --hard abc")).toHaveLength(1);
});

test("Dev committed something that is not the merge: the branch goes back to preMergeSha", async () => {
  const s = setup({ conflicted: "src/a.ts\n" });
  s.sessions.script.dev.push(done());
  s.hook.onConflictTurn = () => {
    s.state.mergeHead = false;
    s.world.headSha = "def";
  };
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(gitCalls(s.world.calls, "reset --hard abc")).toHaveLength(1);
});

const inConflictTurn = {
  phase: "dev" as const,
  dev: {
    conflictRound: 1,
    conflict: { state: "dev" as const, preMergeSha: "abc", files: ["src/a.ts"] },
  },
};

test("a restart in the conflict turn does not merge again and sends the conflict brief", async () => {
  const s = setup();
  await resumeInCi(s, inConflictTurn);
  s.state.mergeHead = true;
  s.state.ancestor = false;
  s.state.unmerged = "src/a.ts\n";
  s.sessions.script.dev.push(done());
  resolve(s, true);
  s.setDevTurns(1);
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
  expect(devPrompts(s).at(-1)).toContain("Conflicted files");
  expect(devPrompts(s).at(-1)).toContain("src/a.ts");
});

test("node_modules released, then a conflict turn: Dev starts with no install in the middle of the merge", async () => {
  const s = setup();
  await resumeInCi(s, {
    ...inConflictTurn,
    dev: { ...inConflictTurn.dev, nodeModulesReleased: true },
  });
  s.state.mergeHead = true;
  s.state.ancestor = false;
  s.state.unmerged = "src/a.ts\n";
  s.sessions.script.dev.push(done());
  resolve(s, true);
  s.setDevTurns(1);
  const log = s.world.calls;
  const turn = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    if (ctx.role === "dev") log.push("turn:dev");
    return turn(id, prompt, ctx);
  };
  await s.pipeline.step();
  expect(devPrompts(s).at(-1)).toContain("Dependencies are not installed");
  const order = log.filter((c) => c === "turn:dev" || c === "bun install");
  expect(order[0]).toBe("turn:dev");
  expect(order).toContain("bun install");
});

test("a resend after the merge was already finished does not merge again either", async () => {
  const s = setup();
  await resumeInCi(s, inConflictTurn);
  s.state.mergeHead = false;
  s.state.ancestor = true;
  s.sessions.script.dev.push(done());
  s.hook.onConflictTurn = () => {
    s.world.prMerge = [["MERGED", "UNKNOWN"]];
  };
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
  expect(devPrompts(s).at(-1)).toContain("Conflicted files");
});

test("a lost Dev session in the conflict turn: the new session also gets the conflict brief", async () => {
  const s = setup({ conflicted: "src/a.ts\n" });
  s.sessions.script.dev.push(new SessionLost("gone"), done());
  resolve(s, true);
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  const prompts = s.sessions.prompts.filter((p) => p.role === "dev");
  expect(prompts.at(-1)?.prompt).toContain("Conflicted files");
  expect(prompts.at(-1)?.sessionId).not.toBe(prompts[0]?.sessionId);
});

test("a person putting the Blocked ticket back resets the conflict count and conflict", async () => {
  const s = setup({ conflicted: "src/a.ts\n", unmerged: "src/a.ts\n" });
  s.sessions.script.dev.push(done());
  const first = await s.pipeline.step();
  expect(first.status).toBe("blocked");
  const blocked = await load(s.store);
  await s.store.save(
    applyPatch(blocked, { dev: { conflict: { state: "dev", preMergeSha: "abc", files: ["x"] } } }),
  );
  s.tracker.issues[0] = issue({ description: readyDescription, columnId: 22 });
  s.world.prMerge = [["OPEN", "MERGEABLE"]];
  s.world.ciResponses = [];
  s.state.mergeHead = false;
  s.state.ancestor = true;
  s.sessions.script.dev.push(done());
  await s.pipeline.step();
  const run = await load(s.store);
  expect(devOf(run).conflictRound).toBe(0);
  expect(devOf(run).conflict).toBeNull();
  expect((await s.store.events()).some((e) => e.kind === "resumed")).toBe(true);
});

test("a conflict turn that blocked before judgement: the resume backs the merge out first", async () => {
  const s = setup();
  await resumeInCi(s, { ...inConflictTurn, phase: "blocked", resumeFrom: "dev" });
  s.state.mergeHead = true;
  s.tracker.issues[0] = issue({ description: readyDescription, columnId: 22 });
  s.world.prMerge = [["OPEN", "MERGEABLE"]];
  s.world.ciResponses = [];
  s.sessions.script.dev.push(done());
  await s.pipeline.step();
  const calls = s.world.calls;
  expect(gitCalls(calls, "merge --abort")).toHaveLength(1);
  expect(gitCalls(calls, "reset --hard abc")).toHaveLength(1);
  expect(calls.findIndex((c) => c.includes("merge --abort"))).toBeLessThan(
    calls.findIndex((c) => c.includes("checkpoint (auto-loop)")) === -1
      ? Number.MAX_SAFE_INTEGER
      : calls.findIndex((c) => c.includes("checkpoint (auto-loop)")),
  );
  const run = await load(s.store);
  expect(devOf(run).conflict).toBeNull();
});

test("a resolution fixed but not staged is staged by the loop before the unmerged check", async () => {
  const s = setup({ conflicted: "src/a.ts\n" });
  s.sessions.script.dev.push(done());
  resolve(s, false);
  await s.pipeline.step();
  expect(gitCalls(s.world.calls, "add -A -- src/a.ts")).toHaveLength(1);
});

test("a branch that no longer holds its own commits is not resolved", async () => {
  const s = setup({ conflicted: "src/a.ts\n", keepsOwn: false });
  s.sessions.script.dev.push(done());
  resolve(s, true);
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(gitCalls(s.world.calls, "reset --hard abc")).toHaveLength(1);
});

/** A run whose review said merge and turned auto-merge on, and then GitHub reports a conflict. */
const mergeSetup = (git: Partial<Git> = {}, over = {}) => {
  const s = setup(git, over);
  s.sessions.script.review = [done(REVIEW_MERGE), done(REVIEW_MERGE)];
  s.sessions.script.qa = [done(PASS), done(PASS), done(PASS)];
  s.world.ciResponses = [];
  s.world.prMerge = [["OPEN", "CONFLICTING"]];
  return s;
};

const index = (calls: string[], what: string) => calls.findIndex((c) => c.includes(what));

test("a conflict found after auto-merge is on: auto-merge off first, then main merged, not delivered; review merge turns it on again and delivers", async () => {
  const s = mergeSetup();
  // After the merge the PR merges once auto-merge is on again.
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  const calls = s.world.calls;
  const off = index(calls, "--disable-auto");
  const merge = index(calls, "merge --no-edit origin/main");
  expect(off).toBeGreaterThan(-1);
  expect(merge).toBeGreaterThan(off);
  const enables = calls.filter((c) => c.includes("--auto --squash"));
  expect(enables).toHaveLength(2);
  expect(calls.lastIndexOf(enables[1] ?? "")).toBeGreaterThan(merge);
  const events = (await s.store.events()).map((e) => e.kind);
  expect(events.filter((k) => k === "delivered")).toHaveLength(1);
  expect(events).toContain("auto_merge_disabled");
  const run = await load(s.store);
  expect(devOf(run).conflictRound).toBe(1);
  expect(s.world.autoMerge).toBe(true);
});

test("a conflict while waiting for CI with auto-merge still on: it is turned off before the merge", async () => {
  const s = setup();
  s.world.autoMerge = true;
  await s.pipeline.step();
  expect(s.world.calls.some((c) => c.includes("--disable-auto"))).toBe(true);
  expect(index(s.world.calls, "--disable-auto")).toBeLessThan(
    index(s.world.calls, "merge --no-edit origin/main"),
  );
});

test("auto-merge off already: nothing is disabled", async () => {
  const s = setup();
  await s.pipeline.step();
  expect(s.world.calls.some((c) => c.includes("--disable-auto"))).toBe(false);
  expect(s.world.calls.some((c) => c.includes("--json autoMergeRequest"))).toBe(true);
});

test("auto-merge cannot be read: Blocked, no merge, no push", async () => {
  const s = setup();
  await resumeInCi(s, { dev: { conflictRound: 0, conflict: null } });
  s.world.fail.add("autoMergeRequest");
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
  expect(gitCalls(s.world.calls, "push origin")).toHaveLength(0);
});

test("auto-merge cannot be turned off: Blocked, no merge, no push", async () => {
  const s = setup();
  await resumeInCi(s, { dev: { conflictRound: 0, conflict: null } });
  s.world.autoMerge = true;
  s.world.fail.add("--disable-auto");
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("关闭自动合并失败");
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
  expect(gitCalls(s.world.calls, "push origin")).toHaveLength(0);
});

test("a second conflict while waiting for the merge: Blocked naming the files and the one earlier attempt", async () => {
  const s = mergeSetup();
  await s.pipeline.step();
  const run = await load(s.store);
  await s.store.save({ ...run, phase: "review", blockedReason: null, resumeFrom: null });
  s.tracker.issues[0] = issue({ description: readyDescription, columnId: 23 });
  s.world.calls.length = 0;
  s.world.autoMerge = false;
  s.world.mergeTreeOutput = "deadbeef\nsrc/a.ts\n";
  s.world.prMerge = [["OPEN", "CONFLICTING"]];
  s.sessions.script.review = [done(REVIEW_MERGE)];
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") {
    expect(result.reason).toContain("已自动处理过 1 次");
    expect(result.reason).toContain("src/a.ts");
  }
  expect(s.world.calls.some((c) => c.includes("--disable-auto"))).toBe(true);
  expect(gitCalls(s.world.calls, "merge --no-edit")).toHaveLength(0);
});
