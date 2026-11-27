import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { Pipeline } from "../src/pipeline.ts";
import { parseQuestion } from "../src/prompts/index.ts";
import { computeStats } from "../src/stats.ts";
import type { Issue } from "../src/types.ts";
import {
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  makeExec,
  PASS,
  REVIEW_MERGE,
  readyDescription,
  type Script,
  type World,
} from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-ask-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ask = (q: string) =>
  done(`<question>${q}</question>\n<progress>done: x\nnext: wait</progress>`);

const setup = (script: Script) => {
  const cfg = config({ stateDir: dir });
  const tracker = new FakeTracker([issue({ description: readyDescription })]);
  const sessions = new FakeSessions(script);
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
    stopped: () => false,
  });
  return { pipeline, tracker, sessions, world, store };
};

const putBack = (tracker: FakeTracker) => {
  (tracker.issues[0] as Issue).columnId = 22;
};

test("a question blocks the run: no verify, no round, comment and Notice carry it", async () => {
  const s = setup({ dev: [ask("删掉工单页还是保留？")], qa: [] });
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  const run = await s.store.load("CYC-1");
  expect(run?.phase).toBe("blocked");
  expect(run?.round).toBe(0);
  expect(run?.blockedReason).toBe("等人决定");
  const events = (await s.store.events()).map((e) => e.kind);
  expect(events).toContain("dev_asked");
  expect(events).not.toContain("verify");
  expect(events).not.toContain("round_failed");
  const asked = (await s.store.events()).find((e) => e.kind === "dev_asked");
  expect(asked?.chars).toBe("删掉工单页还是保留？".length);
  expect(JSON.stringify(asked)).not.toContain("工单页");
  const comment = s.tracker.comments.at(-1) as string;
  expect(comment).toContain("CYC-1:Loop 的 Dev 会话需要你决定：\n\n删掉工单页还是保留？");
  expect(comment).toContain("删掉工单页还是保留？");
  expect(comment).toContain("回答写在评论里，然后把工单放回 Todo\n\n<!--");
  expect(comment).not.toContain("建议重写工单");
  expect(s.tracker.moves.at(-1)).toBe("CYC-1:blocked");
  const notice = s.store.notices().find((n) => n.kind === "blocked");
  expect(notice?.text).toContain("删掉工单页还是保留？");
  expect(notice?.sessionKind).toBe("dev");
  expect(notice?.sessionId).toBe("dev-1");
  // Uncommitted work was checkpointed.
  expect(s.world.calls.some((c) => c.includes("commit"))).toBe(true);
});

test("put back in Todo it goes on in the same Dev session and is told to read the comments first", async () => {
  const s = setup({ dev: [ask("Q?"), done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] });
  await s.pipeline.step();
  putBack(s.tracker);
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  expect(s.sessions.created.filter((id) => id.startsWith("dev"))).toEqual(["dev-1"]);
  const second = s.sessions.prompts.filter((p) => p.role === "dev")[1];
  expect(second?.sessionId).toBe("dev-1");
  expect(second?.prompt).toContain("read the latest comments");
});

test("an empty question block is no question", async () => {
  expect(parseQuestion("<question>  \n </question>")).toBeUndefined();
  expect(parseQuestion("no block")).toBeUndefined();
  expect(parseQuestion("<question> a </question>")).toBe("a");
  const s = setup({
    dev: [done("<question> </question>\n<progress>done: x\nnext: y</progress>")],
    qa: [done(PASS)],
    review: [done(REVIEW_MERGE)],
  });
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect((await s.store.events()).some((e) => e.kind === "dev_asked")).toBe(false);
});

test("the third question of a run suggests rewriting the work item; stats count them", async () => {
  const s = setup({ dev: [ask("Q1"), ask("Q2"), ask("Q3")], qa: [] });
  for (let i = 0; i < 3; i++) {
    await s.pipeline.step();
    if (i < 2) {
      expect(s.tracker.comments.at(-1)).not.toContain("建议重写工单");
      putBack(s.tracker);
    }
  }
  expect(s.tracker.comments.at(-1)).toContain("已多次提问，建议重写工单");
  const stats = computeStats(await s.store.events());
  expect(stats.devAsked).toEqual({ asked: 3, runs: 1 });
});
