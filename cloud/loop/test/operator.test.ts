import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiTracker, LoopApiHandler, type ProjectApi } from "../src/api.ts";
import { openLoopStore, type SqliteStore } from "../src/db/store.ts";
import { Operator } from "../src/operator/index.ts";
import { type RunRecord, RunRecordSchema } from "../src/store.ts";
import { type Config, defaultConfig } from "../src/types.ts";
import { done, FakeSessions } from "./helpers.ts";

const root = mkdtempSync(join(tmpdir(), "loop-operator-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

class StubTracker implements ApiTracker {
  async getProject() {
    return { data: { columns: [{ id: 3, name: "Doing", stateType: "started", position: 0 }] } };
  }
  async listRows() {
    return [];
  }
  async get(): Promise<never> {
    throw new Error("unused");
  }
  async listComments() {
    return [];
  }
  async moveToColumn() {}
  async setLabelIds() {}
  async comment() {}
}

const run = (key: string, over: Partial<RunRecord> = {}): RunRecord =>
  RunRecordSchema.parse({
    key,
    kind: "dev",
    issueId: 1,
    issueNumber: Number(key.split("-")[1]),
    title: `Run ${key}`,
    phase: "dev",
    round: 1,
    worktree: "/w",
    localBranch: null,
    remoteBranch: `auto/${key}`,
    devSessionId: null,
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    startedAt: "2026-11-28T01:00:00.000Z",
    updatedAt: "2026-11-28T01:00:00.000Z",
    dev: {},
    ...over,
  });

let clock = new Date("2026-11-28T03:00:00.000Z");
const advance = () => {
  clock = new Date(clock.getTime() + 60_000);
};
let n = 0;
let stateDir = "";
let store: SqliteStore;
let sessions: FakeSessions;
let operator: Operator;
const logs: string[] = [];

const setup = (script: Parameters<typeof reply>[0][] = [], over: Partial<Config> = {}) => {
  stateDir = join(root, `s${++n}`);
  store = openLoopStore(stateDir, () => clock, false) as SqliteStore;
  sessions = new FakeSessions({ dev: [], qa: [], operator: script.map((t) => reply(t)) });
  const config: Config = {
    ...defaultConfig({
      repoRoot: "/repo",
      stateDir,
      columns: { todo: 22, inProgress: 23, inReview: 34, blocked: 35, done: 24, canceled: 25 },
      autoLabelId: 1,
      allowedTypeIds: [1],
      featureTypeId: 1,
      bugTypeId: 2,
    }),
    ...over,
  };
  const project: ProjectApi = {
    projectKey: "CYC",
    tracker: new StubTracker(),
    store,
    labels: { auto: "auto", pending: "p", skip: "s" },
    workers: 1,
  };
  operator = new Operator({
    config,
    project,
    handler: new LoopApiHandler({
      version: "t",
      startedAt: clock,
      now: () => clock,
      log: () => {},
      projects: [project],
    }),
    sessions,
    now: () => clock,
    log: (l) => logs.push(l),
  });
};
const reply = (text: string) => done(text);
const events = async (kind: string) => (await store.events()).filter((e) => e.kind === kind);
const operatorNotices = () => store.notices().filter((x) => x.kind === "operator");
const stuck = (key: string, dedupe = `stuck:${key}:dev:1`) =>
  store.notice(key, "stuck", "连续超时两次", dedupe);

beforeEach(() => {
  logs.length = 0;
  advance();
});

describe("wake", () => {
  test("a stuck Notice wakes the operator once; the same Notice does not wake it again", async () => {
    setup(["<diagnosis>卡在 dev</diagnosis>"]);
    await store.save(run("CYC-1"));
    expect(await operator.tick()).toBe(false);
    stuck("CYC-1");
    advance();
    expect(await operator.tick()).toBe(true);
    advance();
    expect(await operator.tick()).toBe(false);
    expect(sessions.created).toHaveLength(1);
    expect(await events("operator_woken")).toHaveLength(1);
    // A new Notice for the same run (another deadline) is another cause.
    stuck("CYC-1", "stuck:CYC-1:dev:2");
    sessions.script.operator.push(done("<diagnosis>again</diagnosis>"));
    advance();
    expect(await operator.tick()).toBe(true);
    expect(sessions.created).toHaveLength(2);
  });

  test("a stuck Notice of a run that is no longer active does not wake it", async () => {
    setup();
    await store.save(run("CYC-1", { phase: "done" }));
    stuck("CYC-1");
    expect(await operator.tick()).toBe(false);
  });

  test("Blocked below the threshold does not wake; at it, once", async () => {
    setup(["<diagnosis>共同原因</diagnosis>"]);
    await store.save(run("CYC-1", { phase: "blocked" }));
    await store.save(run("CYC-2", { phase: "blocked" }));
    expect(await operator.tick()).toBe(false);
    await store.save(run("CYC-3", { phase: "blocked" }));
    advance();
    expect(await operator.tick()).toBe(true);
    advance();
    expect(await operator.tick()).toBe(false);
    expect(await events("operator_woken")).toHaveLength(1);
    expect(sessions.prompts[0]?.prompt).toContain("CYC-1, CYC-2, CYC-3");
  });

  test("a Blocked pile that grew wakes it again; the pile dropping and returning with the same keys does not", async () => {
    setup(["<diagnosis>a</diagnosis>", "<diagnosis>b</diagnosis>"], {
      operator: { blockedThreshold: 2, inspectIntervalMinutes: 60 },
    });
    await store.save(run("CYC-1", { phase: "blocked" }));
    await store.save(run("CYC-2", { phase: "blocked" }));
    expect(await operator.tick()).toBe(true);
    await store.save(run("CYC-3", { phase: "blocked" }));
    advance();
    expect(await operator.tick()).toBe(true);
    expect(sessions.created).toHaveLength(2);
  });

  test("a restarted loop remembers the wakes it already did", async () => {
    setup(["<diagnosis>x</diagnosis>"]);
    await store.save(run("CYC-1"));
    stuck("CYC-1");
    expect(await operator.tick()).toBe(true);
    // A new Operator over the same store: nothing new, nothing woken.
    const again = new Operator({
      config: defaultConfig({
        repoRoot: "/repo",
        stateDir,
        columns: { todo: 22, inProgress: 23, inReview: 34, blocked: 35, done: 24, canceled: 25 },
        autoLabelId: 1,
        allowedTypeIds: [1],
        featureTypeId: 1,
        bugTypeId: 2,
      }),
      project: {
        projectKey: "CYC",
        tracker: new StubTracker(),
        store,
        labels: { auto: "a", pending: "p", skip: "s" },
        workers: 1,
      },
      handler: new LoopApiHandler({
        version: "t",
        startedAt: clock,
        now: () => clock,
        log: () => {},
        projects: [],
      }),
      sessions,
      now: () => clock,
      log: () => {},
    });
    advance();
    expect(await again.tick()).toBe(false);
  });
});

describe("session and export", () => {
  test("the session is an operator, read-only, with the export directory as a read root", async () => {
    setup(["<diagnosis>d</diagnosis>"]);
    await store.save(run("CYC-1"));
    await store.save(run("CYC-2", { phase: "blocked", blockedReason: "x" }));
    await store.event("CYC-1", "claimed");
    await store.event("CYC-9", "claimed");
    stuck("CYC-1");
    expect(await operator.tick()).toBe(true);
    expect(sessions.titles[0]?.role).toBe("operator");
    // A session has no way to be given an environment: `create` takes none, and the tracker is not an argument.
    expect(Object.keys(sessions.places[0] ?? {}).sort()).toEqual(["cwd", "role", "worktree"]);
    expect(sessions.places[0]?.worktree).toBeUndefined();
    const prompt = sessions.prompts[0];
    expect(prompt?.role).toBe("operator");
    const dir = join(stateDir, "operator-export");
    expect(prompt?.readRoots).toContain(dir);
    expect(readdirSync(dir).sort()).toEqual(["board.json", "events", "notices.json", "runs.json"]);
    expect(readdirSync(join(dir, "events"))).toEqual(["CYC-1.json"]);
    const runs = JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")) as {
      runs: { key: string }[];
    };
    expect(runs.runs.map((r) => r.key).sort()).toEqual(["CYC-1", "CYC-2"]);
    const evs = JSON.parse(readFileSync(join(dir, "events", "CYC-1.json"), "utf8")) as {
      kind: string;
    }[];
    expect(evs.map((e) => e.kind)).toContain("claimed");
    const notices = JSON.parse(readFileSync(join(dir, "notices.json"), "utf8")) as {
      notices: { kind: string }[];
    };
    expect(notices.notices.some((x) => x.kind === "stuck")).toBe(true);
    // Nothing of the state directory beyond the export is a read root; no credential is in the export.
    expect(prompt?.readRoots?.every((r) => r === dir)).toBe(true);
    for (const f of ["board.json", "runs.json", "notices.json"])
      expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/planKey|GITHUB_TOKEN|ghp_/);
    expect(existsSync(join(dir, "loop.db"))).toBe(false);
  });
});

describe("reply", () => {
  test("a diagnosis is written as an operator Notice", async () => {
    setup([
      "先看 events/CYC-1.json。\n<diagnosis>CYC-1 在 dev 阶段超时,建议人工检查。</diagnosis>",
    ]);
    await store.save(run("CYC-1"));
    stuck("CYC-1");
    await operator.tick();
    const notices = operatorNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toBe("CYC-1 在 dev 阶段超时,建议人工检查。");
    expect(notices[0]?.runKey).toBe("CYC");
    expect(await events("operator_action_ignored")).toHaveLength(0);
  });

  test("an <action> is ignored and recorded; the diagnosis is still written", async () => {
    setup(['<diagnosis>d</diagnosis><action type="retry">CYC-1</action>']);
    await store.save(run("CYC-1"));
    stuck("CYC-1");
    await operator.tick();
    expect(await events("operator_action_ignored")).toHaveLength(1);
    expect(operatorNotices()).toHaveLength(1);
  });

  test("no diagnosis, a failed session or an error writes no Notice and does not wake again", async () => {
    setup(["nothing here"]);
    await store.save(run("CYC-1"));
    stuck("CYC-1");
    await operator.tick();
    expect(operatorNotices()).toHaveLength(0);
    expect(await events("operator_failed")).toHaveLength(1);
    advance();
    expect(await operator.tick()).toBe(false);

    setup();
    await store.save(run("CYC-1"));
    stuck("CYC-1");
    await operator.tick(); // no scripted turn: the fake throws
    expect(operatorNotices()).toHaveLength(0);
    expect(await events("operator_failed")).toHaveLength(1);
    expect(await events("operator_woken")).toHaveLength(1);
  });

  test("operatorWakes counts the wakes", async () => {
    setup(["<diagnosis>d</diagnosis>"]);
    await store.save(run("CYC-1"));
    stuck("CYC-1");
    await operator.tick();
    const { computeStats } = await import("../src/stats.ts");
    expect(computeStats(await store.events()).operatorWakes).toBe(1);
  });
});

describe("scheduled inspection", () => {
  const at = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };

  test("by default it inspects once 60 minutes have passed since start, with stats in the prompt", async () => {
    setup(["<diagnosis>返工率升高</diagnosis>"]);
    at(59);
    expect(await operator.tick()).toBe(false);
    at(2);
    expect(await operator.tick()).toBe(true);
    expect(sessions.prompts[0]?.prompt).toContain("scheduled inspection");
    expect(sessions.prompts[0]?.prompt).toContain("rework rate");
    expect(operatorNotices()).toHaveLength(1);
    expect(await events("operator_inspected")).toHaveLength(1);
    // The inspection is a wake: the next one is an interval later.
    at(30);
    expect(await operator.tick()).toBe(false);
  });

  test("the configured interval applies", async () => {
    setup(["<diagnosis>d</diagnosis>"], {
      operator: { blockedThreshold: 3, inspectIntervalMinutes: 15 },
    });
    at(16);
    expect(await operator.tick()).toBe(true);
  });

  test("a wake for another reason resets the interval", async () => {
    setup(["<diagnosis>a</diagnosis>", "<diagnosis>b</diagnosis>"]);
    await store.save(run("CYC-1"));
    at(50);
    stuck("CYC-1");
    expect(await operator.tick()).toBe(true);
    at(30); // 80 minutes since start, 30 since the wake
    expect(await operator.tick()).toBe(false);
    at(31);
    expect(await operator.tick()).toBe(true);
    expect(sessions.prompts[1]?.prompt).toContain("scheduled inspection");
  });

  test("it does not inspect while a session is running", async () => {
    setup(["<diagnosis>a</diagnosis>"]);
    at(61);
    const first = operator.tick();
    expect(await operator.tick()).toBe(false);
    expect(await first).toBe(true);
    expect(sessions.created).toHaveLength(1);
  });

  test("with nothing found it writes no Notice, only an operator_inspected event", async () => {
    setup(["<diagnosis></diagnosis>"]);
    at(61);
    expect(await operator.tick()).toBe(true);
    expect(operatorNotices()).toHaveLength(0);
    expect(await events("operator_inspected")).toHaveLength(1);
    expect(await events("operator_failed")).toHaveLength(0);
  });
});
