// The design flow in the pipeline (CYC-545): a one-node graph, a read-only design session, QA, and the loop's own publication.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { type DepsInput as Deps, Pipeline } from "../src/pipeline.ts";
import type { Issue } from "../src/types.ts";
import {
  CHECKED,
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  makeExec,
  PASS,
  readyDescription,
  type Script,
  type World,
} from "./helpers.ts";

const DESIGN_TYPE = 24;
const BACKLOG = 21;
const FOLDER = 10;
const ROOTS = ["/repo", "/data/runs"];

const FAIL = `${CHECKED}<verdict>{"pass":false,"findings":[{"severity":"major","where":"问题 1","problem":"the evidence does not hold","fix":"check a.ts again"}]}</verdict>`;

const description = `## 背景与约束
x

## 要回答的问题

1. 用哪种存储？
2. 怎么迁移？

## 结论

（做完后回填）
`;

const reply = (summary = "用 SQLite。") => `<summary>${summary}</summary>
<report>
## 问题 1
用 SQLite。

## 问题 2
分两步迁移。

## 备选方案对比
| 方案 | 代价 | 风险 |
| --- | --- | --- |
| SQLite | 低 | 单文件 |
| JSONL | 中 | 并发 |

## 推荐
SQLite，因为事务。
</report>
<followup type="Feature" title="Move runs to SQLite">
${readyDescription}</followup>`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-design-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const designConfig = (over = {}) =>
  config({
    stateDir: dir,
    allowedTypeIds: [20, 25, DESIGN_TYPE],
    design: {
      typeId: DESIGN_TYPE,
      backlogColumn: BACKLOG,
      folderId: FOLDER,
      readRoots: ROOTS,
      maxFollowups: 5,
    },
    ...over,
  });

const designIssue = (over: Partial<Issue> = {}) =>
  issue({ typeId: DESIGN_TYPE, description, parentId: 77, ...over });

const world = (): World => ({
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
});

const setup = (script: Partial<Script>, over = {}, issues: Issue[] = [designIssue()]) => {
  const cfg = designConfig(over);
  const tracker = new FakeTracker(issues);
  const sessions = new FakeSessions({ dev: [], qa: [], ...script });
  const w = world();
  const clock = { now: () => new Date("2026-11-28T00:00:00Z") };
  const store = SqliteStore.open(cfg.stateDir, () => clock.now());
  const deps: Deps = {
    config: cfg,
    tracker,
    sessions,
    exec: makeExec(w),
    store,
    clock,
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret" },
    sleep: async () => {},
  };
  return { pipeline: new Pipeline(deps), tracker, sessions, world: w, store };
};

test("happy path: a design ticket is a one-node graph, QA, published to the design folder, Done", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  expect(await s.pipeline.step()).toEqual({
    status: "researched",
    key: "CYC-1",
    docId: 1000,
    followups: ["CYC-2"],
  });
  expect(s.world.calls.filter((c) => c.includes("bun install") || c.includes(" push "))).toEqual(
    [],
  );
  expect(s.sessions.prompts[0]?.prompt).toContain("You are the designer for work item CYC-1");
  expect(s.sessions.prompts[0]?.prompt).toContain("备选方案对比");

  expect(s.tracker.written).toEqual([
    {
      id: 1000,
      parentId: FOLDER,
      title: "CYC-1 title",
      content: expect.stringContaining("## 推荐"),
    },
  ]);
  expect(s.tracker.docLinks).toEqual(["CYC-1:1000"]);
  const after = (s.tracker.issues[0] as Issue).description;
  expect(after).toContain("## 结论\n\n用 SQLite。\n\n报告：「CYC-1 title」");
  const made = s.tracker.issues.slice(1);
  expect(made.map((i) => [i.key, i.typeId, i.columnId, i.parentId])).toEqual([
    ["CYC-2", 20, BACKLOG, 77],
  ]);
  expect(s.tracker.issueLinks).toEqual([`CYC-1:relates:${made[0]?.id}`]);
  expect(s.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:done"]);
  expect(s.tracker.comments[0]).toContain("设计完成");

  const run = await s.store.load("CYC-1");
  expect(run?.kind).toBe("design");
  expect(run?.phase).toBe("done");
  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.nodes.map((n) => `${n.id}:${n.role}:${n.status}:${n.verdict ?? "-"}`)).toEqual([
    "design:design:passed:-",
    "qa-1:qa:passed:pass",
  ]);
  expect((await s.store.events()).find((e) => e.kind === "claimed")).toMatchObject({
    runKind: "design",
    questions: 2,
  });
});

test("a report with no comparison of alternatives or no recommendation goes back to the same session", async () => {
  const s = setup({
    research: [
      done("<summary>x</summary><report>## 问题 1\na\n## 问题 2\nb</report>"),
      done(reply()),
    ],
    research_qa: [done(PASS)],
  });
  expect((await s.pipeline.step()).status).toBe("researched");
  const second = s.sessions.prompts[1];
  expect(second?.sessionId).toBe("research-1");
  expect(second?.prompt).toContain("备选方案对比");
  expect(second?.prompt).toContain("推荐");
});

test("QA that does not pass adds a design fix node in a new session, then a new QA node", async () => {
  const s = setup({
    research: [done(reply("初稿。")), done(reply("改过的。"))],
    research_qa: [done(FAIL), done(PASS)],
  });
  expect((await s.pipeline.step()).status).toBe("researched");
  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.nodes.map((n) => `${n.id}:${n.role}:${n.status}:${n.verdict ?? "-"}`)).toEqual([
    "design:design:passed:-",
    "qa-1:qa:passed:fail",
    "fix-1:design:passed:-",
    "qa-2:qa:passed:pass",
  ]);
  const fix = s.sessions.prompts.filter((p) => p.role === "research")[1];
  expect(fix?.sessionId).not.toBe("research-1");
  expect(fix?.prompt).toContain("the evidence does not hold");
  expect((s.tracker.issues[0] as Issue).description).toContain("改过的。");
});

test("QA that keeps failing past maxFixRounds blocks, naming the design session", async () => {
  const s = setup(
    { research: [done(reply()), done(reply())], research_qa: [done(FAIL), done(FAIL)] },
    { maxFixRounds: 1 },
  );
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.tracker.comments[0]).toContain("设计会话「[CYC-1] Design」");
  expect(s.tracker.written).toEqual([]);
});

test("a design session that changes the worktree blocks", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const original = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await original(id, prompt, ctx);
    s.world.dirty = true;
    return out;
  };
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("设计会话修改了工作区");
});

test("design off: a Design work item is not taken", async () => {
  const s = setup({}, { design: null, allowedTypeIds: [20, 25] });
  expect((await s.pipeline.step()).status).toBe("idle");
  expect(s.sessions.created).toEqual([]);
});
