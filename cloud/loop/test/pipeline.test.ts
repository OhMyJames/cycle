import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tuning } from "../src/config-file.ts";
import { CriteriaBook } from "../src/criteria.ts";
import { SqliteStore } from "../src/db/store.ts";
import { runHomeDir } from "../src/env.ts";
import { type DepsInput as Deps, Pipeline } from "../src/pipeline.ts";
import { applyPatch, devOf } from "../src/store.ts";
import {
  type Exec,
  type ExecResult,
  type Issue,
  SessionLost,
  type TurnResult,
} from "../src/types.ts";
import { fourDocs, fullFlowIssue, setupFullFlow } from "./full-flow-helpers.ts";
import {
  CHECKED,
  type CiResponse,
  config,
  done,
  FakeSessions,
  FakeTracker,
  greenCi,
  issue,
  makeExec,
  PASS,
  REVIEW_MERGE,
  readyDescription,
  type Script,
  type World,
  WT,
} from "./helpers.ts";

const FAIL = `${CHECKED}<verdict>{"pass":false,"findings":[{"severity":"major","where":"a.ts","problem":"p","fix":"f"}]}</verdict>`;
const REVIEW_REJECT = `${CHECKED}<review>{"decision":"reject","summary":"missing edge-case handling","reasons":["empty input is not handled"],"findings":[{"severity":"major","where":"packages/client/src/a.ts","problem":"throws on empty input","fix":"return early on empty input and add a test"}]}</review>`;
const REVIEW_ESCALATE = `${CHECKED}<review>{"decision":"escalate","summary":"needs human sign-off","reasons":["changes permission boundary","needs design confirmation"]}</review>`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const setup = (
  issues: Issue[],
  script: Script,
  over = {},
  fail: string[] = [],
  ci: { responses?: CiResponse[]; logs?: Record<string, string> } = {},
  extra: Partial<Deps> = {},
) => {
  const cfg = config({ stateDir: dir, ...over });
  const tracker = new FakeTracker(issues);
  const sessions = new FakeSessions(script);
  const world: World = {
    fail: new Set(fail),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [...(ci.responses ?? [])],
    ciLogs: { ...(ci.logs ?? {}) },
    prState: "OPEN",
    prMerge: [["MERGED", "UNKNOWN"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  const stop = { value: false };
  let nowMs = new Date("2026-11-25T00:00:00Z").getTime();
  const clock = { now: () => new Date(nowMs) };
  const advance = (ms: number) => {
    nowMs += ms;
  };
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
    ...extra,
  });
  return { pipeline, tracker, sessions, world, store, stop, advance };
};

/** Steps until the run is no longer waiting for CI: a signal on its subject wakes it, as the checker would (CYC-550). */
const settle = async (s: { pipeline: Pipeline; store: SqliteStore }, key = "CYC-1") => {
  let result = await s.pipeline.step();
  for (
    let i = 0;
    (result.status === "waiting" || result.status === "idle") &&
    s.store.waits(key).length > 0 &&
    i < 10;
    i++
  ) {
    for (const w of s.store.waits(key)) s.store.signal(`${w.subject}:test:${i}`, w.subject, "test");
    result = await s.pipeline.step();
  }
  return result;
};

const ready = (over: Partial<Issue> = {}) => issue({ description: readyDescription, ...over });

test("idle when nothing is in Todo with the auto label", async () => {
  const { pipeline } = setup([ready({ labelIds: [] }), ready({ number: 2, columnId: 21 })], {
    dev: [],
    qa: [],
  });
  expect((await pipeline.step()).status).toBe("idle");
});

test("a work item that fails the preflight is sent back with a comment and moved to Blocked", async () => {
  const { pipeline, tracker, sessions } = setup([issue({ description: "no criteria" })], {
    dev: [],
    qa: [],
  });
  const result = await pipeline.step();
  expect(result.status).toBe("rejected");
  expect(tracker.moves).toEqual(["CYC-1:blocked"]);
  expect(tracker.comments).toHaveLength(1);
  expect(sessions.created).toEqual([]);
});

test("happy path: Dev, checks, QA, push, PR, green CI, independent review merge, auto-merge (squash)", async () => {
  const { pipeline, tracker, sessions, world, store } = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  const result = await pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: true,
  });
  expect(tracker.moves).toEqual(["CYC-1:inProgress"]);
  expect(sessions.created).toEqual(["dev-1", "qa-2", "review-3"]);
  expect(world.calls.some((c) => c.includes("push origin HEAD:refs/heads/auto/cyc-1"))).toBe(true);
  const prCreate = world.calls.find((c) => c.includes("gh pr create"));
  expect(prCreate).toContain("Closes CYC-1");
  const prBody = await readFile(join(dir, "runs", "CYC-1", "pr-body.md"), "utf8");
  expect(prBody.split("\n")[0]).toBe("Closes CYC-1");
  const reviewCommentCall = world.calls.find((c) => c.includes("gh pr comment"));
  expect(reviewCommentCall).toContain("https://github.com/o/r/pull/9");
  const reviewComment = await readFile(join(dir, "runs", "CYC-1", "review-comment.md"), "utf8");
  expect(reviewComment).toContain("合并（merge）");
  expect(
    world.calls.some((c) =>
      c.includes("gh pr merge https://github.com/o/r/pull/9 --auto --squash"),
    ),
  ).toBe(true);
  const run = await store.load("CYC-1");
  expect(run?.phase).toBe("done");
  expect(run && devOf(run).reviewSessionId).toBe("review-3");
  const criteria = await store.loadCriteria("CYC-1");
  expect(criteria.allPassed).toBe(true);
  expect(sessions.deleted).toBe(0);
});

test("the PR's commit list is built with --no-merges, so a merge of main is not listed", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] });
  await s.pipeline.step();
  const log = s.world.calls.find((c) => c.includes("log --reverse"));
  expect(log).toContain("--no-merges");
});

test("auto-merge enabled and the PR merges after a few polls: delivered as before, no extra comment", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] });
  s.world.prMerge = [
    ["OPEN", "UNKNOWN"],
    ["OPEN", "MERGEABLE"],
    ["MERGED", "UNKNOWN"],
  ];
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(s.tracker.moves).toEqual(["CYC-1:inProgress"]);
  expect(s.tracker.comments.filter((c) => c.includes("已开启 GitHub 自动合并"))).toHaveLength(1);
});

test("auto-merge enabled but the PR never merges within the time limit: Blocked", async () => {
  const s = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
    { mergePollIntervalMs: 1000, mergeTimeoutMs: 3000 },
  );
  s.world.prMerge = [["OPEN", "MERGEABLE"]];
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.comments.at(-1)).toContain("没有合并");
});

test("QA failing sends findings back to Dev, then it passes", async () => {
  const { pipeline, sessions, store } = setup([ready()], {
    dev: [done(), done()],
    qa: [done(FAIL), done(PASS)],
  });
  expect((await pipeline.step()).status).toBe("delivered");
  expect(sessions.turns.filter((t) => t.startsWith("dev-1")).length).toBe(2);
  expect((await store.load("CYC-1"))?.round).toBe(1);
});

test("checks that keep failing end in Blocked, with sessions and worktree kept", async () => {
  const { pipeline, tracker, store, sessions } = setup(
    [ready()],
    { dev: [done(), done(), done(), done()], qa: [] },
    {},
    ["bun run check"],
  );
  const result = await pipeline.step();
  expect(result.status).toBe("blocked");
  expect(tracker.moves.at(-1)).toBe("CYC-1:blocked");
  const run = await store.load("CYC-1");
  expect(run?.phase).toBe("blocked");
  expect(run?.resumeFrom).toBe("verify");
  expect(run?.worktree).toBe(WT);
  expect(run?.round).toBe(3);
  expect(sessions.deleted).toBe(0);
});

test("a blocked run resumes in the same session once the ticket is back in Todo", async () => {
  const world = setup([ready()], { dev: [done(), done(), done(), done()], qa: [] }, {}, [
    "bun run check",
  ]);
  await world.pipeline.step();
  // Nothing happens while it stays Blocked.
  expect((await world.pipeline.step()).status).toBe("idle");
  world.world.fail.clear();
  world.sessions.script.qa.push(done(PASS));
  world.sessions.script.dev.push(done());
  const found = world.tracker.issues[0] as Issue;
  found.columnId = 22;
  const result = await world.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(world.sessions.created.filter((id) => id.startsWith("dev"))).toEqual(["dev-1"]);
  expect((await world.store.events()).some((e) => e.kind === "resumed")).toBe(true);
});

test("a session that cannot be continued is replaced by one that starts from the files", async () => {
  const { pipeline, sessions, store } = setup([ready()], {
    dev: [done(), new SessionLost("gone"), done(), done()],
    qa: [done(FAIL), done(PASS)],
  });
  expect((await pipeline.step()).status).toBe("delivered");
  const run = await store.load("CYC-1");
  expect(run?.replacedSessions).toEqual(["dev-1"]);
  expect(sessions.created.filter((id) => id.startsWith("dev")).length).toBe(2);
});

test("QA that changes the worktree is not trusted", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  // The status output differs between the two snapshots around the QA turn.
  const sessions = s.sessions;
  const original = sessions.turn.bind(sessions);
  sessions.turn = async (id, prompt, ctx) => {
    const out = await original(id, prompt, ctx);
    if (ctx.role === "qa") s.world.dirty = true;
    return out;
  };
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.sessions.created.filter((id) => id.startsWith("qa"))).toHaveLength(1);
  expect((await s.store.events()).some((e) => e.kind === "qa_retry")).toBe(false);
});

test("an unreadable QA verdict is retried in a fresh session, then passes", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done("looks fine"), done(PASS)] });
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect(s.sessions.created.filter((id) => id.startsWith("qa"))).toHaveLength(2);
  const retries = (await s.store.events()).filter((e) => e.kind === "qa_retry");
  expect(retries).toHaveLength(1);
});

test("a QA turn that times out or ends abnormally is retried", async () => {
  const s = setup([ready()], {
    dev: [done()],
    qa: [{ ...done("x"), timedOut: true }, { ...done("x"), stopReason: "max_tokens" }, done(PASS)],
  });
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect((await s.store.events()).filter((e) => e.kind === "qa_retry")).toHaveLength(2);
});

test("an unreadable QA verdict every time blocks as a QA system fault after maxQaRetries + 1 runs", async () => {
  const s = setup(
    [ready()],
    { dev: [done()], qa: [done("a"), done("b"), done("c"), done("d")] },
    { maxQaRetries: 2 },
  );
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.sessions.created.filter((id) => id.startsWith("qa"))).toHaveLength(3);
  expect(s.sessions.script.qa).toHaveLength(1);
  expect(s.tracker.comments.at(-1)).toContain("QA 系统故障");
  expect(s.tracker.comments.at(-1)).toContain("不是代码问题");
});

const stopped = (): TurnResult => ({
  stopReason: "error",
  text: "",
  timedOut: false,
  interrupted: true,
});

test("a Dev turn the daemon interrupted is sent again in the same session, with no fix round used", async () => {
  const s = setup([ready()], { dev: [stopped(), done()], qa: [done(PASS)] });
  expect((await s.pipeline.step()).status).toBe("delivered");
  const dev = s.sessions.prompts.filter((p) => p.role === "dev");
  expect(dev).toHaveLength(2);
  expect(dev[1]?.sessionId).toBe(dev[0]?.sessionId);
  expect(dev[1]?.prompt).toBe(dev[0]?.prompt);
  expect((await s.store.load("CYC-1"))?.round).toBe(0);
  expect(s.tracker.moves).not.toContain("CYC-1:blocked");
  expect((await s.store.events()).filter((e) => e.kind === "turn_resent")).toHaveLength(1);
});

test("a QA turn the daemon interrupted is sent again, and does not block", async () => {
  const s = setup([ready()], { dev: [done()], qa: [stopped(), done(PASS)] });
  expect((await s.pipeline.step()).status).toBe("delivered");
  const qa = s.sessions.prompts.filter((p) => p.role === "qa");
  expect(qa).toHaveLength(2);
  expect(qa[1]?.sessionId).toBe(qa[0]?.sessionId);
  expect(s.sessions.created.filter((id) => id.startsWith("qa"))).toHaveLength(1);
  expect(s.tracker.moves).not.toContain("CYC-1:blocked");
});

test("a turn the daemon interrupts every time blocks after maxInterruptRetries resends", async () => {
  const s = setup(
    [ready()],
    { dev: [stopped(), stopped(), stopped(), done()], qa: [] },
    { maxInterruptRetries: 2 },
  );
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(3);
  expect(s.tracker.comments.at(-1)).toContain("daemon 反复中断");
  expect((await s.store.events()).filter((e) => e.kind === "turn_resent")).toHaveLength(2);
});

test("an abnormal end that is not the daemon's stop blocks at once", async () => {
  const s = setup([ready()], {
    dev: [{ stopReason: "error", text: "", timedOut: false }, done()],
    qa: [],
  });
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(1);
  expect((await s.store.events()).filter((e) => e.kind === "turn_resent")).toHaveLength(0);
});

test("a crashed run is picked up where it stopped", async () => {
  const first = setup([ready()], { dev: [done()], qa: [] });
  const original = first.sessions.turn.bind(first.sessions);
  first.sessions.turn = async (id, prompt, ctx) => {
    if (ctx.role === "qa") throw new Error("killed");
    return original(id, prompt, ctx);
  };
  await expect(first.pipeline.step()).rejects.toThrow("killed");
  expect((await first.store.load("CYC-1"))?.phase).toBe("qa");

  const second = new Pipeline({
    config: config({ stateDir: dir }),
    tracker: first.tracker,
    sessions: new FakeSessions({ dev: [], qa: [done(PASS)] }),
    exec: makeExec(first.world),
    store: first.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin" },
  });
  expect((await second.step()).status).toBe("delivered");
});

test("verification commands do not get the delivery credentials", async () => {
  const seen: Record<string, string>[] = [];
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  const base = makeExec(s.world);
  const pipeline = new Pipeline({
    config: config({ stateDir: dir }),
    tracker: s.tracker,
    sessions: s.sessions,
    exec: async (argv, o) => {
      seen.push({ ...o.env, __argv: argv.join(" ") });
      return base(argv, o);
    },
    store: s.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
  });
  await pipeline.step();
  for (const env of seen) {
    expect(env.AUTO_LOOP_PLAN_KEY).toBeUndefined();
    const delivering = / push | fetch |gh /.test(env.__argv ?? "");
    expect(env.GH_TOKEN !== undefined).toBe(delivering);
  }
});

test("dry run picks and checks and writes nothing", async () => {
  const { pipeline, tracker, sessions, store, world } = setup(
    [ready()],
    { dev: [], qa: [] },
    { dryRun: true },
  );
  expect(await pipeline.step()).toEqual({ status: "would-take", key: "CYC-1", criteria: 2 });
  expect(tracker.moves).toEqual([]);
  expect(tracker.comments).toEqual([]);
  expect(sessions.created).toEqual([]);
  expect(world.calls).toEqual([]);
  expect(await store.unfinished()).toEqual([]);
  expect(await store.events()).toEqual([]);
});

test("a QA pass that does not say what was checked is retried, then blocked as a QA system fault", async () => {
  const bare = done(`<verdict>{"pass":true,"findings":[]}</verdict>`);
  const s = setup(
    [ready()],
    { dev: [done()], qa: [bare, bare, bare, done(PASS)] },
    { maxQaRetries: 2 },
  );
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.sessions.created.filter((id) => id.startsWith("qa"))).toHaveLength(3);
  expect(s.tracker.comments.at(-1)).toContain("QA 系统故障");
});

test("existing PR fallback runs gh pr edit to update title and body with Closes keyword", async () => {
  const { pipeline, world } = setup([ready()], { dev: [done()], qa: [done(PASS)] }, {}, [
    "gh pr create",
  ]);
  const result = await pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: true,
  });
  const prEdit = world.calls.find((c) => c.includes("gh pr edit"));
  expect(prEdit).toContain("Closes CYC-1");
  expect(prEdit).toContain("--body-file");
});

test("dry run idle log reports type and leaf exclusions", async () => {
  const logs: string[] = [];
  const cfg = config({ stateDir: dir, dryRun: true });
  const tracker = new FakeTracker([
    ready({ number: 1, typeId: 17 }), // Epic + auto
    ready({ number: 2, typeId: 20, subtaskCount: 2 }), // Feature parent + auto
  ]);
  const pipeline = new Pipeline({
    config: cfg,
    tracker,
    sessions: new FakeSessions({ dev: [], qa: [] }),
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
    store: SqliteStore.open(dir, () => new Date("2026-11-25T00:00:00Z")),
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: (line) => logs.push(line),
    env: { PATH: "/bin" },
    sleep: async () => {},
  });
  expect(await pipeline.step()).toEqual({ status: "idle" });
  expect(logs[0]).toBe("dry run: 2 in Todo, 2 with auto, 1 allowed type, 0 leaf");
});

test("CI all green after polling proceeds to review, auto-merge, and done", async () => {
  const { pipeline, tracker, store, world } = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
    {},
    [],
    {
      responses: [
        {
          headRefOid: "abc",
          statusCheckRollup: [
            { name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
            { name: "browser", status: "COMPLETED", conclusion: "SUCCESS" },
            { name: "integration", status: "IN_PROGRESS", conclusion: null },
          ],
        },
        greenCi("abc"),
      ],
    },
  );
  const first = await pipeline.step();
  expect(first).toEqual({ status: "waiting", key: "CYC-1", on: "ci" });
  const result = await settle({ pipeline, store });
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: true,
  });
  expect(tracker.moves).toEqual(["CYC-1:inProgress"]);
  expect(world.calls.filter((c) => c.includes("statusCheckRollup"))).toHaveLength(2);
  expect(world.calls.some((c) => c.includes("gh pr merge"))).toBe(true);
  const run = await store.load("CYC-1");
  expect(run?.phase).toBe("done");
  expect(run && devOf(run).ciRound).toBe(0);
});

test("red CI sends failure logs back to Dev, pushes fix to the same branch, then delivers when green", async () => {
  const browserFailureLog = "FAIL packages/ui/test/browser/app.test.ts: expected button visible";
  const s = setup([ready()], { dev: [done(), done()], qa: [done(PASS), done(PASS)] }, {}, [], {
    responses: [
      {
        headRefOid: "sha-1",
        statusCheckRollup: [
          {
            name: "check",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://github.com/o/r/actions/runs/10/job/101",
          },
          {
            name: "browser",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://github.com/o/r/actions/runs/10/job/555",
          },
          {
            name: "integration",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://github.com/o/r/actions/runs/10/job/103",
          },
        ],
      },
      // Stale headRefOid immediately after pushing the fix commit: must be treated as pending.
      {
        headRefOid: "sha-1",
        statusCheckRollup: [
          { name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "browser", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "integration", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      },
      greenCi("sha-2"),
    ],
    logs: { "555": browserFailureLog },
  });
  s.world.headSha = "sha-1";
  const originalTurn = s.sessions.turn.bind(s.sessions);
  let devCount = 0;
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await originalTurn(id, prompt, ctx);
    if (ctx.role === "dev") {
      devCount++;
      if (devCount === 2) s.world.headSha = "sha-2";
    }
    return out;
  };

  const result = await settle(s);
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: true,
  });

  const devPrompts = s.sessions.prompts.filter((p) => p.role === "dev");
  expect(devPrompts).toHaveLength(2);
  expect(devPrompts[1]?.prompt).toContain("browser");
  expect(devPrompts[1]?.prompt).toContain(browserFailureLog);

  // Pushed twice to the same branch; PR created once and updated via gh pr edit on retry.
  const pushes = s.world.calls.filter((c) => c.includes("push origin HEAD:refs/heads/auto/cyc-1"));
  expect(pushes).toHaveLength(2);
  expect(s.world.calls.filter((c) => c.includes("gh pr create"))).toHaveLength(1);
  expect(s.world.calls.filter((c) => c.includes("gh pr edit"))).toHaveLength(1);

  expect(s.tracker.moves).toEqual(["CYC-1:inProgress"]);
  const run = await s.store.load("CYC-1");
  expect(run?.phase).toBe("done");
  expect(run && devOf(run).ciRound).toBe(1);
  expect(run?.round).toBe(1);
});

test("red CI with no new Dev commit reruns the failed jobs and waits for the new result", async () => {
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
  const s = setup([ready()], { dev: [done(), done()], qa: [done(PASS), done(PASS)] }, {}, [], {
    responses: [
      red("777"),
      // Reading it again before the rerun: still red.
      red("777"),
      // The rerun has not shown up yet: the old attempt must not count again.
      red("777"),
      greenCi("abc"),
    ],
  });
  const result = await settle(s);
  expect(result.status).toBe("delivered");
  const reruns = s.world.calls.filter((c) => c.includes("gh run rerun"));
  expect(reruns).toEqual(["gh run rerun 20 --failed"]);
  const run = await s.store.load("CYC-1");
  expect(run && devOf(run).ciRound).toBe(1);
  expect(run && devOf(run).ciFailedSha).toBe("abc");
});

test("CI failing past retry limit ends in Blocked with failed check and log reason", async () => {
  const redIntegration = (headRefOid: string): CiResponse => ({
    headRefOid,
    statusCheckRollup: [
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://github.com/o/r/actions/runs/20/job/201",
      },
      {
        name: "browser",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://github.com/o/r/actions/runs/20/job/202",
      },
      {
        name: "integration",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/o/r/actions/runs/20/job/777",
      },
    ],
  });
  const integrationLog = "integration web suite failed: websocket closed unexpectedly";
  const { pipeline, tracker, store, sessions, world } = setup(
    [ready()],
    {
      dev: [done(), done(), done()],
      qa: [done(PASS), done(PASS), done(PASS)],
    },
    { maxCiRetries: 2 },
    [],
    {
      responses: [redIntegration("sha-1"), redIntegration("sha-2"), redIntegration("sha-3")],
      logs: { "777": integrationLog },
    },
  );

  // Each Dev turn commits, so every red run is a new CI run for a new commit.
  const originalTurn = sessions.turn.bind(sessions);
  let devTurns = 0;
  sessions.turn = async (id, prompt, ctx) => {
    const out = await originalTurn(id, prompt, ctx);
    if (ctx.role === "dev") world.headSha = `sha-${++devTurns}`;
    return out;
  };

  const result = await pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") {
    expect(result.reason).toContain("上限");
    expect(result.reason).toContain("integration");
    expect(result.reason).toContain(integrationLog);
  }
  expect(tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:blocked"]);
  expect(tracker.comments.at(-1)).toContain("integration");
  const run = await store.load("CYC-1");
  expect(run?.phase).toBe("blocked");
  expect(run?.resumeFrom).toBe("ci");
  expect(run && devOf(run).ciRound).toBe(2);
  expect(run?.worktree).toBe(WT);
  expect(sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(3);
  expect(sessions.deleted).toBe(0);
});

test("a run crashed while waiting for CI resumes in ci phase without re-running Dev or QA", async () => {
  const first = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  const baseExec = makeExec(first.world);
  const crashing = new Pipeline({
    config: config({ stateDir: dir }),
    tracker: first.tracker,
    sessions: first.sessions,
    exec: async (argv, opts) => {
      if (argv.some((a) => a.includes("statusCheckRollup"))) throw new Error("killed during ci");
      return baseExec(argv, opts);
    },
    store: first.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret" },
    sleep: async () => {},
  });
  await expect(crashing.step()).rejects.toThrow("killed during ci");
  expect((await first.store.load("CYC-1"))?.phase).toBe("ci");

  const secondSessions = new FakeSessions({ dev: [], qa: [], review: [done(REVIEW_MERGE)] });
  const second = new Pipeline({
    config: config({ stateDir: dir }),
    tracker: first.tracker,
    sessions: secondSessions,
    exec: makeExec(first.world),
    store: first.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret" },
    sleep: async () => {},
  });
  expect(await second.step()).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: true,
  });
  expect(secondSessions.prompts.map((p) => p.role)).toEqual(["review"]);
});

test("CI waiting finds the PR conflicting with main: Blocked at once with the files, merge_conflict recorded", async () => {
  const pending: CiResponse = {
    headRefOid: "abc",
    statusCheckRollup: [{ name: "check", status: "IN_PROGRESS", conclusion: null }],
  };
  const s = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)] },
    { ciPollIntervalMs: 1000, ciTimeoutMs: 60_000, maxConflictRounds: 0 },
    [],
    { responses: [pending] },
  );
  s.world.prMerge = [["OPEN", "CONFLICTING"]];
  s.world.mergeTreeOutput = "deadbeef\napps/desktop/src/main/main.ts\n";
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") {
    expect(result.reason).toContain("冲突");
    expect(result.reason).toContain("apps/desktop/src/main/main.ts");
    expect(result.reason).not.toContain("超时");
  }
  const kinds = (await s.store.events()).map((e) => e.kind);
  expect(kinds).toContain("merge_conflict");
  expect(kinds).not.toContain("ci_timeout");
});

test("CI polling timeout ends in Blocked with pending check names", async () => {
  const pendingIntegration: CiResponse = {
    headRefOid: "abc",
    statusCheckRollup: [
      { name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "browser", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "integration", status: "IN_PROGRESS", conclusion: null },
    ],
  };
  const s = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)] },
    { ciPollIntervalMs: 1000, ciTimeoutMs: 2000 },
    [],
    { responses: [pendingIntegration, pendingIntegration, pendingIntegration] },
  );
  const { pipeline, tracker, store } = s;
  expect((await pipeline.step()).status).toBe("waiting");
  // the recheck time is the deadline, so the next look finds the timeout, with or without the checker
  s.advance(3000);
  const result = await pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") {
    expect(result.reason).toContain("超时");
    expect(result.reason).toContain("integration");
  }
  expect(tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:blocked"]);
  const run = await store.load("CYC-1");
  expect(run?.phase).toBe("blocked");
  expect(run?.resumeFrom).toBe("ci");
});

test("review reject sends feedback back to Dev, re-runs CI and review, then auto-merges on merge", async () => {
  const s = setup([ready()], {
    dev: [done(), done()],
    qa: [done(PASS), done(PASS)],
    review: [done(REVIEW_REJECT), done(REVIEW_MERGE)],
  });
  s.world.headSha = "sha-1";
  const originalTurn = s.sessions.turn.bind(s.sessions);
  let devCount = 0;
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await originalTurn(id, prompt, ctx);
    if (ctx.role === "dev") {
      devCount++;
      if (devCount === 2) s.world.headSha = "sha-2";
    }
    return out;
  };

  const result = await s.pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: true,
  });

  // Second Dev prompt receives the PR review feedback.
  const devPrompts = s.sessions.prompts.filter((p) => p.role === "dev");
  expect(devPrompts).toHaveLength(2);
  expect(devPrompts[1]?.prompt).toContain("missing edge-case handling");
  expect(devPrompts[1]?.prompt).toContain("throws on empty input");
  expect(devPrompts[1]?.prompt).toContain("return early on empty input and add a test");

  // Two PR comments posted (reject then merge), PR created once and edited once, auto-merge enabled once.
  expect(s.world.calls.filter((c) => c.includes("gh pr create"))).toHaveLength(1);
  expect(s.world.calls.filter((c) => c.includes("gh pr edit"))).toHaveLength(1);
  expect(s.world.calls.filter((c) => c.includes("gh pr comment"))).toHaveLength(2);
  expect(s.world.calls.filter((c) => c.includes("gh pr merge"))).toHaveLength(1);
  expect(s.tracker.moves).toEqual(["CYC-1:inProgress"]);
  const run = await s.store.load("CYC-1");
  expect(run?.phase).toBe("done");
  expect(run?.round).toBe(1);
  // Auto-merged runs do not emit a `review` Notice.
  expect(s.store.notices().filter((n) => n.runKey === "CYC-1" && n.kind === "review")).toEqual([]);
});

test("review reject past fix-round limit escalates to human (In Review) without auto-merge", async () => {
  const { pipeline, tracker, world, store, sessions } = setup(
    [ready()],
    {
      dev: [done(), done()],
      qa: [done(PASS), done(PASS)],
      review: [done(REVIEW_REJECT), done(REVIEW_REJECT)],
    },
    { maxFixRounds: 1 },
  );

  const result = await pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: false,
  });
  expect(world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(tracker.comments.at(-1)).toContain("修复轮数上限");
  expect(sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(2);
  expect((await store.load("CYC-1"))?.phase).toBe("done");
  const limitNotices = store.notices().filter((n) => n.runKey === "CYC-1" && n.kind === "review");
  expect(limitNotices).toHaveLength(1);
  expect(limitNotices[0]?.text).toContain("修复轮数上限");
});

test("review escalate skips auto-merge, posts PR comment, and moves ticket to In Review", async () => {
  const { pipeline, tracker, world, store } = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
    review: [done(REVIEW_ESCALATE)],
  });
  const result = await pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: false,
  });
  expect(world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(world.calls.some((c) => c.includes("gh pr comment"))).toBe(true);
  const reviewComment = await readFile(join(dir, "runs", "CYC-1", "review-comment.md"), "utf8");
  expect(reviewComment).toContain("升级给人（escalate）");
  expect(reviewComment).toContain("changes permission boundary");
  expect(tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(tracker.comments.at(-1)).toContain("升级给人");
  expect(tracker.comments.at(-1)).toContain("changes permission boundary");
  expect((await store.load("CYC-1"))?.phase).toBe("done");
  const reviewNotices = store.notices().filter((n) => n.runKey === "CYC-1" && n.kind === "review");
  expect(reviewNotices).toHaveLength(1);
  expect(reviewNotices[0]?.text).toContain("needs human sign-off");
  expect(reviewNotices[0]?.text).toContain("changes permission boundary");
  expect(reviewNotices[0]?.sessionId).toBeNull();
});

test("re-running review on the same HEAD after escalate still records a fresh review Notice", async () => {
  const secondEscalate = `${CHECKED}<review>{"decision":"escalate","summary":"second pass still needs sign-off","reasons":["new reason on retry"]}</review>`;
  const s = setup([ready()], {
    dev: [done(), done()],
    qa: [done(PASS), done(PASS)],
    review: [done(REVIEW_ESCALATE), done(secondEscalate)],
  });
  await s.pipeline.step();
  const firstRun = await s.store.load("CYC-1");
  expect(firstRun?.phase).toBe("done");
  const firstNotices = s.store.notices().filter((n) => n.runKey === "CYC-1" && n.kind === "review");
  expect(firstNotices).toHaveLength(1);

  // Put the ticket back to In Progress and simulate a fresh run reaching review on the same HEAD.
  s.tracker.issues[0] = ready({ columnId: 23 });
  if (firstRun !== undefined) {
    await s.store.save({ ...firstRun, phase: "review" });
  }
  await s.pipeline.step();
  const secondRun = await s.store.load("CYC-1");
  expect(secondRun?.phase).toBe("done");
  const allNotices = s.store.notices().filter((n) => n.runKey === "CYC-1" && n.kind === "review");
  expect(allNotices).toHaveLength(2);
  const latest = allNotices[1];
  expect(latest?.text).toContain("second pass still needs sign-off");
  expect(latest?.text).toContain("new reason on retry");
  expect(
    latest !== undefined && secondRun !== undefined && latest.createdAt >= secondRun.updatedAt,
  ).toBe(true);
});

test("review retries on session error, timeout, abnormal end, unparseable output, or missing checklist, and acts on verdict when retry succeeds", async () => {
  // 1. Session turn throws on attempt 1, succeeds with merge on attempt 2.
  const errThenMerge = setup(
    [ready()],
    {
      dev: [done()],
      qa: [done(PASS)],
      review: [new Error("daemon disconnected"), done(REVIEW_MERGE)],
    },
    { maxReviewRetries: 2 },
  );
  const r1 = await errThenMerge.pipeline.step();
  expect(r1).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: true,
  });
  expect(errThenMerge.sessions.created.filter((id) => id.startsWith("review"))).toHaveLength(2);
  expect(errThenMerge.world.calls.some((c) => c.includes("gh pr merge"))).toBe(true);
  expect((await errThenMerge.store.events()).filter((e) => e.kind === "review_retry")).toHaveLength(
    1,
  );

  // 2. Session creation fails on attempt 1, succeeds on attempt 2 with escalate.
  const dir2 = await mkdtemp(join(tmpdir(), "auto-loop-create-retry-"));
  try {
    const createRetry = setup(
      [ready()],
      {
        dev: [done()],
        qa: [done(PASS)],
        review: [done(REVIEW_ESCALATE)],
        createError: { review: [new Error("transient start error"), null] },
      },
      { stateDir: dir2, maxReviewRetries: 2 },
    );
    const r2 = await createRetry.pipeline.step();
    expect(r2).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: false,
    });
    expect(createRetry.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
    expect(createRetry.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
    expect(createRetry.tracker.comments.at(-1)).toContain("升级给人（escalate）");
    expect(createRetry.tracker.comments.at(-1)).not.toContain("评审系统故障");
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }

  // 3. Timeout -> unparseable -> reject (sends back to Dev) -> missing checklist -> abnormal stop -> merge.
  const dir3 = await mkdtemp(join(tmpdir(), "auto-loop-multi-retry-"));
  try {
    const multiRetry = setup(
      [ready()],
      {
        dev: [done(), done()],
        qa: [done(PASS), done(PASS)],
        review: [
          { stopReason: "cancelled", text: "", timedOut: true },
          done("Looks good to me without tags"),
          done(REVIEW_REJECT),
          done('<review>{"decision":"merge","summary":"lgtm","reasons":[]}</review>'),
          { stopReason: "max_tokens", text: REVIEW_MERGE, timedOut: false },
          done(REVIEW_MERGE),
        ],
      },
      { stateDir: dir3, maxReviewRetries: 2 },
    );
    // The fix is a new commit: a conclusion belongs to one commit, so the fix gets its own review.
    const turn3 = multiRetry.sessions.turn.bind(multiRetry.sessions);
    let devTurns3 = 0;
    multiRetry.sessions.turn = async (id, prompt, ctx) => {
      const out = await turn3(id, prompt, ctx);
      if (ctx.role === "dev") multiRetry.world.headSha = `sha-${++devTurns3}`;
      return out;
    };
    const r3 = await multiRetry.pipeline.step();
    expect(r3).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: true,
    });
    expect(multiRetry.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(2);
    expect(multiRetry.sessions.prompts.filter((p) => p.role === "review")).toHaveLength(6);
    expect(multiRetry.world.calls.some((c) => c.includes("gh pr merge"))).toBe(true);
  } finally {
    await rm(dir3, { recursive: true, force: true });
  }
});

test("review exhausting retries on failure, timeout, or missing conclusion escalates to In Review as a review system failure", async () => {
  // 1. Persistent turn errors exhaust retries (1 initial + 2 retries = 3 attempts).
  const thrown = setup(
    [ready()],
    {
      dev: [done()],
      qa: [done(PASS)],
      review: [
        new Error("daemon disconnected 1"),
        new Error("daemon disconnected 2"),
        new Error("daemon disconnected 3"),
      ],
    },
    { maxReviewRetries: 2 },
  );
  const r1 = await thrown.pipeline.step();
  expect(r1).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: false,
  });
  expect(thrown.sessions.created.filter((id) => id.startsWith("review"))).toHaveLength(3);
  expect(thrown.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(thrown.world.calls.some((c) => c.includes("gh pr comment"))).toBe(true);
  expect(thrown.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(thrown.tracker.comments.at(-1)).toContain("评审系统故障");
  expect(thrown.tracker.comments.at(-1)).toContain("不是代码问题");
  expect(thrown.tracker.comments.at(-1)).toContain("daemon disconnected 3");
  const prComment1 = await readFile(join(dir, "runs", "CYC-1", "review-comment.md"), "utf8");
  expect(prComment1).toContain("评审系统故障");
  expect(prComment1).toContain("非代码问题");
  expect(prComment1).toContain("3 次");

  // 2. Persistent timeouts exhaust retries.
  const dir2 = await mkdtemp(join(tmpdir(), "auto-loop-timeout-exhaust-"));
  try {
    const timedOut = setup(
      [ready()],
      {
        dev: [done()],
        qa: [done(PASS)],
        review: [
          { stopReason: "cancelled", text: "", timedOut: true },
          { stopReason: "cancelled", text: "", timedOut: true },
        ],
      },
      { stateDir: dir2, maxReviewRetries: 1 },
    );
    const r2 = await timedOut.pipeline.step();
    expect(r2).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: false,
    });
    expect(timedOut.sessions.created.filter((id) => id.startsWith("review"))).toHaveLength(2);
    expect(timedOut.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
    expect(timedOut.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
    expect(timedOut.tracker.comments.at(-1)).toContain("评审系统故障");
    expect(timedOut.tracker.comments.at(-1)).toContain("超时");
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }

  // 3. Unparseable output and missing checklist exhaust retries.
  const dir3 = await mkdtemp(join(tmpdir(), "auto-loop-noverdict-exhaust-"));
  try {
    const noVerdict = setup(
      [ready()],
      {
        dev: [done()],
        qa: [done(PASS)],
        review: [
          done("Looks good to me!"),
          done('<review>{"decision":"merge","summary":"lgtm","reasons":[]}</review>'),
        ],
      },
      { stateDir: dir3, maxReviewRetries: 1 },
    );
    const r3 = await noVerdict.pipeline.step();
    expect(r3).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: false,
    });
    expect(noVerdict.sessions.created.filter((id) => id.startsWith("review"))).toHaveLength(2);
    expect(noVerdict.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
    expect(noVerdict.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
    expect(noVerdict.tracker.comments.at(-1)).toContain("评审系统故障");
    expect(noVerdict.tracker.comments.at(-1)).toContain("不是代码问题");
  } finally {
    await rm(dir3, { recursive: true, force: true });
  }

  // 4. Review session modifying the worktree stops immediately and escalates without auto-merge.
  const dir4 = await mkdtemp(join(tmpdir(), "auto-loop-dirty-review-"));
  try {
    const dirty = setup(
      [ready()],
      {
        dev: [done()],
        qa: [done(PASS)],
        review: [done(REVIEW_MERGE)],
      },
      { stateDir: dir4, maxReviewRetries: 2 },
    );
    const original = dirty.sessions.turn.bind(dirty.sessions);
    dirty.sessions.turn = async (id, prompt, ctx) => {
      const out = await original(id, prompt, ctx);
      if (ctx.role === "review") dirty.world.dirty = true;
      return out;
    };
    const r4 = await dirty.pipeline.step();
    expect(r4).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: false,
    });
    expect(dirty.sessions.created.filter((id) => id.startsWith("review"))).toHaveLength(1);
    expect(dirty.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
    expect(dirty.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
    expect(dirty.tracker.comments.at(-1)).toContain("修改了工作区");
  } finally {
    await rm(dir4, { recursive: true, force: true });
  }
});

test("enabling auto-merge failing falls back to In Review needing a person", async () => {
  const { pipeline, tracker, world } = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
    {},
    ["gh pr merge"],
  );
  const result = await pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: false,
  });
  expect(world.calls.some((c) => c.includes("gh pr merge"))).toBe(true);
  expect(tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(tracker.comments.at(-1)).toContain("开启 GitHub 自动合并失败");
});

test("review crash recovery re-checks CI and refuses auto-merge if CI is not green", async () => {
  const s = setup([ready()], { dev: [], qa: [], review: [done(REVIEW_MERGE)] }, {}, [], {
    responses: [
      {
        headRefOid: "abc",
        statusCheckRollup: [
          { name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "browser", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "integration", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      },
    ],
  });
  // Persist a run stopped in the `review` phase (simulating crash recovery).
  await s.store.saveCriteria(
    "CYC-1",
    (await import("../src/criteria.ts")).CriteriaBook.fromSpecs([
      { text: "门禁通过", verify: [["bun", "run", "check"]] },
    ]),
  );
  await s.store.save({
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

  // A run that is in review has been claimed: its work item is in progress.
  for (const i of s.tracker.issues) i.columnId = 23;
  const result = await s.pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: false,
  });
  expect(s.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(s.tracker.moves).toEqual(["CYC-1:inReview"]);
  expect(s.tracker.comments.at(-1)).toContain("CI 状态未全绿");
});

// Record store events in the same timeline as exec calls so ordering can be asserted.
const timeline = (s: ReturnType<typeof setup>) => {
  const original = s.store.event.bind(s.store);
  s.store.event = async (key, kind, data) => {
    if (kind === "review_decided" || kind === "review_done") {
      s.world.calls.push(`event:${kind}:${JSON.stringify(data)}`);
    }
    return original(key, kind, data);
  };
  // The ending of a review writes its events in the transaction of the run's save.
  const transaction = s.store.transaction.bind(s.store);
  s.store.transaction = (fn) =>
    transaction((tx) =>
      fn(
        new Proxy(tx, {
          get: (target, name) =>
            name === "event"
              ? (key: string, kind: string, data: Record<string, unknown> = {}) => {
                  if (kind === "review_done")
                    s.world.calls.push(`event:${kind}:${JSON.stringify(data)}`);
                  return target.event(key, kind, data as never);
                }
              : Reflect.get(target, name, target).bind?.(target),
        }),
      ),
    );
  return () => s.world.calls.filter((c) => c.startsWith("event:") || c.includes("gh pr merge"));
};

test("merge verdict logs review_decided before enabling auto-merge, review_done after", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] });
  const order = timeline(s);
  await s.pipeline.step();
  const seq = order();
  expect(seq).toHaveLength(3);
  expect(seq[0]).toBe('event:review_decided:{"decision":"merge"}');
  expect(seq[1]).toContain("gh pr merge");
  expect(seq[2]).toBe('event:review_done:{"decision":"merge","autoMerge":true}');
});

test("reject verdict logs review_decided before review_done", async () => {
  const s = setup(
    [ready()],
    {
      dev: [done(), done()],
      qa: [done(PASS), done(PASS)],
      review: [done(REVIEW_REJECT), done(REVIEW_REJECT)],
    },
    { maxFixRounds: 1 },
  );
  const order = timeline(s);
  await s.pipeline.step();
  const seq = order();
  expect(seq[0]).toBe('event:review_decided:{"decision":"reject"}');
  expect(seq.at(-1)).toContain("event:review_done");
  expect(seq.some((c) => c.startsWith("event:review_done"))).toBe(true);
});

test("escalate verdict logs review_decided before review_done", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_ESCALATE)] });
  const order = timeline(s);
  await s.pipeline.step();
  expect(order()).toEqual([
    'event:review_decided:{"decision":"escalate"}',
    'event:review_done:{"decision":"escalate","autoMerge":false}',
  ]);
});

test("a PR closed without merging while waiting for CI blocks the work item and nothing more is pushed", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  s.world.prState = ["OPEN", "CLOSED"]; // open at delivery, closed by the time CI is read
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.moves.at(-1)).toBe("CYC-1:blocked");
  expect(s.tracker.comments.at(-1)).toContain("PR 已被关闭");
  expect(s.tracker.comments.at(-1)).toContain("需人接手");
  expect(s.sessions.created.filter((id) => id.startsWith("review"))).toHaveLength(0);
  expect(s.world.calls.filter((c) => c.includes("push"))).toHaveLength(1);
  expect((await s.store.load("CYC-1"))?.phase).toBe("blocked");
});

test("resuming a run whose PR was closed does not push again and blocks again", async () => {
  const s = setup([ready()], { dev: [done(), done()], qa: [done(PASS), done(PASS)] });
  s.world.prState = ["OPEN", "CLOSED"];
  await s.pipeline.step();
  const pushes = s.world.calls.filter((c) => c.includes("push")).length;
  const issueNow = s.tracker.issues[0];
  if (issueNow) {
    issueNow.columnId = 22;
    issueNow.labelIds = [11];
  }
  s.world.prState = "CLOSED";
  const again = await s.pipeline.step();
  expect(again.status).toBe("blocked");
  expect(s.world.calls.filter((c) => c.includes("push"))).toHaveLength(pushes);
  expect(s.world.calls.filter((c) => c.includes("gh pr create"))).toHaveLength(1);
});

test("a merged PR counts as delivered without opening another or reviewing", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  s.world.prState = ["OPEN", "MERGED"];
  const result = await s.pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: false,
  });
  expect(s.world.calls.filter((c) => c.includes("gh pr create"))).toHaveLength(1);
  expect(s.tracker.moves.at(-1)).toBe("CYC-1:inReview");
  expect(s.tracker.comments.at(-1)).toContain("已在自动化之外合并");
  expect((await s.store.load("CYC-1"))?.phase).toBe("done");
});

test("an unreadable PR state blocks instead of being taken as open, after retries", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  s.world.prState = ["OPEN", "garbage"];
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.comments.at(-1)).toContain("读取 PR 状态失败");
  expect(s.world.calls.filter((c) => c.includes("--json state")).length).toBeGreaterThan(3);
  expect(s.sessions.created.filter((id) => id.startsWith("review"))).toHaveLength(0);
});

test("a transient PR state read failure is retried and the run goes on", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  s.world.prState = ["OPEN", "garbage", "OPEN"];
  expect((await s.pipeline.step()).status).toBe("delivered");
});

test("a PR closed while the review runs blocks before any review comment or auto-merge", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  // reads: ci guard, after CI, review guard, then closed after the review turn
  s.world.prState = ["OPEN", "OPEN", "OPEN", "CLOSED"];
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.comments.at(-1)).toContain("PR 已被关闭");
  expect(s.world.calls.some((c) => c.includes("gh pr comment"))).toBe(false);
  expect(s.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
});

test("a PR closed while CI is awaited blocks before CI results are acted on", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  s.world.prState = ["OPEN", "CLOSED"]; // ci guard, then re-read after waiting
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.sessions.created.filter((id) => id.startsWith("review"))).toHaveLength(0);
});

// ---- cleanup after Done and merged (CYC-379) ----

const doneRun = async (s: ReturnType<typeof setup>) => {
  await s.store.save({
    key: "CYC-1",
    issueId: 1,
    issueNumber: 1,
    title: "title",
    phase: "done",
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
      reviewSessionId: "review-3",
      prUrl: "https://github.com/o/r/pull/9",
    },
  });
};

const removals = (s: ReturnType<typeof setup>) =>
  s.world.calls.filter((c) => c.includes("worktree remove") || c.includes("branch -D"));

test("a Done work item with a merged PR loses its worktree, local branches, and temporary HOME", async () => {
  const s = setup([ready({ columnId: 24 })], { dev: [], qa: [] });
  s.world.prState = "MERGED";
  const tempHome = runHomeDir(dir, "CYC-1");
  await mkdir(tempHome, { recursive: true });
  await doneRun(s);
  expect((await s.pipeline.step()).status).toBe("idle");
  expect(removals(s)).toEqual([
    `git worktree remove ${WT}`,
    "git branch -D worktree-auto/cyc-1",
    "git branch -D auto/cyc-1",
  ]);
  expect(existsSync(tempHome)).toBe(false);
  expect((await s.store.load("CYC-1"))?.cleanedAt).not.toBeNull();
  expect((await s.store.events()).map((e) => e.kind)).toContain("cleaned");
  // Not again on the next round.
  await s.pipeline.step();
  expect(removals(s)).toHaveLength(3);
});

for (const [name, column, pr] of [
  ["Blocked", 35, "MERGED"],
  ["In Review", 34, "MERGED"],
  ["In Progress", 23, "MERGED"],
  ["Done but PR open", 24, "OPEN"],
  ["Done but PR closed", 24, "CLOSED"],
] as const) {
  test(`nothing is cleaned for ${name}`, async () => {
    const s = setup([ready({ columnId: column })], { dev: [], qa: [] });
    s.world.prState = pr;
    await doneRun(s);
    await s.pipeline.step();
    expect(removals(s)).toEqual([]);
    expect((await s.store.load("CYC-1"))?.cleanedAt).toBeNull();
  });
}

test("a worktree with uncommitted changes is kept and an event says so, once", async () => {
  const s = setup([ready({ columnId: 24 })], { dev: [], qa: [] });
  s.world.prState = "MERGED";
  s.world.dirty = true;
  await doneRun(s);
  await s.pipeline.step();
  await s.pipeline.step();
  expect(removals(s)).toEqual([]);
  const kinds = (await s.store.events()).map((e) => e.kind);
  expect(kinds.filter((k) => k === "cleanup_skipped_dirty")).toHaveLength(1);
  expect((await s.store.load("CYC-1"))?.cleanedAt).toBeNull();
});

// ---- Canceled, closed PR and long-Blocked runs (CYC-449) ----

const kindsOf = async (s: ReturnType<typeof setup>) => (await s.store.events()).map((e) => e.kind);

test("a Canceled work item with a clean worktree loses worktree and local branches", async () => {
  const s = setup([ready({ columnId: 25 })], { dev: [], qa: [] });
  await doneRun(s);
  await s.pipeline.step();
  expect(removals(s)).toEqual([
    `git worktree remove ${WT}`,
    "git branch -D worktree-auto/cyc-1",
    "git branch -D auto/cyc-1",
  ]);
  expect((await s.store.load("CYC-1"))?.cleanedAt).not.toBeNull();
  expect(await kindsOf(s)).toContain("cleaned");
});

test("a Canceled run that was Blocked is cleaned too", async () => {
  const s = setup([ready({ columnId: 25 })], { dev: [], qa: [] });
  await doneRun(s);
  const run = await s.store.load("CYC-1");
  if (run === undefined) throw new Error("no run");
  await s.store.save(applyPatch(run, { phase: "blocked", dev: { prUrl: null } }));
  await s.pipeline.step();
  expect(removals(s)).toHaveLength(3);
  expect(await kindsOf(s)).toContain("cleaned");
  // Not left pointing at what was removed: a resume starts from the claim with a new worktree.
  const after = await s.store.load("CYC-1");
  expect(after).toMatchObject({
    phase: "blocked",
    worktree: null,
    devSessionId: null,
    resumeFrom: "claimed",
    cleanedAt: null,
  });
});

test("a Canceled+Blocked run that is put back starts again with a new worktree", async () => {
  const s = setup([ready({ columnId: 25 })], { dev: [], qa: [] });
  await doneRun(s);
  const run = await s.store.load("CYC-1");
  if (run === undefined) throw new Error("no run");
  await s.store.save({ ...run, phase: "blocked", resumeFrom: "dev" });
  await s.pipeline.step();
  const found = s.tracker.issues[0];
  if (found === undefined) throw new Error("no issue");
  found.columnId = 22;
  await s.store.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "works", verify: [["bun", "test"]] }]),
  );
  await s.pipeline.step().catch(() => undefined);
  const after = await s.store.load("CYC-1");
  expect(s.sessions.created.length).toBeGreaterThan(0);
  expect(after?.worktree).not.toBeNull();
  expect(after?.cleanedAt).toBeNull();
});

test("a Canceled work item with uncommitted changes is kept, one event", async () => {
  const s = setup([ready({ columnId: 25 })], { dev: [], qa: [] });
  s.world.dirty = true;
  await doneRun(s);
  await s.pipeline.step();
  await s.pipeline.step();
  expect(removals(s)).toEqual([]);
  expect((await kindsOf(s)).filter((k) => k === "cleanup_skipped_dirty")).toHaveLength(1);
  expect((await s.store.load("CYC-1"))?.cleanedAt).toBeNull();
});

test("Done with the PR closed unmerged: one event, nothing removed", async () => {
  const s = setup([ready({ columnId: 24 })], { dev: [], qa: [] });
  s.world.prState = "CLOSED";
  await doneRun(s);
  await s.pipeline.step();
  await s.pipeline.step();
  expect(removals(s)).toEqual([]);
  expect((await kindsOf(s)).filter((k) => k === "cleanup_skipped_unmerged")).toHaveLength(1);
  expect((await s.store.load("CYC-1"))?.cleanedAt).toBeNull();
});

const blockedRun = async (s: ReturnType<typeof setup>) => {
  await doneRun(s);
  const run = await s.store.load("CYC-1");
  if (run === undefined) throw new Error("no run");
  await s.store.save({ ...run, phase: "blocked", blockedReason: "x", resumeFrom: "dev" });
};

test("a run Blocked past the limit gets one reminder and keeps its worktree", async () => {
  const later = { now: () => new Date("2026-12-05T00:00:00Z") };
  const s = setup([ready({ columnId: 35 })], { dev: [], qa: [] }, {}, [], {}, { clock: later });
  await blockedRun(s);
  await s.pipeline.step();
  await s.pipeline.step();
  expect(removals(s)).toEqual([]);
  expect((await kindsOf(s)).filter((k) => k === "blocked_stale")).toHaveLength(1);
});

test("a run Blocked within the limit, or with the reminder off, gets none", async () => {
  const later = { now: () => new Date("2026-12-05T00:00:00Z") };
  for (const [over, clock] of [
    [{}, { now: () => new Date("2026-11-27T00:00:00Z") }],
    [{ blockedReminderDays: 0 }, later],
  ] as const) {
    const s = setup([ready({ columnId: 35 })], { dev: [], qa: [] }, over, [], {}, { clock });
    await blockedRun(s);
    await s.pipeline.step();
    expect(await kindsOf(s)).not.toContain("blocked_stale");
    expect(removals(s)).toEqual([]);
  }
});

// ---- concurrent steps (CYC-410) ----

const gate = () => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
const dones = (n: number) => Array.from({ length: n }, () => done());
const passes = (n: number) => Array.from({ length: n }, () => done(PASS));

test("two steps at once each take a different work item, even when the tracker is slow", async () => {
  const s = setup([ready(), ready({ number: 2, key: "CYC-2", id: 2 })], {
    dev: dones(4),
    qa: passes(4),
  });
  const g = gate();
  s.tracker.gates = { listTodo: g.promise, move: g.promise };
  const a = s.pipeline.step();
  const b = s.pipeline.step();
  await Bun.sleep(10);
  g.open();
  const results = await Promise.all([a, b]);
  expect(results.map((r) => r.status)).toEqual(["delivered", "delivered"]);
  expect(results.map((r) => ("key" in r ? r.key : "")).sort()).toEqual(["CYC-1", "CYC-2"]);
  expect(s.tracker.moves.filter((m) => m.endsWith(":inProgress")).sort()).toEqual([
    "CYC-1:inProgress",
    "CYC-2:inProgress",
  ]);
});

test("two steps at once: only one goes on with an unfinished run", async () => {
  const s = setup([ready()], { dev: dones(4), qa: passes(4) });
  await s.store.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "works", verify: [["bun", "test"]] }]),
  );
  await s.store.save({
    key: "CYC-1",
    issueId: 1,
    issueNumber: 1,
    title: "t",
    phase: "claimed",
    round: 0,
    worktree: null,
    localBranch: null,
    remoteBranch: "auto/cyc-1",
    devSessionId: null,
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    kind: "dev",
    startedAt: "2026-11-24T00:00:00Z",
    updatedAt: "2026-11-24T00:00:00Z",
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
      prUrl: null,
    },
  });
  (s.tracker.issues[0] as Issue).columnId = 23;
  const g = gate();
  s.tracker.gates = { get: g.promise };
  const a = s.pipeline.step();
  const b = s.pipeline.step();
  await Bun.sleep(10);
  g.open();
  const results = await Promise.all([a, b]);
  expect(results.map((r) => r.status).sort()).toEqual(["delivered", "idle"]);
  expect((await s.store.events()).filter((e) => e.kind === "recovered").length).toBe(1);
});

test("a blocked run put back in Todo is taken up by only one of two steps", async () => {
  const s = setup([ready()], { dev: dones(5), qa: [] }, {}, ["bun run check"]);
  expect((await s.pipeline.step()).status).toBe("blocked");
  s.world.fail.clear();
  s.sessions.script.qa.push(...passes(2));
  (s.tracker.issues[0] as Issue).columnId = 22;
  const g = gate();
  s.tracker.gates = { get: g.promise, move: g.promise };
  const a = s.pipeline.step();
  const b = s.pipeline.step();
  await Bun.sleep(10);
  g.open();
  const results = await Promise.all([a, b]);
  expect(results.map((r) => r.status).sort()).toEqual(["delivered", "idle"]);
  expect((await s.store.events()).filter((e) => e.kind === "resumed").length).toBe(1);
});

test("a step that throws leaves its run to be continued by the next step", async () => {
  const s = setup([ready()], { dev: [new Error("agent crashed"), ...dones(2)], qa: passes(2) });
  await expect(s.pipeline.step()).rejects.toThrow("agent crashed");
  expect((await s.store.unfinished()).map((r) => r.key)).toEqual(["CYC-1"]);
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect((await s.store.events()).some((e) => e.kind === "recovered")).toBe(true);
});

test("when stopped, a step takes no new work item and is idle", async () => {
  const s = setup([ready()], { dev: [], qa: [] });
  s.stop.value = true;
  expect((await s.pipeline.step()).status).toBe("idle");
  expect(s.tracker.moves).toEqual([]);
  expect(await s.store.all()).toEqual([]);
});

test("a failing check passes the mid-output assertion error on to Dev", async () => {
  const output = [
    "a.test.ts:",
    "error: expect(received).toBe(expected)",
    "Expected: 42",
    "Received: 41",
    "      at <anonymous> (/wt/src/bundle.test.ts:12:9)",
    "(fail) it assembles the new bundle... [16.92ms]",
    ...Array.from({ length: 120 }, (_, i) => `(pass) later test number ${i} [1ms]`),
    "Ran 1949 tests across 200 files.",
  ].join("\n");
  expect(output.length).toBeGreaterThan(3000);
  const s = setup([ready()], { dev: [done(), done()], qa: [done(PASS)] });
  const inner = makeExec(s.world);
  let failOnce = true;
  const pipeline = new Pipeline({
    config: config({ stateDir: dir, maxVerifyRetries: 0 }),
    tracker: s.tracker,
    sessions: s.sessions,
    exec: async (argv, o) => {
      if (failOnce && argv.join(" ") === "bun run check") {
        failOnce = false;
        return { code: 1, output, timedOut: false };
      }
      return inner(argv, o);
    },
    store: s.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin" },
  });
  await pipeline.step();
  const dev = s.sessions.prompts.filter((p) => p.role === "dev");
  expect(dev.length).toBeGreaterThanOrEqual(2);
  const second = dev[1]?.prompt ?? "";
  expect(second).toContain("Expected: 42");
  expect(second).toContain("Received: 41");
  expect(second).toContain("Ran 1949 tests across 200 files.");
});

// verify retries (CYC-438)
const verifyPipeline = (
  s: ReturnType<typeof setup>,
  over: Partial<Parameters<typeof config>[0]>,
  runCheck: (n: number) => ExecResult,
) => {
  const inner = makeExec(s.world);
  const counts = { check: 0 };
  const pipeline = new Pipeline({
    config: config({ stateDir: dir, ...over }),
    tracker: s.tracker,
    sessions: s.sessions,
    exec: async (argv, o) => {
      if (argv.join(" ") === "bun run check") return runCheck(++counts.check);
      return inner(argv, o);
    },
    store: s.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin" },
  });
  return { pipeline, counts };
};

test("a flaky verify command is re-run once and passes without a fix round", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  const { pipeline, counts } = verifyPipeline(s, {}, (n) => ({
    code: n === 1 ? 1 : 0,
    output: "flaky",
    timedOut: false,
  }));
  await pipeline.step();
  const events = await s.store.events();
  const retried = events.filter((e) => e.kind === "verify_retried");
  expect(retried).toHaveLength(1);
  expect(retried[0]).toMatchObject({
    round: 0,
    command: "bun run check",
    attempt: 1,
    passed: true,
  });
  expect(events.some((e) => e.kind === "round_failed")).toBe(false);
  expect(s.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(1);
  expect(counts.check).toBe(2);
});

test("a verify command that fails again after the re-run goes back to Dev", async () => {
  const s = setup([ready()], { dev: [done(), done()], qa: [done(PASS)] });
  const { pipeline } = verifyPipeline(s, {}, (n) => ({
    code: n <= 2 ? 1 : 0,
    output: `fail ${n}`,
    timedOut: false,
  }));
  await pipeline.step();
  const events = await s.store.events();
  expect(events.find((e) => e.kind === "verify_retried")).toMatchObject({ passed: false });
  expect(events.some((e) => e.kind === "round_failed")).toBe(true);
  const dev = s.sessions.prompts.filter((p) => p.role === "dev");
  expect(dev[1]?.prompt).toContain("fail 2");
});

test("timed-out commands and maxVerifyRetries 0 are not re-run", async () => {
  for (const [over, timedOut] of [
    [{}, true],
    [{ maxVerifyRetries: 0 }, false],
  ] as const) {
    const s = setup([ready()], { dev: [done(), done()], qa: [done(PASS)] });
    const { pipeline, counts } = verifyPipeline(s, over, (n) => ({
      code: n === 1 ? 1 : 0,
      output: "x",
      timedOut: timedOut && n === 1,
    }));
    await pipeline.step();
    // Round 1 runs the command once and fails; round 2 runs it once and passes.
    // The criterion with the same command reuses that result. A stray retry would make this 3 or hide the failure.
    expect(counts.check).toBe(2);
    expect(s.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(2);
    expect((await s.store.events()).some((e) => e.kind === "verify_retried")).toBe(false);
    expect((await s.store.events()).some((e) => e.kind === "round_failed")).toBe(true);
  }
});

test("a command in both testLayers and criteria, retried to a pass, is not executed again", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  const { pipeline, counts } = verifyPipeline(s, {}, (n) => ({
    code: n === 1 ? 1 : 0,
    output: "flaky",
    timedOut: false,
  }));
  await pipeline.step();
  const events = await s.store.events();
  // `bun run check` is both the test layer and the second criterion: first run fails, retry passes, criterion reuses it.
  expect(counts.check).toBe(2);
  const retried = events.filter((e) => e.kind === "verify_retried");
  expect(retried).toHaveLength(1);
  expect(retried[0]).toMatchObject({ passed: true, attempt: 1 });
  expect(events.some((e) => e.kind === "round_failed")).toBe(false);
});

test("two runs claiming at once never run git fetch at the same time", async () => {
  const s = setup([ready(), ready({ number: 2, key: "CYC-2", id: 2 })], {
    dev: dones(4),
    qa: passes(4),
  });
  s.world.fetchLog = [];
  const results = await Promise.all([s.pipeline.step(), s.pipeline.step()]);
  expect(results.map((r) => r.status)).toEqual(["delivered", "delivered"]);
  expect(s.world.fetchLog.length).toBeGreaterThanOrEqual(4);
  expect(s.world.fetchLog.join(",")).toBe(
    Array.from({ length: s.world.fetchLog.length / 2 }, () => "start,end").join(","),
  );
});

test("the phase is mirrored from claim to delivery, each once, and cleared on delivery", async () => {
  const { pipeline, tracker } = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  expect((await pipeline.step()).status).toBe("delivered");
  expect(tracker.phases).toEqual([
    "CYC-1:dev",
    "CYC-1:verify",
    "CYC-1:qa",
    "CYC-1:ci",
    "CYC-1:review",
    "CYC-1:merge",
    "CYC-1:clear",
  ]);
});

test("Blocked clears the phase; put back in Todo, the resumed phase is written again", async () => {
  const w = setup([ready()], { dev: [done(), done(), done(), done()], qa: [] }, {}, [
    "bun run check",
  ]);
  await w.pipeline.step();
  expect(w.tracker.phases.at(-1)).toBe("CYC-1:clear");
  w.world.fail.clear();
  w.sessions.script.qa.push(done(PASS));
  w.sessions.script.dev.push(done());
  (w.tracker.issues[0] as Issue).columnId = 22;
  const before = w.tracker.phases.length;
  await w.pipeline.step();
  expect(w.tracker.phases[before]).toBe("CYC-1:verify");
});

test("a restarted process writes the phase of the run it continues", async () => {
  const first = setup([ready()], { dev: [done()], qa: [] });
  const original = first.sessions.turn.bind(first.sessions);
  first.sessions.turn = async (id, prompt, ctx) => {
    if (ctx.role === "qa") throw new Error("killed");
    return original(id, prompt, ctx);
  };
  await expect(first.pipeline.step()).rejects.toThrow("killed");
  const tracker = new FakeTracker(first.tracker.issues);
  const second = new Pipeline({
    config: config({ stateDir: dir }),
    tracker,
    sessions: new FakeSessions({ dev: [], qa: [done(PASS)] }),
    exec: makeExec(first.world),
    store: first.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin" },
  });
  await second.step();
  expect(tracker.phases[0]).toBe("CYC-1:verify");
});

test("a failing phase write changes nothing about the outcome", async () => {
  const ok = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  const bad = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  bad.tracker.failPhase = true;
  const a = await ok.pipeline.step();
  const b = await bad.pipeline.step();
  expect(b).toEqual(a);
  expect(bad.tracker.moves).toEqual(ok.tracker.moves);
  // The write stays an intent, pending, with the kind of failure and nothing else.
  const pending = bad.store
    .transaction((tx) => tx.pendingIntents())
    .filter((i) => i.kind === "phase");
  expect(pending.length).toBeGreaterThan(0);
  expect(pending[0]?.lastError).toBe("error");
});

const withCap = (w: ReturnType<typeof setup>, mirrorCapMs: number) =>
  new Pipeline({
    config: config({ stateDir: dir }),
    tracker: w.tracker,
    sessions: w.sessions,
    exec: makeExec(w.world),
    store: w.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin" },
    sleep: async () => {},
    mirrorCapMs,
  });

test("writes for one work item land in order even when an earlier one is slow", async () => {
  const w = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  const landed: string[] = [];
  w.tracker.setLoopPhase = async (i, phase) => {
    if (phase === "dev") await Bun.sleep(30);
    landed.push(`${i.key}:${phase ?? "clear"}`);
  };
  expect((await w.pipeline.step()).status).toBe("delivered");
  await Bun.sleep(60);
  // Only the newest phase is written once the slow one lands; never out of order.
  expect(landed[0]).toBe("CYC-1:dev");
  expect(landed.at(-1)).toBe("CYC-1:clear");
  expect(landed.filter((l) => l === "CYC-1:clear")).toHaveLength(1);
});

test("a write that never answers does not hold the run longer than the cap", async () => {
  const w = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  w.tracker.setLoopPhase = () => new Promise(() => {});
  const started = Date.now();
  expect((await withCap(w, 20).step()).status).toBe("delivered");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("delivery clears after a merge write that was still pending", async () => {
  const w = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  const landed: string[] = [];
  w.tracker.setLoopPhase = async (_i, phase) => {
    if (phase === "merge") await Bun.sleep(40);
    landed.push(phase ?? "clear");
  };
  expect((await w.pipeline.step()).status).toBe("delivered");
  expect(landed.slice(-2)).toEqual(["merge", "clear"]);
});

test("a failing write is retried by the next step and the run is unaffected", async () => {
  const w = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  w.tracker.failPhase = true;
  expect((await w.pipeline.step()).status).toBe("delivered");
  expect(w.tracker.phases).toEqual([]);
  w.tracker.failPhase = false;
  await w.pipeline.step();
  expect(w.tracker.phases).toEqual(["CYC-1:clear"]);
  expect(w.store.transaction((tx) => tx.pendingIntents())).toEqual([]);
});

// CYC-441: the tuning is read again before every step; a step under way keeps the values it started with.
const rejectTwice = (): Script => ({
  dev: Array.from({ length: 5 }, () => done()),
  qa: Array.from({ length: 5 }, () => done(PASS)),
  review: Array.from({ length: 5 }, () => done(REVIEW_REJECT)),
});

test("tuning changed between steps: the next step's work item runs with the new fix-round limit", async () => {
  let current: Tuning = { maxFixRounds: 1 };
  const s = setup(
    [ready()],
    rejectTwice(),
    {},
    [],
    {},
    {
      tuning: { initial: {}, reload: async () => current },
    },
  );
  // Changed by the person while this step is working: must not reach it.
  const turn = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (...a: Parameters<typeof turn>) => {
    current = { maxFixRounds: 2 };
    return turn(...a);
  };
  const first = await s.pipeline.step();
  expect(first).toMatchObject({ status: "delivered", autoMerge: false });
  expect(s.tracker.comments.at(-1)).toContain("修复轮数上限");
  expect(s.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(2);

  // The next work item takes the value written meanwhile: 2 fix rounds, so 3 Dev turns.
  s.tracker.issues.push(ready({ id: 2, number: 2, key: "CYC-2" }));
  const second = await s.pipeline.step();
  expect(second).toMatchObject({ status: "delivered", key: "CYC-2", autoMerge: false });
  expect(s.sessions.prompts.filter((p) => p.role === "dev")).toHaveLength(5);
});

test("tuning that cannot be read or is invalid: the step goes on with the last good values and says why", async () => {
  const logs: string[] = [];
  let next: () => Promise<Tuning> = async () => ({ intervalSeconds: 5 });
  const s = setup(
    [],
    { dev: [], qa: [] },
    {},
    [],
    {},
    {
      log: (l: string) => logs.push(l),
      tuning: { initial: { intervalSeconds: 30 }, reload: () => next() },
    },
  );
  expect(s.pipeline.intervalSeconds).toBe(30);
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(s.pipeline.intervalSeconds).toBe(5);

  next = async () => {
    throw new Error("tuning: invalid tuning.maxFixRounds: too big");
  };
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(s.pipeline.intervalSeconds).toBe(5);
  const problems = logs.filter((l) => l.includes("沿用上次的值"));
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("tuning.maxFixRounds");

  next = async () => ({});
  await s.pipeline.step();
  expect(s.pipeline.intervalSeconds).toBeUndefined();
});

// ---- network errors (CYC-444) ----

const NET =
  "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com";

/** A pipeline over `s`'s tracker, sessions and store whose commands matching `match` fail `times` times with `output`. */
const flaky = (
  s: ReturnType<typeof setup>,
  match: (line: string) => boolean,
  times: number,
  output: string,
  slept: number[] = [],
) => {
  const inner = makeExec(s.world);
  let left = times;
  const pipeline = new Pipeline({
    config: config({ stateDir: dir }),
    tracker: s.tracker,
    sessions: s.sessions,
    exec: async (argv, o) => {
      if (left > 0 && match(argv.join(" "))) {
        left--;
        return { code: 1, output, timedOut: false };
      }
      return inner(argv, o);
    },
    store: s.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { pipeline, left: () => left };
};

test("git fetch at claim fails twice on the network, then works: the work item starts, network_retry is logged", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] });
  const slept: number[] = [];
  const { pipeline } = flaky(s, (l) => l.includes(" fetch "), 2, NET, slept);
  const result = await pipeline.step();
  expect(result.status).toBe("delivered");
  expect(s.tracker.moves).not.toContain("CYC-1:blocked");
  expect(slept).toEqual([10_000, 30_000]);
  const retries = (await s.store.events()).filter((e) => e.kind === "network_retry");
  expect(retries.map((e) => [e.attempt, e.ok])).toEqual([
    [1, false],
    [2, true],
  ]);
  expect(JSON.stringify(retries)).not.toContain("resolve host");
});

test("reading the PR state keeps failing on the network: nothing is blocked, the run waits, the next step goes on with it", async () => {
  const s = setup([ready(), ready({ number: 2, key: "CYC-2", id: 2 })], {
    dev: [done()],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  const { pipeline, left } = flaky(
    s,
    (l) => l.includes("gh pr view") && l.includes("--json state"),
    4,
    "Post https://api.github.com/graphql: net/http: TLS handshake timeout",
  );
  const first = await pipeline.step();
  expect(first).toEqual({ status: "network_wait", key: "CYC-1", command: "gh pr view" });
  expect(left()).toBe(0);
  expect(s.tracker.moves).toEqual(["CYC-1:inProgress"]);
  expect(s.tracker.comments).toEqual([]);
  const run = (await s.store.unfinished()).find((r) => r.key === "CYC-1");
  expect(run?.phase).toBe("ci");
  const events = (await s.store.events()).map((e) => e.kind);
  expect(events).toContain("network_down");
  expect(events.filter((e) => e === "network_retry")).toHaveLength(3);

  // The network is back; the other work item in Todo is not taken before this one is finished.
  const second = await pipeline.step();
  expect(second.status).toBe("delivered");
  expect((second as { key: string }).key).toBe("CYC-1");
  expect(s.tracker.moves).not.toContain("CYC-2:inProgress");
});

test("git push rejected and an authentication failure are not retried: Blocked as before", async () => {
  for (const out of [
    " ! [rejected]        HEAD -> auto/cyc-1 (non-fast-forward)",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
  ]) {
    const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
    const { pipeline, left } = flaky(s, (l) => l.includes(" push "), 5, out);
    const result = await pipeline.step();
    expect(result.status).toBe("blocked");
    expect(left()).toBe(4);
    expect((await s.store.events()).some((e) => e.kind === "network_retry")).toBe(false);
  }
});

const REMOTE_FAILED =
  "To https://github.com/OhMyJames/cycle\n ! [remote rejected]   67dc83e426dfda26de76abacfa2072de9f02c36c -> auto/cyc-1 (failed)\nerror: failed to push some refs to 'https://github.com/OhMyJames/cycle'";

test("git push gets a reasonless [remote rejected] (failed): retried like a network error, then network_wait, not Blocked (CYC-559)", async () => {
  const s = setup([ready()], {
    dev: [done()],
    qa: [done(PASS), done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  const { pipeline, left } = flaky(s, (l) => l.includes(" push "), 4, REMOTE_FAILED);
  const first = await pipeline.step();
  expect(first).toEqual({ status: "network_wait", key: "CYC-1", command: "git push" });
  expect(left()).toBe(0);
  expect(s.tracker.moves).not.toContain("CYC-1:blocked");
  expect(s.tracker.comments).toEqual([]);
  const events = (await s.store.events()).map((e) => e.kind);
  expect(events).toContain("network_down");
  expect(events.filter((e) => e === "network_retry")).toHaveLength(3);

  // Once GitHub accepts the push, the same run goes on and is delivered.
  const second = await pipeline.step();
  expect(second.status).toBe("delivered");
  expect(s.tracker.moves).not.toContain("CYC-1:blocked");
});

test("git push rejected with a stated reason is not retried: Blocked, the reason goes into the comment (CYC-559)", async () => {
  for (const reason of [
    "protected branch hook declined",
    "pre-receive hook declined",
    "push declined due to repository rule violations",
  ]) {
    const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
    const out = ` ! [remote rejected]   HEAD -> auto/cyc-1 (${reason})`;
    const { pipeline, left } = flaky(s, (l) => l.includes(" push "), 5, out);
    const result = await pipeline.step();
    expect(result.status).toBe("blocked");
    expect(left()).toBe(4);
    expect(s.tracker.moves).toContain("CYC-1:blocked");
    expect(s.tracker.comments.join("\n")).toContain(reason);
    expect((await s.store.events()).some((e) => e.kind === "network_retry")).toBe(false);
  }
});

test("each role's session is made with that role's model and effort", async () => {
  const { pipeline, sessions } = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
    {
      devModel: "dm",
      devEffort: "de",
      qaModel: "qm",
      qaEffort: "qe",
      reviewModel: "rm",
      reviewEffort: "re",
    },
  );
  await pipeline.step();
  expect(sessions.inputs).toEqual([
    { role: "dev", model: "dm", effort: "de" },
    { role: "qa", model: "qm", effort: "qe" },
    { role: "review", model: "rm", effort: "re" },
  ]);
});

test("a replaced Dev session is made with the Dev model and effort again", async () => {
  const { pipeline, sessions } = setup(
    [ready()],
    { dev: [done(), new SessionLost("gone"), done(), done()], qa: [done(FAIL), done(PASS)] },
    { devModel: "dm", devEffort: "de" },
  );
  await pipeline.step();
  const devs = sessions.inputs.filter((i) => i.role === "dev");
  expect(devs.length).toBe(2);
  for (const d of devs) expect(d).toEqual({ role: "dev", model: "dm", effort: "de" });
});

// ---- CYC-450: node_modules is released while waiting for CI or the merge ----

const REDCI: CiResponse = {
  headRefOid: "sha-1",
  statusCheckRollup: [
    { name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "browser", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "integration", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
};
const IGNORED = "node_modules/\ncloud/loop/node_modules/\nout/\n";
const rmCalls = (calls: string[]) => calls.filter((c) => c.startsWith("rm -rf"));

test("release on: node_modules is deleted before waiting for CI, and an event is written", async () => {
  const s = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
    { releaseNodeModules: true },
  );
  s.world.ignoredDirs = IGNORED;
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect(rmCalls(s.world.calls)).toEqual(["rm -rf -- node_modules cloud/loop/node_modules"]);
  const rm = s.world.calls.findIndex((c) => c.startsWith("rm -rf"));
  const poll = s.world.calls.findIndex((c) => c.includes("statusCheckRollup"));
  expect(rm).toBeGreaterThan(s.world.calls.findIndex((c) => c.includes("gh pr create")));
  expect(rm).toBeLessThan(poll);
  const events = await s.store.events();
  expect(events.filter((e) => e.kind === "node_modules_released")).toHaveLength(1);
});

test("release on: red CI installs again before the Dev session starts; a failed install is Blocked", async () => {
  for (const installFails of [false, true]) {
    let plain: Exec = async () => ({ code: 0, output: "", timedOut: false });
    let installs = 0;
    let log: string[] = [];
    const s = setup(
      [ready()],
      { dev: [done(), done()], qa: [done(PASS), done(PASS)] },
      { releaseNodeModules: true },
      [],
      { responses: [REDCI, greenCi("sha-2")] },
      {
        exec: async (argv, o) => {
          if (argv[0] === "bun" && argv[1] === "install" && ++installs === 2 && installFails) {
            log.push("bun install");
            return { code: 1, output: "no network", timedOut: false };
          }
          return plain(argv, o);
        },
      },
    );
    plain = makeExec(s.world);
    log = s.world.calls;
    s.world.headSha = "sha-1";
    s.world.ignoredDirs = IGNORED;
    const originalTurn = s.sessions.turn.bind(s.sessions);
    s.sessions.turn = async (id, prompt, ctx) => {
      if (ctx.role === "dev") log.push("turn:dev");
      return originalTurn(id, prompt, ctx);
    };
    const result = await s.pipeline.step();
    const order = log.filter(
      (c) => c === "turn:dev" || c.startsWith("rm -rf") || c === "bun install",
    );
    const head = [
      "bun install",
      "turn:dev",
      "rm -rf -- node_modules cloud/loop/node_modules",
      "bun install",
    ];
    expect(order.slice(0, 4)).toEqual(head);
    if (installFails) {
      expect(result.status).toBe("blocked");
      expect(order).toHaveLength(4);
      expect(s.tracker.moves.at(-1)).toBe("CYC-1:blocked");
    } else {
      expect(order[4]).toBe("turn:dev");
      expect((await s.store.events()).some((e) => e.kind === "node_modules_restored")).toBe(true);
    }
  }
});

test("release off (default): nothing is deleted and no event is written", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] });
  s.world.ignoredDirs = IGNORED;
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect(rmCalls(s.world.calls)).toEqual([]);
  expect((await s.store.events()).filter((e) => e.kind.startsWith("node_modules"))).toEqual([]);
});

test("release on, worktree with uncommitted changes: nothing is deleted", async () => {
  let plain: Exec = async () => ({ code: 0, output: "", timedOut: false });
  const s = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
    { releaseNodeModules: true },
    [],
    {},
    {
      exec: async (argv, o) => {
        const out = await plain(argv, o);
        // Something is edited in the worktree once the PR is up.
        if (argv.join(" ").includes("gh pr create")) s.world.dirty = true;
        return out;
      },
    },
  );
  plain = makeExec(s.world);
  s.world.ignoredDirs = IGNORED;
  await s.pipeline.step();
  expect(rmCalls(s.world.calls)).toEqual([]);
  expect((await s.store.events()).some((e) => e.kind === "node_modules_kept")).toBe(true);
});

test("a run that enters verify with node_modules released installs first", async () => {
  const s = setup(
    [ready({ columnId: 23 })],
    { dev: [], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
    { releaseNodeModules: true },
  );
  await s.store.saveCriteria(
    "CYC-1",
    (await import("../src/criteria.ts")).CriteriaBook.fromSpecs([
      { text: "门禁通过", verify: [["bun", "run", "check"]] },
    ]),
  );
  await s.store.save({
    key: "CYC-1",
    issueId: 1,
    issueNumber: 1,
    title: "title",
    phase: "verify",
    round: 0,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "dev-1",
    qaSessionId: null,
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
      nodeModulesReleased: true,
      fullFlowDocs: [],
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      prUrl: null,
    },
  });
  await s.pipeline.step();
  const install = s.world.calls.indexOf("bun install");
  const check = s.world.calls.findIndex((c) => c.startsWith("bun run check"));
  expect(install).toBeGreaterThanOrEqual(0);
  expect(install).toBeLessThan(check);
  expect((await s.store.events()).some((e) => e.kind === "node_modules_restored")).toBe(true);
});

test("a failed rm keeps the released flag, so the next Dev or verify installs again", async () => {
  const s = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
    { releaseNodeModules: true },
    ["rm -rf"],
  );
  s.world.ignoredDirs = IGNORED;
  await s.pipeline.step();
  const run = await s.store.load("CYC-1");
  expect(run && devOf(run).nodeModulesReleased).toBe(true);
  expect((await s.store.events()).some((e) => e.kind === "node_modules_release_failed")).toBe(true);
});

// ---- CYC-448: measured disk use of bun install ----

const dfExec = (
  s: ReturnType<typeof setup>,
  free: (number | "bad" | "exit1")[],
  failDf = false,
) => {
  const base = makeExec(s.world);
  return async (argv: string[], o: Parameters<typeof base>[1]) => {
    if (argv[0] === "df") {
      if (failDf) throw new Error("spawn df ENOENT");
      const n = free.length > 1 ? free.shift() : free[0];
      if (n === "exit1") return { code: 1, output: "", timedOut: false };
      if (n === "bad") return { code: 0, output: "garbage\n", timedOut: false };
      return {
        code: 0,
        output: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 1000 1 ${n} 1% /secret/mount\n`,
        timedOut: false,
      };
    }
    return base(argv, o);
  };
};

const withExec = (s: ReturnType<typeof setup>, exec: Exec) =>
  new Pipeline({
    config: config({ stateDir: dir }),
    tracker: s.tracker,
    sessions: s.sessions,
    exec,
    store: s.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async () => {},
  });

test("the free-space drop across bun install is recorded as install_measured, numbers only", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  await withExec(s, dfExec(s, [5000, 3500])).step();
  const ev = (await s.store.events()).find((e) => e.kind === "install_measured");
  expect(ev).toMatchObject({ measured: true, freeKbBefore: 5000, freeKbAfter: 3500, usedKb: 1500 });
  expect(JSON.stringify(ev)).not.toContain("/secret");
});

test("when df is unavailable, install_measured says so and bun install and the run carry on", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  await withExec(s, dfExec(s, [1], true)).step();
  const ev = (await s.store.events()).find((e) => e.kind === "install_measured");
  expect(ev).toMatchObject({ measured: false });
  expect(s.world.calls.some((c) => c === "bun install")).toBe(true);
  expect((await s.store.events()).some((e) => e.kind === "dev_session")).toBe(true);
  expect(s.tracker.moves.at(-1)).not.toBe("CYC-1:blocked");
});

const installEvents = async (s: ReturnType<typeof setup>) =>
  (await s.store.events()).filter((e) => e.kind === "install_measured");

test.each([
  ["df exits non-zero", ["exit1"]],
  ["df output is unparseable", ["bad"]],
  ["only the first reading works", [5000, "bad"]],
  ["free space grew during the install", [3000, 5000]],
] as const)(
  "install_measured is measured:false when %s, and the run carries on",
  async (_n, free) => {
    const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
    await withExec(s, dfExec(s, [...free])).step();
    expect(await installEvents(s)).toMatchObject([{ measured: false }]);
    expect(s.world.calls).toContain("bun install");
  },
);

test("a device name with spaces does not shift the Available column", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] });
  const base = makeExec(s.world);
  const free = [900, 400];
  const exec: Exec = async (argv, o) =>
    argv[0] === "df"
      ? {
          code: 0,
          output: `Filesystem 1024-blocks Used Available Capacity Mounted on\nmy disk 1000 1 ${free.shift()} 1% /Volumes/My Disk\n`,
          timedOut: false,
        }
      : base(argv, o);
  await withExec(s, exec).step();
  expect(await installEvents(s)).toMatchObject([{ measured: true, usedKb: 500 }]);
});

test("a failed bun install writes no install_measured event", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)] }, {}, ["bun install"]);
  await withExec(s, dfExec(s, [5000, 3000])).step();
  expect(await installEvents(s)).toEqual([]);
});

test("resuming on an existing worktree reinstalls but does not measure (bun install is a no-op there)", async () => {
  const w = setup([ready()], { dev: [done()], qa: [] }, {}, ["bun install"]);
  expect((await w.pipeline.step()).status).toBe("blocked");
  expect(await installEvents(w)).toEqual([]);
  const installs = w.world.calls.filter((c) => c === "bun install").length;
  w.world.fail.clear();
  w.sessions.script.qa.push(done(PASS));
  (w.tracker.issues[0] as Issue).columnId = 22;
  await withExec(w, dfExec(w, [5000, 4999])).step();
  expect(w.world.calls.filter((c) => c === "bun install").length).toBeGreaterThan(installs);
  expect(await installEvents(w)).toEqual([]);
});

test("a move to In Review that fails after the review: one ticket comment, one PR comment, made up later", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_ESCALATE)] });
  const move = s.tracker.move.bind(s.tracker);
  let failing = true;
  s.tracker.move = async (i, stage) => {
    if (failing && stage === "inReview") throw new Error("tracker down");
    return move(i, stage);
  };
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect((await s.store.load("CYC-1"))?.phase).toBe("done");
  const prComments = () => s.world.calls.filter((c) => c.includes("gh pr comment")).length;
  expect(prComments()).toBe(1);
  expect(s.tracker.comments.filter((c) => c.includes("escalate"))).toHaveLength(1);
  const run = await s.store.load("CYC-1");
  expect(run?.kind === "dev" ? run.dev.reviewCommented : undefined).toMatch(/:escalate$/);
  failing = false;
  await s.pipeline.step();
  expect(s.tracker.moves.at(-1)).toBe("CYC-1:inReview");
  expect(prComments()).toBe(1);
  expect(s.tracker.comments.filter((c) => c.includes("escalate"))).toHaveLength(1);
});

// CYC-467: a person edits the body of a blocked work item and puts it back
const blockedInVerify = async () => {
  const s = setup([ready()], { dev: Array.from({ length: 8 }, () => done()), qa: [] }, {}, [
    "bun run check",
  ]);
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect((await s.store.load("CYC-1"))?.resumeFrom).toBe("verify");
  return s;
};

test("a blocked run put back with an edited body: the criteria are read again and Dev is told", async () => {
  const s = await blockedInVerify();
  const before = s.sessions.prompts.filter((p) => p.role === "dev").length;
  const found = s.tracker.issues[0] as Issue;
  found.description = readyDescription.replace("开关可用", "开关在设置页可用");
  found.columnId = 22;
  await s.pipeline.step();
  const after = s.sessions.prompts.filter((p) => p.role === "dev").slice(before);
  expect(after.length).toBeGreaterThan(0);
  expect(after[0]?.prompt).toContain("A person edited CYC-1");
  expect(after[0]?.prompt).toContain("开关在设置页可用");
  expect(after[0]?.prompt).toContain("fix round");
  // said once, in the same session
  expect(after.slice(1).some((p) => p.prompt.includes("A person edited"))).toBe(false);
  expect(s.sessions.created.filter((id) => id.startsWith("dev"))).toEqual(["dev-1"]);
  const book = await s.store.loadCriteria("CYC-1");
  expect(book.items[0]?.text).toContain("开关在设置页可用");
  expect((await s.store.events()).filter((e) => e.kind === "resumed").at(-1)?.reread).toBe(true);
});

test("a blocked run put back with an unchanged body goes on as before", async () => {
  const s = await blockedInVerify();
  const before = s.sessions.prompts.filter((p) => p.role === "dev").length;
  (s.tracker.issues[0] as Issue).columnId = 22;
  await s.pipeline.step();
  const after = s.sessions.prompts.filter((p) => p.role === "dev").slice(before);
  expect(after.length).toBeGreaterThan(0);
  expect(after.some((p) => p.prompt.includes("A person edited"))).toBe(false);
  expect(s.sessions.created.filter((id) => id.startsWith("dev"))).toEqual(["dev-1"]);
  expect((await s.store.events()).filter((e) => e.kind === "resumed").at(-1)?.reread).toBe(false);
});

test("a blocked run put back with an edited body that fails the preflight is sent back", async () => {
  const s = await blockedInVerify();
  const found = s.tracker.issues[0] as Issue;
  found.description = "no criteria any more";
  found.columnId = 22;
  const result = await s.pipeline.step();
  expect(result.status).toBe("rejected");
  expect((await s.store.load("CYC-1"))?.phase).toBe("blocked");
  expect(s.tracker.moves.at(-1)).toBe("CYC-1:blocked");
});

test("a blocked run begun before the body hash was kept still notices an edited body", async () => {
  const s = await blockedInVerify();
  const run = await s.store.load("CYC-1");
  if (run === undefined || run.kind !== "dev") throw new Error("no dev run");
  await s.store.save({ ...run, dev: { ...run.dev, bodyHash: null }, resumeFrom: "qa" });
  const found = s.tracker.issues[0] as Issue;
  found.description = readyDescription.replace("开关可用", "开关在设置页可用");
  found.columnId = 22;
  await s.pipeline.step();
  expect((await s.store.events()).filter((e) => e.kind === "resumed").at(-1)?.reread).toBe(true);
  // the criteria start pending, so the run goes back to the checks instead of on to QA
  expect((await s.store.events()).filter((e) => e.kind === "resumed").at(-1)?.phase).toBe("verify");
});

test("a legacy run whose edited body fails the preflight is sent back, not resumed on old criteria", async () => {
  const s = await blockedInVerify();
  const run = await s.store.load("CYC-1");
  if (run === undefined || run.kind !== "dev") throw new Error("no dev run");
  await s.store.save({ ...run, dev: { ...run.dev, bodyHash: null } });
  const found = s.tracker.issues[0] as Issue;
  found.description = "no criteria any more";
  found.columnId = 22;
  expect((await s.pipeline.step()).status).toBe("rejected");
  expect((await s.store.load("CYC-1"))?.phase).toBe("blocked");
});

test("an edit that leaves the criteria alone still tells Dev, and the checks do not restart", async () => {
  const s = await blockedInVerify();
  const before = s.sessions.prompts.filter((p) => p.role === "dev").length;
  const found = s.tracker.issues[0] as Issue;
  found.description = `${readyDescription}\n补充说明：已决定。\n`;
  found.columnId = 22;
  await s.pipeline.step();
  const after = s.sessions.prompts.filter((p) => p.role === "dev").slice(before);
  expect(after[0]?.prompt).toContain("A person edited CYC-1");
  expect(after[0]?.prompt).toContain("补充说明：已决定");
});

const twoNodePlan = `# Plan

## 执行图

\`\`\`json
{
  "nodes": [
    {
      "id": "n2",
      "title": "接入引擎",
      "goal": "在 devFlow 里驱动节点循环",
      "dependsOn": ["n1"],
      "filesHint": ["cloud/loop/src/flows/dev/"],
      "verify": ["bun test ./cloud/loop/test/pipeline.test.ts"]
    },
    {
      "id": "n1",
      "title": "新增表结构",
      "goal": "在 schema.ts 新增 run_graphs 与 graph_nodes",
      "dependsOn": [],
      "filesHint": ["cloud/loop/src/db/schema.ts"],
      "verify": ["bun test ./cloud/loop/test/db.test.ts"]
    }
  ]
}
\`\`\`
`;

test("Task Graph: Plan with invalid fenced JSON graph is rejected at preflight with [Blocked:需规格]", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), { dev: [], qa: [] });
  s.tracker.docContent[103] =
    '# Plan\n\n## 执行图\n\n```json\n[{"id":"n1","title":"A","goal":"a","dependsOn":["n2"],"verify":["bun run check"]},{"id":"n2","title":"B","goal":"b","dependsOn":["n1"],"verify":["bun run check"]}]\n```\n';
  const result = await s.pipeline.step();
  expect(result.status).toBe("rejected");
  expect(s.tracker.moves).toEqual(["CYC-1:blocked"]);
  expect(s.tracker.comments[0]).toContain("[Blocked:需规格]");
  expect(s.tracker.comments[0]).toContain("cycle");
  expect(s.sessions.created).toEqual([]);
});

test("Task Graph: multi-node Plan runs a fresh Dev session per node in topological order and opens 1 PR", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), {
    dev: [
      done("<progress>done: n1 schema ready\nnext: n2</progress>"),
      done("<progress>done: n2 engine wired\nnext: verify</progress>"),
    ],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[102] = "# Design\n\nUse SQLite graph_nodes.";
  s.tracker.docContent[103] = twoNodePlan;

  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");

  // Two distinct fresh Dev sessions created in topological order (n1 before n2), on the same worktree.
  const devSessions = s.sessions.titles.filter((c) => c.role === "dev");
  expect(devSessions.map((c) => c.title)).toEqual(["[CYC-1 · n1] Dev", "[CYC-1 · n2] Dev"]);

  // Prompts give n1 its goal and give n2 the upstream n1 summary + Design contract.
  const devPrompts = s.sessions.prompts.filter((p) => p.role === "dev").map((p) => p.prompt);
  expect(devPrompts[0]).toContain("新增表结构");
  expect(devPrompts[0]).toContain("Use SQLite graph_nodes.");
  expect(devPrompts[1]).toContain("接入引擎");
  expect(devPrompts[1]).toContain("n1 schema ready");

  // One-way summary comment posted to tracker when multi-node graph starts.
  expect(
    s.tracker.comments.some((c) => c.includes("Loop 已按执行图（2 个二级节点）开始执行")),
  ).toBe(true);

  // Graph state persisted in loop.db with both nodes passed and commit SHAs recorded.
  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.nodes.map((n) => [n.id, n.status, n.commitSha])).toEqual([
    ["n1", "passed", "abc"],
    ["n2", "passed", "abc"],
    ["qa-1", "passed", "abc"],
  ]);
  const qaNode = graph?.nodes.find((n) => n.id === "qa-1");
  expect(qaNode?.role).toBe("qa");
  expect(qaNode?.verdict).toBe("pass");
  expect(qaNode?.dependsOn).toEqual(["n2"]);
  expect(qaNode?.sessionId).not.toBeNull();
  expect(s.sessions.titles.filter((c) => c.role === "qa")).toHaveLength(1);
  const qaPrompt = s.sessions.prompts.find((p) => p.role === "qa")?.prompt ?? "";
  expect(qaPrompt).toContain("do not use `cd`");

  // Single PR opened, body includes Task Graph section.
  const prCreateCalls = s.world.calls.filter((c) => c.startsWith("gh pr create"));
  expect(prCreateCalls).toHaveLength(1);
  const prBody = await readFile(join(s.cfg.stateDir, "runs", "CYC-1", "pr-body.md"), "utf8");
  expect(prBody).toContain("## 执行图（Task Graph）");
  expect(prBody).toContain("`n1`");
  expect(prBody).toContain("`n2`");
});

test("Task Graph: node-local verify failure retries in the same node session before moving on", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), {
    dev: [
      done("<progress>done: n1 attempt 1\nnext: check</progress>"),
      done("<progress>done: n1 attempt 2\nnext: n2</progress>"),
      done("<progress>done: n2 done\nnext: qa</progress>"),
    ],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = twoNodePlan;

  // Fail n1's local verify command on the first turn, then pass after the node fix turn.
  let dbTestCalls = 0;
  const baseExec = makeExec(s.world);
  const pipeline = new Pipeline({
    config: { ...s.cfg, maxVerifyRetries: 0 },
    tracker: s.tracker,
    sessions: s.sessions,
    exec: async (argv, opts) => {
      if (argv.join(" ") === "bun test ./cloud/loop/test/db.test.ts") {
        dbTestCalls++;
        if (dbTestCalls === 1)
          return { code: 1, output: "1 fail\nboom in db test", timedOut: false };
      }
      return baseExec(argv, opts);
    },
    store: s.store,
    clock: { now: () => new Date("2026-11-25T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async () => {},
    stopped: () => false,
  });

  const result = await pipeline.step();
  expect(result.status).toBe("delivered");
  // Still only 2 Dev sessions: n1 retried inside its own session, then n2 got a fresh session.
  const devSessions = s.sessions.titles.filter((c) => c.role === "dev");
  expect(devSessions.map((c) => c.title)).toEqual(["[CYC-1 · n1] Dev", "[CYC-1 · n2] Dev"]);
  const devPrompts = s.sessions.prompts.filter((p) => p.role === "dev").map((p) => p.prompt);
  expect(devPrompts[1]).toContain("Node `n1`");
  expect(devPrompts[1]).toContain("boom in db test");
  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.nodes[0]?.rounds).toBe(1);
});

test("Task Graph: whole-item QA rejection appends a fix-1 node (origin: fix) and delivers 1 PR", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), {
    dev: [
      done("<progress>done: n1\nnext: n2</progress>"),
      done("<progress>done: n2\nnext: qa</progress>"),
      done("<progress>done: fixed QA finding\nnext: qa</progress>"),
    ],
    qa: [done(FAIL), done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = twoNodePlan;

  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");

  const devSessions = s.sessions.titles.filter((c) => c.role === "dev");
  expect(devSessions.map((c) => c.title)).toEqual([
    "[CYC-1 · n1] Dev",
    "[CYC-1 · n2] Dev",
    "[CYC-1 · fix-1] Dev",
  ]);

  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.nodes.map((n) => [n.id, n.origin, n.status, n.dependsOn])).toEqual([
    ["n1", "planned", "passed", []],
    ["n2", "planned", "passed", ["n1"]],
    ["qa-1", "planned", "passed", ["n2"]],
    ["fix-1", "fix", "passed", ["n1", "n2", "qa-1"]],
    ["qa-2", "fix", "passed", ["fix-1"]],
  ]);
  const qaNodes = graph?.nodes.filter((n) => n.role === "qa") ?? [];
  expect(qaNodes.map((n) => n.verdict)).toEqual(["fail", "pass"]);
  expect(qaNodes[0]?.report).not.toBeNull();
  expect(qaNodes.every((n) => n.commitSha === "abc")).toBe(true);
  // Each QA node ran in a session of its own; the second was told the first one's report.
  expect(new Set(qaNodes.map((n) => n.sessionId)).size).toBe(2);
  expect(s.sessions.titles.filter((c) => c.role === "qa")).toHaveLength(2);
  const qaPrompts = s.sessions.prompts.filter((p) => p.role === "qa").map((p) => p.prompt);
  expect(qaPrompts[0]).not.toContain("An earlier independent review");
  expect(qaPrompts[1]).toContain("An earlier independent review");
  expect(qaPrompts[1]).toContain(qaNodes[0]?.report as string);

  const prBody = await readFile(join(s.cfg.stateDir, "runs", "CYC-1", "pr-body.md"), "utf8");
  expect(prBody).toContain("`fix-1`");
});

const researchPlan = () => `# Plan

## 执行图

\`\`\`json
{
  "nodes": [
    {
      "id": "r1",
      "role": "research",
      "title": "查现有节点循环",
      "goal": "弄清 devFlow 现在怎样驱动节点循环",
      "dependsOn": [],
      "filesHint": ["cloud/loop/src/flows/dev/"]
    },
    {
      "id": "n1",
      "title": "接入引擎",
      "goal": "按调研结论改 devFlow",
      "dependsOn": ["r1"],
      "verify": ["bun test ./cloud/loop/test/pipeline.test.ts"]
    }
  ]
}
\`\`\`
`;

const researchReply = (report = "## 问题 1\n节点循环在 graph.ts，依据 `rg nodeDev`。") =>
  `<summary>循环在 graph.ts。</summary>\n<report>\n${report}\n</report>\n<followup type="Bug" title="x">ignored</followup>`;

test("Task Graph: a research node runs read-only, keeps its report, and the Dev node after it is given it", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), {
    dev: [done("<progress>done: n1\nnext: qa</progress>")],
    research: [done(researchReply())],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = researchPlan();

  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");

  const graph = await s.store.loadGraph("CYC-1");
  const r1 = graph?.nodes.find((n) => n.id === "r1");
  expect(r1?.status).toBe("passed");
  expect(r1?.role).toBe("research");
  expect(r1?.commitSha).toBeNull();
  expect(r1?.summary).toBe("循环在 graph.ts。");
  expect(r1?.report).toContain("节点循环在 graph.ts");
  expect(graph?.nodes.map((n) => n.id)).toEqual(["r1", "n1", "qa-1"]);
  // The follow-up draft is ignored; nothing is created in the tracker for it.
  expect(s.tracker.written).toEqual([]);

  const research = s.sessions.prompts.filter((p) => p.role === "research");
  expect(research).toHaveLength(1);
  expect(research[0]?.prompt).toContain("READ-ONLY");
  expect(research[0]?.prompt).toContain("弄清 devFlow 现在怎样驱动节点循环");
  // No checkpoint commit for the read-only node.
  expect(s.world.calls.filter((c) => c.includes("r1]"))).toEqual([]);

  const devPrompt = s.sessions.prompts.find((p) => p.role === "dev")?.prompt ?? "";
  expect(devPrompt).toContain("Research report of node `r1`");
  expect(devPrompt).toContain("节点循环在 graph.ts");
  // Whole-item QA is given the report too, and there is no QA node after the research node.
  const qaPrompt = s.sessions.prompts.find((p) => p.role === "qa")?.prompt ?? "";
  expect(qaPrompt).toContain("节点循环在 graph.ts");
});

test("Task Graph: a research node's long report is cut in the Dev prompt and says where the rest is", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), {
    dev: [done("<progress>done: n1\nnext: qa</progress>")],
    research: [done(researchReply(`## 问题 1\n${"长".repeat(13_000)}`))],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = researchPlan();
  expect((await s.pipeline.step()).status).toBe("delivered");
  const devPrompt = s.sessions.prompts.find((p) => p.role === "dev")?.prompt ?? "";
  expect(devPrompt).toContain("报告已截断，全文见执行图节点 r1");
  expect(devPrompt).not.toContain("长".repeat(12_100));
  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.nodes[0]?.report).toContain("长".repeat(13_000));
});

test("Task Graph: a research reply missing the report is sent back in the same session", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), {
    dev: [done("<progress>done: n1\nnext: qa</progress>")],
    research: [done("<summary>只有摘要</summary>"), done(researchReply())],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = researchPlan();
  expect((await s.pipeline.step()).status).toBe("delivered");
  const research = s.sessions.prompts.filter((p) => p.role === "research");
  expect(research).toHaveLength(2);
  expect(research[1]?.sessionId).toBe(research[0]?.sessionId);
  expect(research[1]?.prompt).toContain("There is no <report>");
  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.nodes[0]?.rounds).toBe(1);
});

test("Task Graph: a research node that changes the worktree blocks the run", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), {
    dev: [],
    research: [done(researchReply())],
    qa: [],
  });
  s.tracker.docContent[103] = researchPlan();
  const original = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await original(id, prompt, ctx);
    if (ctx.role === "research") s.world.dirty = true;
    return out;
  };
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("修改了工作区");
  expect(s.sessions.prompts.filter((p) => p.role === "dev")).toEqual([]);
});

test("Task Graph: node asking a <question> blocks on that node and resumes without re-running passed nodes", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), {
    dev: [
      done("<progress>done: n1\nnext: n2</progress>"),
      done(
        "<question>Should n2 expose a retry button?</question><progress>done: partial\nnext: wait</progress>",
      ),
      done("<progress>done: n2 finished after answer\nnext: qa</progress>"),
    ],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = twoNodePlan;

  const first = await s.pipeline.step();
  expect(first.status).toBe("blocked");
  const blockedGraph = await s.store.loadGraph("CYC-1");
  expect(blockedGraph?.nodes.map((n) => [n.id, n.status])).toEqual([
    ["n1", "passed"],
    ["n2", "blocked"],
  ]);

  // Human answers and moves ticket back to Todo.
  (s.tracker.issues[0] as Issue).columnId = 22;
  const second = await s.pipeline.step();
  expect(second.status).toBe("delivered");

  // Only 2 Dev sessions total: n1 was NOT re-run, n2 resumed in its preserved session.
  const devSessions = s.sessions.titles.filter((c) => c.role === "dev");
  expect(devSessions.map((c) => c.title)).toEqual(["[CYC-1 · n1] Dev", "[CYC-1 · n2] Dev"]);
  const finalGraph = await s.store.loadGraph("CYC-1");
  expect(finalGraph?.nodes.map((n) => [n.id, n.status])).toEqual([
    ["n1", "passed"],
    ["n2", "passed"],
    ["qa-1", "passed"],
  ]);
});

test("Task Graph: crash recovery resumes directly on the active node without re-running passed nodes", async () => {
  const s = await setupFullFlow([fullFlowIssue({ columnId: 23 })], fourDocs(), {
    dev: [done("<progress>done: n2 after restart\nnext: qa</progress>")],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = twoNodePlan;
  const nowIso = "2026-11-25T00:00:00Z";
  await s.store.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "check", verify: [["bun", "run", "check"]] }]),
  );
  await s.store.saveGraph({
    runKey: "CYC-1",
    source: "plan_doc",
    revision: 1,
    currentNodeId: "n2",
    createdAt: nowIso,
    updatedAt: nowIso,
    nodes: [
      {
        id: "n1",
        position: 0,
        origin: "planned",
        title: "新增表结构",
        goal: "Schema",
        dependsOn: [],
        filesHint: [],
        verify: ["bun test ./cloud/loop/test/db.test.ts"],
        status: "passed",
        sessionId: "old-n1",
        commitSha: "1111aaaa",
        rounds: 0,
        lastError: null,
        summary: "n1 done before crash",
        startedAt: nowIso,
        finishedAt: nowIso,
        role: "dev",
        verdict: null,
        report: null,
      },
      {
        id: "n2",
        position: 1,
        origin: "planned",
        title: "接入引擎",
        goal: "Wire engine",
        dependsOn: ["n1"],
        filesHint: [],
        verify: ["bun test ./cloud/loop/test/pipeline.test.ts"],
        status: "running",
        sessionId: null,
        commitSha: null,
        rounds: 0,
        lastError: null,
        summary: null,
        startedAt: nowIso,
        finishedAt: null,
        role: "dev",
        verdict: null,
        report: null,
      },
    ],
  });
  await s.store.save({
    key: "CYC-1",
    kind: "dev",
    issueId: 1,
    issueNumber: 1,
    title: "Test",
    phase: "dev",
    round: 0,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "old-n1",
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    startedAt: nowIso,
    updatedAt: nowIso,
    dev: {
      ciRound: 0,
      ciFailedSha: null,
      ciWait: null,
      nodeModulesReleased: false,
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      prUrl: null,
      fullFlowDocs: fourDocs().map((d) => ({ id: d.id, title: d.title, version: d.version })),
      activeNodeId: "n2",
    },
  });

  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  const devSessions = s.sessions.titles.filter((c) => c.role === "dev");
  expect(devSessions.map((c) => c.title)).toEqual(["[CYC-1 · n2] Dev"]);
  const finalGraph = await s.store.loadGraph("CYC-1");
  expect(finalGraph?.nodes.map((n) => [n.id, n.status, n.commitSha])).toEqual([
    ["n1", "passed", "1111aaaa"],
    ["n2", "passed", "abc"],
    ["qa-1", "passed", "abc"],
  ]);
});

test("Task Graph: a run left in qa by an older version gets a QA node and goes on", async () => {
  const s = await setupFullFlow([fullFlowIssue({ columnId: 23 })], fourDocs(), {
    dev: [],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = twoNodePlan;
  const nowIso = "2026-11-25T00:00:00Z";
  await s.store.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "check", verify: [["bun", "run", "check"]] }]),
  );
  await s.store.saveGraph({
    runKey: "CYC-1",
    source: "plan_doc",
    revision: 1,
    currentNodeId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    nodes: [
      {
        id: "n1",
        position: 0,
        origin: "planned",
        title: "新增表结构",
        goal: "Schema",
        dependsOn: [],
        filesHint: [],
        verify: ["bun test ./cloud/loop/test/db.test.ts"],
        status: "passed",
        sessionId: "old-n1",
        commitSha: "1111aaaa",
        rounds: 0,
        lastError: null,
        summary: "n1 done before crash",
        startedAt: nowIso,
        finishedAt: nowIso,
        role: "dev",
        verdict: null,
        report: null,
      },
      {
        id: "n2",
        position: 1,
        origin: "planned",
        title: "接入引擎",
        goal: "Wire engine",
        dependsOn: ["n1"],
        filesHint: [],
        verify: ["bun test ./cloud/loop/test/pipeline.test.ts"],
        status: "passed",
        sessionId: null,
        commitSha: "abc",
        rounds: 0,
        lastError: null,
        summary: null,
        startedAt: nowIso,
        finishedAt: nowIso,
        role: "dev",
        verdict: null,
        report: null,
      },
    ],
  });
  await s.store.save({
    key: "CYC-1",
    kind: "dev",
    issueId: 1,
    issueNumber: 1,
    title: "Test",
    phase: "qa",
    round: 0,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "old-n1",
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    startedAt: nowIso,
    updatedAt: nowIso,
    dev: {
      ciRound: 0,
      ciFailedSha: null,
      ciWait: null,
      nodeModulesReleased: false,
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      prUrl: null,
      fullFlowDocs: fourDocs().map((d) => ({ id: d.id, title: d.title, version: d.version })),
      activeNodeId: null,
    },
  });

  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(s.sessions.titles.filter((c) => c.role === "dev")).toHaveLength(0);
  const finalGraph = await s.store.loadGraph("CYC-1");
  expect(finalGraph?.nodes.map((n) => [n.id, n.role, n.status, n.verdict])).toEqual([
    ["n1", "dev", "passed", null],
    ["n2", "dev", "passed", null],
    ["qa-1", "qa", "passed", "pass"],
  ]);
});

test("Task Graph: QA system fault blocks the QA node and the run", async () => {
  const s = await setupFullFlow([fullFlowIssue({ columnId: 23 })], fourDocs(), {
    dev: [],
    qa: [done("a"), done("b"), done("c"), done("d"), done("e")],
    review: [done(REVIEW_MERGE)],
  });
  s.tracker.docContent[103] = twoNodePlan;
  const nowIso = "2026-11-25T00:00:00Z";
  await s.store.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "check", verify: [["bun", "run", "check"]] }]),
  );
  await s.store.saveGraph({
    runKey: "CYC-1",
    source: "plan_doc",
    revision: 1,
    currentNodeId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    nodes: [
      {
        id: "n1",
        position: 0,
        origin: "planned",
        title: "新增表结构",
        goal: "Schema",
        dependsOn: [],
        filesHint: [],
        verify: ["bun test ./cloud/loop/test/db.test.ts"],
        status: "passed",
        sessionId: "old-n1",
        commitSha: "1111aaaa",
        rounds: 0,
        lastError: null,
        summary: "n1 done before crash",
        startedAt: nowIso,
        finishedAt: nowIso,
        role: "dev",
        verdict: null,
        report: null,
      },
      {
        id: "n2",
        position: 1,
        origin: "planned",
        title: "接入引擎",
        goal: "Wire engine",
        dependsOn: ["n1"],
        filesHint: [],
        verify: ["bun test ./cloud/loop/test/pipeline.test.ts"],
        status: "passed",
        sessionId: null,
        commitSha: "abc",
        rounds: 0,
        lastError: null,
        summary: null,
        startedAt: nowIso,
        finishedAt: nowIso,
        role: "dev",
        verdict: null,
        report: null,
      },
    ],
  });
  await s.store.save({
    key: "CYC-1",
    kind: "dev",
    issueId: 1,
    issueNumber: 1,
    title: "Test",
    phase: "qa",
    round: 0,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "old-n1",
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    startedAt: nowIso,
    updatedAt: nowIso,
    dev: {
      ciRound: 0,
      ciFailedSha: null,
      ciWait: null,
      nodeModulesReleased: false,
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      prUrl: null,
      fullFlowDocs: fourDocs().map((d) => ({ id: d.id, title: d.title, version: d.version })),
      activeNodeId: null,
    },
  });

  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  const finalGraph = await s.store.loadGraph("CYC-1");
  const qaNode = finalGraph?.nodes.find((n) => n.id === "qa-1");
  expect(qaNode?.status).toBe("blocked");
  expect(qaNode?.verdict).toBeNull();
  expect(qaNode?.sessionId).not.toBeNull();
});

/** A run whose Dev nodes are done and whose graph already has `qa-1` in the given state. */
const seedQaNodeRun = async (
  s: Awaited<ReturnType<typeof setupFullFlow>>,
  input: { phase: "graph_plan" | "verify"; qaStatus: "pending" | "running" | "blocked" },
) => {
  s.tracker.docContent[103] = twoNodePlan;
  const nowIso = "2026-11-25T00:00:00Z";
  await s.store.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "check", verify: [["bun", "run", "check"]] }]),
  );
  const dev = (id: string, position: number, dependsOn: string[]) => ({
    id,
    position,
    origin: "planned" as const,
    title: id,
    goal: id,
    dependsOn,
    filesHint: [],
    verify: ["bun run check"],
    status: "passed" as const,
    sessionId: `old-${id}`,
    commitSha: "abc",
    rounds: 0,
    lastError: null,
    summary: null,
    startedAt: nowIso,
    finishedAt: nowIso,
    role: "dev" as const,
    verdict: null,
    report: null,
  });
  await s.store.saveGraph({
    runKey: "CYC-1",
    source: "plan_doc",
    revision: 1,
    currentNodeId: "qa-1",
    createdAt: nowIso,
    updatedAt: nowIso,
    nodes: [
      dev("n1", 0, []),
      dev("n2", 1, ["n1"]),
      {
        ...dev("qa-1", 2, ["n2"]),
        role: "qa" as const,
        goal: "独立验收提交 abc",
        status: input.qaStatus,
        sessionId: null,
        commitSha: null,
        finishedAt: null,
      },
    ],
  });
  await s.store.save({
    key: "CYC-1",
    kind: "dev",
    issueId: 1,
    issueNumber: 1,
    title: "Test",
    phase: input.phase,
    round: 0,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "old-n1",
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    startedAt: nowIso,
    updatedAt: nowIso,
    dev: {
      ciRound: 0,
      ciFailedSha: null,
      ciWait: null,
      nodeModulesReleased: false,
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      prUrl: null,
      fullFlowDocs: fourDocs().map((d) => ({ id: d.id, title: d.title, version: d.version })),
      activeNodeId: input.phase === "verify" ? "qa-1" : null,
    },
  });
};

test("Task Graph: a QA node retried from the graph runs as QA, never as a Dev node", async () => {
  const s = await setupFullFlow([fullFlowIssue({ columnId: 23 })], fourDocs(), {
    dev: [],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  await seedQaNodeRun(s, { phase: "graph_plan", qaStatus: "pending" });
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(s.sessions.titles.filter((c) => c.role === "dev")).toHaveLength(0);
  const qaNode = (await s.store.loadGraph("CYC-1"))?.nodes.find((n) => n.id === "qa-1");
  expect(qaNode).toMatchObject({ status: "passed", verdict: "pass", report: null });
});

test("Task Graph: whole-item verify failing in a run with an open QA node skips it and schedules the fix", async () => {
  const s = await setupFullFlow([fullFlowIssue({ columnId: 23 })], fourDocs(), {
    dev: [done(), done(), done()],
    qa: [],
    review: [],
  });
  await seedQaNodeRun(s, { phase: "verify", qaStatus: "running" });
  s.world.fail.add("bun run check");
  await s.pipeline.step();
  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.nodes.find((n) => n.id === "qa-1")?.status).toBe("skipped");
  expect(graph?.nodes.find((n) => n.id === "fix-1")).toBeDefined();
  expect(graph?.nodes.find((n) => n.id === "fix-1")?.dependsOn).toContain("qa-1");
});
