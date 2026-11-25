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
};

class FakeSessions implements Sessions {
  created: string[] = [];
  turns: string[] = [];
  prompts: { sessionId: string; role: "dev" | "qa"; prompt: string }[] = [];
  deleted = 0;
  constructor(public script: Script) {}
  async create(input: { role: "dev" | "qa"; cwd: string }) {
    const id = `${input.role}-${this.created.length + 1}`;
    this.created.push(id);
    return {
      sessionId: id,
      cwd: input.role === "dev" ? WT : input.cwd,
      branch: "worktree-auto/cyc-1",
    };
  }
  async turn(sessionId: string, prompt: string, ctx: { role: "dev" | "qa" }) {
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
  const store = new RunStore(dir, () => clock.now());
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

test("happy path: Dev, checks, QA, push, PR, In Review", async () => {
  const { pipeline, tracker, sessions, world, store } = setup([ready()], {
    dev: [done()],
    qa: [done(PASS)],
  });
  const result = await pipeline.step();
  expect(result).toEqual({
    status: "delivered",
    key: "CYC-1",
    prUrl: "https://github.com/o/r/pull/9",
  });
  expect(tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(sessions.created).toEqual(["dev-1", "qa-2"]);
  expect(world.calls.some((c) => c.includes("push origin HEAD:refs/heads/auto/cyc-1"))).toBe(true);
  const prCreate = world.calls.find((c) => c.includes("gh pr create"));
  expect(prCreate).toContain("Closes CYC-1");
  const prBody = await readFile(join(dir, "runs", "CYC-1", "pr-body.md"), "utf8");
  expect(prBody.split("\n")[0]).toBe("Closes CYC-1");
  expect((await store.load("CYC-1"))?.phase).toBe("done");
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

test("CI all green after polling proceeds to In Review and done", async () => {
  const { pipeline, tracker, store, world } = setup(
    [ready()],
    { dev: [done()], qa: [done(PASS)] },
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
  });
  expect(tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
  expect(world.calls.filter((c) => c.includes("statusCheckRollup"))).toHaveLength(2);
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

  expect(s.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:inReview"]);
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

  const secondSessions = new FakeSessions({ dev: [], qa: [] });
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
  });
  expect(secondSessions.turns).toEqual([]);
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
