import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CriteriaBook } from "../src/criteria.ts";
import { Pipeline } from "../src/pipeline.ts";
import { RunStore } from "../src/store.ts";
import { type ExecResult, type Issue, SessionLost, type TurnResult } from "../src/types.ts";
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
  };
  const stop = { value: false };
  const clock = { now: () => new Date("2026-11-25T00:00:00Z") };
  const store = new RunStore(cfg.stateDir, () => clock.now());
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
  expect(run?.reviewSessionId).toBe("review-3");
  const criteria = await store.loadCriteria("CYC-1");
  expect(criteria.allPassed).toBe(true);
  expect(sessions.deleted).toBe(0);
});

test("auto-merge enabled but the PR conflicts with main: Blocked, comment names the conflict and files, event recorded", async () => {
  const s = setup([ready()], { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] });
  s.world.prMerge = [["OPEN", "CONFLICTING"]];
  s.world.mergeTreeOutput = "deadbeef\ntools/auto-loop/test/pipeline.test.ts\n";
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.moves.at(-1)).toBe("CYC-1:blocked");
  const comment = s.tracker.comments.at(-1) ?? "";
  expect(comment).toContain("冲突");
  expect(comment).toContain("tools/auto-loop/test/pipeline.test.ts");
  const kinds = (await s.store.events()).map((e) => e.kind);
  expect(kinds).toContain("merge_conflict");
  expect(kinds).toContain("blocked");
  expect(kinds).not.toContain("delivered");
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
    }),
    store: new RunStore(dir, () => new Date("2026-11-25T00:00:00Z")),
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
  const result = await pipeline.step();
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
  expect(run?.ciRound).toBe(0);
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

  const result = await s.pipeline.step();
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
  expect(run?.ciRound).toBe(1);
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
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  const reruns = s.world.calls.filter((c) => c.includes("gh run rerun"));
  expect(reruns).toEqual(["gh run rerun 20 --failed"]);
  const run = await s.store.load("CYC-1");
  expect(run?.ciRound).toBe(1);
  expect(run?.ciFailedSha).toBe("abc");
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
  expect(run?.ciRound).toBe(2);
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
  const { pipeline, tracker, store } = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)] },
    { ciPollIntervalMs: 1000, ciTimeoutMs: 2000 },
    [],
    {
      responses: [pendingIntegration, pendingIntegration, pendingIntegration, pendingIntegration],
    },
  );
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
    ciRound: 0,
    ciFailedSha: null,
    conflictRound: 0,
    conflict: null,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "dev-1",
    qaSessionId: "qa-2",
    reviewSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    prUrl: "https://github.com/o/r/pull/9",
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    startedAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  });

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
    ciRound: 0,
    ciFailedSha: null,
    conflictRound: 0,
    conflict: null,
    worktree: WT,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "dev-1",
    qaSessionId: "qa-2",
    reviewSessionId: "review-3",
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    prUrl: "https://github.com/o/r/pull/9",
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    startedAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  });
};

const removals = (s: ReturnType<typeof setup>) =>
  s.world.calls.filter((c) => c.includes("worktree remove") || c.includes("branch -D"));

test("a Done work item with a merged PR loses its worktree and local branches", async () => {
  const s = setup([ready({ columnId: 24 })], { dev: [], qa: [] });
  s.world.prState = "MERGED";
  await doneRun(s);
  expect((await s.pipeline.step()).status).toBe("idle");
  expect(removals(s)).toEqual([
    `git worktree remove ${WT}`,
    "git branch -D worktree-auto/cyc-1",
    "git branch -D auto/cyc-1",
  ]);
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
    ciRound: 0,
    ciFailedSha: null,
    conflictRound: 0,
    conflict: null,
    worktree: null,
    localBranch: null,
    remoteBranch: "auto/cyc-1",
    devSessionId: null,
    qaSessionId: null,
    reviewSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    prUrl: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    startedAt: "2026-11-24T00:00:00Z",
    updatedAt: "2026-11-24T00:00:00Z",
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
  expect((await bad.store.events()).some((e) => e.kind === "phase_field_failed")).toBe(true);
});
