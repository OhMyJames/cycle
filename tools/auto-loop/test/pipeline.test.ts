import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pipeline } from "../src/pipeline.ts";
import { RunStore } from "../src/store.ts";
import {
  type Exec,
  type ExecResult,
  type Issue,
  SessionLost,
  type SessionRole,
  type Sessions,
  type Stage,
  type Tracker,
  type TurnResult,
} from "../src/types.ts";
import { config, issue, readyDescription } from "./helpers.ts";

const WT = "/wt/auto/cyc-1";
const CHECKED = "What I checked:\n- read a.ts\n- ran git diff\n";
const PASS = `${CHECKED}<verdict>{"pass":true,"findings":[]}</verdict>`;
const FAIL = `${CHECKED}<verdict>{"pass":false,"findings":[{"severity":"major","where":"a.ts","problem":"p","fix":"f"}]}</verdict>`;
const REVIEW_APPROVE = `${CHECKED}<review>{"decision":"auto_merge","summary":"looks safe to auto-merge","reasons":["scoped to work item","tests cover the behavior"]}</review>`;
const REVIEW_HUMAN = `${CHECKED}<review>{"decision":"human_review","summary":"needs human sign-off","reasons":["changes permission boundary","needs design confirmation"]}</review>`;
const done = (text = "<progress>done: x\nnext: y</progress>"): TurnResult => ({
  stopReason: "end_turn",
  text,
  timedOut: false,
});

class FakeTracker implements Tracker {
  moves: string[] = [];
  comments: string[] = [];
  constructor(public issues: Issue[]) {}
  async listTodo() {
    return this.issues.filter((i) => i.columnId === 22);
  }
  async get(number: number) {
    const found = this.issues.find((i) => i.number === number);
    if (!found) throw new Error("no issue");
    return found;
  }
  async move(i: Issue, stage: Stage) {
    this.moves.push(`${i.key}:${stage}`);
    const col = { todo: 22, inProgress: 23, inReview: 34, blocked: 35 }[stage];
    const found = this.issues.find((x) => x.number === i.number);
    if (found) found.columnId = col;
  }
  async comment(i: Issue, text: string) {
    this.comments.push(`${i.key}:${text}`);
  }
}

type Script = {
  dev: (TurnResult | Error)[];
  qa: (TurnResult | Error)[];
  review?: (TurnResult | Error)[];
  createError?: Partial<Record<SessionRole, Error>>;
};

class FakeSessions implements Sessions {
  created: string[] = [];
  turns: string[] = [];
  prompts: { sessionId: string; role: SessionRole; prompt: string }[] = [];
  deleted = 0;
  readonly script: {
    dev: (TurnResult | Error)[];
    qa: (TurnResult | Error)[];
    review: (TurnResult | Error)[];
    createError: Partial<Record<SessionRole, Error>>;
  };
  constructor(script: Script) {
    this.script = {
      dev: [...script.dev],
      qa: [...script.qa],
      review: script.review !== undefined ? [...script.review] : [done(REVIEW_APPROVE)],
      createError: { ...(script.createError ?? {}) },
    };
  }
  async create(input: { role: SessionRole; cwd: string }) {
    const err = this.script.createError[input.role];
    if (err !== undefined) throw err;
    const id = `${input.role}-${this.created.length + 1}`;
    this.created.push(id);
    return {
      sessionId: id,
      cwd: input.role === "dev" ? WT : input.cwd,
      branch: "worktree-auto/cyc-1",
    };
  }
  async turn(sessionId: string, prompt: string, ctx: { role: SessionRole }) {
    this.turns.push(`${sessionId}: ${prompt.slice(0, 30)}`);
    this.prompts.push({ sessionId, role: ctx.role, prompt });
    const next = this.script[ctx.role].shift();
    if (next === undefined) throw new Error(`no scripted ${ctx.role} turn`);
    if (next instanceof Error) throw next;
    return next;
  }
}

type CiCheckStub = {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl?: string;
};

type CiResponse = {
  headRefOid: string;
  statusCheckRollup: CiCheckStub[];
};

const greenCi = (headRefOid = "abc"): CiResponse => ({
  headRefOid,
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
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/o/r/actions/runs/10/job/102",
    },
    {
      name: "integration",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/o/r/actions/runs/10/job/103",
    },
  ],
});

type World = {
  fail: Set<string>;
  calls: string[];
  dirty: boolean;
  qaWrites: boolean;
  headSha: string;
  ciResponses: CiResponse[];
  ciLogs: Record<string, string>;
};

const makeExec =
  (world: World): Exec =>
  async (argv) => {
    const line = argv.filter((a) => a !== "-c" && !a.startsWith("core.")).join(" ");
    world.calls.push(line);
    const result = (output: string, code = 0): ExecResult => ({ code, output, timedOut: false });
    if (line.includes("diff --name-only")) return result("packages/client/src/a.ts\n");
    if (line.includes("status --porcelain")) return result(world.dirty ? " M a.ts\n" : "");
    if (line.includes("rev-parse HEAD")) return result(`${world.headSha}\n`);
    for (const pattern of world.fail) if (line.includes(pattern)) return result("boom", 1);
    if (line.includes("gh pr create")) return result("https://github.com/o/r/pull/9\n");
    if (line.includes("gh pr view") && line.includes("statusCheckRollup")) {
      const next = world.ciResponses.shift() ?? greenCi(world.headSha);
      return result(JSON.stringify(next));
    }
    if (line.includes("gh run view")) {
      const jobIdx = argv.indexOf("--job");
      const key = jobIdx !== -1 ? (argv[jobIdx + 1] ?? "") : (argv[3] ?? "");
      return result(world.ciLogs[key] ?? "generic CI failure log\n");
    }
    if (line.includes("gh pr view")) return result("https://github.com/o/r/pull/9\n");
    return result("");
  };

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
  };
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
  });
  return { pipeline, tracker, sessions, world, store };
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

test("happy path: Dev, checks, QA, push, PR, green CI, independent review pass, auto-merge (squash)", async () => {
  const { pipeline, tracker, sessions, world, store } = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
    review: [done(REVIEW_APPROVE)],
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
  expect(reviewComment).toContain("可自动合并");
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
});

test("an unreadable QA verdict blocks instead of delivering", async () => {
  const { pipeline } = setup([ready()], { dev: [done()], qa: [done("looks fine")] });
  expect((await pipeline.step()).status).toBe("blocked");
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

test("a QA pass that does not say what was checked is not accepted", async () => {
  const { pipeline } = setup([ready()], {
    dev: [done()],
    qa: [done(`<verdict>{"pass":true,"findings":[]}</verdict>`)],
  });
  expect((await pipeline.step()).status).toBe("blocked");
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
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_APPROVE)] },
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

test("CI failing past retry limit ends in Blocked with failed check and log reason", async () => {
  const redIntegration = (): CiResponse => ({
    headRefOid: "abc",
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
  const { pipeline, tracker, store, sessions } = setup(
    [ready()],
    {
      dev: [done(), done(), done()],
      qa: [done(PASS), done(PASS), done(PASS)],
    },
    { maxCiRetries: 2 },
    [],
    {
      responses: [redIntegration(), redIntegration(), redIntegration()],
      logs: { "777": integrationLog },
    },
  );

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

  const secondSessions = new FakeSessions({ dev: [], qa: [], review: [done(REVIEW_APPROVE)] });
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

test("review requesting human involvement skips auto-merge, posts PR comment, and moves ticket to In Review", async () => {
  const { pipeline, tracker, world, store } = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
    review: [done(REVIEW_HUMAN)],
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
  expect(reviewComment).toContain("需要人参与");
  expect(reviewComment).toContain("changes permission boundary");
  expect(tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(tracker.comments.at(-1)).toContain("需要人工参与");
  expect(tracker.comments.at(-1)).toContain("changes permission boundary");
  expect((await store.load("CYC-1"))?.phase).toBe("done");
});

test("review session failure or timeout skips auto-merge and moves ticket to In Review as needing a person", async () => {
  // Turn throws an error.
  const thrown = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
    review: [new Error("daemon disconnected")],
  });
  const r1 = await thrown.pipeline.step();
  expect(r1).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: false,
  });
  expect(thrown.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(thrown.world.calls.some((c) => c.includes("gh pr comment"))).toBe(true);
  expect(thrown.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(thrown.tracker.comments.at(-1)).toContain("需要人工参与");
  expect(thrown.tracker.comments.at(-1)).toContain("daemon disconnected");

  // Session creation fails.
  const dir2 = await mkdtemp(join(tmpdir(), "auto-loop-create-err-"));
  try {
    const createFail = setup(
      [ready()],
      {
        dev: [done()],
        qa: [done(PASS)],
        review: [],
        createError: { review: new Error("failed to start review agent") },
      },
      { stateDir: dir2 },
    );
    const r2 = await createFail.pipeline.step();
    expect(r2).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: false,
    });
    expect(createFail.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
    expect(createFail.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }

  // Review turn times out.
  const dir3 = await mkdtemp(join(tmpdir(), "auto-loop-timeout-"));
  try {
    const timedOut = setup(
      [ready()],
      {
        dev: [done()],
        qa: [done(PASS)],
        review: [{ stopReason: "cancelled", text: "", timedOut: true }],
      },
      { stateDir: dir3 },
    );
    const r3 = await timedOut.pipeline.step();
    expect(r3).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: false,
    });
    expect(timedOut.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
    expect(timedOut.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
    expect(timedOut.tracker.comments.at(-1)).toContain("超时");
  } finally {
    await rm(dir3, { recursive: true, force: true });
  }
});

test("review with no parseable conclusion, missing checklist, or modified worktree skips auto-merge", async () => {
  // Unparseable / missing structured conclusion.
  const noVerdict = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
    review: [done("Looks good to me!")],
  });
  const r1 = await noVerdict.pipeline.step();
  expect(r1).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
    autoMerge: false,
  });
  expect(noVerdict.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(noVerdict.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(noVerdict.tracker.comments.at(-1)).toContain("未给出可解析的结构化结论");

  // auto_merge without "What I checked" list.
  const dir2 = await mkdtemp(join(tmpdir(), "auto-loop-nocheck-"));
  try {
    const noChecked = setup(
      [ready()],
      {
        dev: [done()],
        qa: [done(PASS)],
        review: [done('<review>{"decision":"auto_merge","summary":"lgtm","reasons":[]}</review>')],
      },
      { stateDir: dir2 },
    );
    const r2 = await noChecked.pipeline.step();
    expect(r2).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: false,
    });
    expect(noChecked.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
    expect(noChecked.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }

  // Review session modified the worktree (violating read-only).
  const dir3 = await mkdtemp(join(tmpdir(), "auto-loop-dirty-review-"));
  try {
    const dirty = setup(
      [ready()],
      {
        dev: [done()],
        qa: [done(PASS)],
        review: [done(REVIEW_APPROVE)],
      },
      { stateDir: dir3 },
    );
    const original = dirty.sessions.turn.bind(dirty.sessions);
    dirty.sessions.turn = async (id, prompt, ctx) => {
      const out = await original(id, prompt, ctx);
      if (ctx.role === "review") dirty.world.dirty = true;
      return out;
    };
    const r3 = await dirty.pipeline.step();
    expect(r3).toEqual({
      status: "delivered",
      key: "CYC-1",
      prUrl: "https://github.com/o/r/pull/9",
      autoMerge: false,
    });
    expect(dirty.world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
    expect(dirty.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
    expect(dirty.tracker.comments.at(-1)).toContain("修改了工作区");
  } finally {
    await rm(dir3, { recursive: true, force: true });
  }
});

test("enabling auto-merge failing falls back to In Review needing a person", async () => {
  const { pipeline, tracker, world } = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_APPROVE)] },
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
  const s = setup([ready()], { dev: [], qa: [], review: [done(REVIEW_APPROVE)] }, {}, [], {
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
