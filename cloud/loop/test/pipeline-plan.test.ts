// The planning node in the pipeline (CYC-322): a round driven end to end with the fake tracker and fake sessions.
// Triage, shaping, shaping QA and the loop's own write-back; resuming after a restart; never over a person; and a
// planned work item later taken by a dev run like any other.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NOTES_HEADING, ORIGINAL_HEADING } from "../src/flows/plan.ts";
import { type Deps, Pipeline } from "../src/pipeline.ts";
import { computeStats } from "../src/stats.ts";
import { RunStore } from "../src/store.ts";
import type { Exec, Issue, PlanningConfig } from "../src/types.ts";
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

const BACKLOG = 21;
const TODO = 22;
const AUTO = 11;
const FEATURE = 20;
const EPIC = 17;
const LABELS = { pending: 40, awaitingAnswer: 41, skip: 42, fullProcess: 43 };
const REPO = resolve(import.meta.dir, "../../..");
const SKILL = ".claude/skills/cycle-workflow/SKILL.md";

const FAIL = `${CHECKED}<verdict>{"pass":false,"findings":[{"severity":"major","where":"验收标准","problem":"criterion 1 cannot fail","fix":"name the test that covers it"}]}</verdict>`;

/** A body that passes the same preflight as a work item the loop takes, with a `bun test ./…` path in the worktree. */
const good = (lead: string) =>
  `${lead}：给人看的开头一段，说明做什么、为什么、做完是什么样。\n\n${readyDescription.replace(
    "bun test cloud/",
    "bun test ./cloud/",
  )}`;

const triageReply = (lines: Record<string, unknown>[], order: string[]) =>
  `I read the bodies.\n<triage>\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n</triage>\n<order>\n${order.join(" ")}\n</order>`;

const rewrite = (title = "在看板上显示整理后的工单", body = good("整理后")) =>
  `<title>${title}</title>\n<description>\n${body}\n</description>\n<notes>\n按模板整理了小节；验收命令待确认。\n</notes>`;

const split = (titles: string[], epic?: string) =>
  `<split>\n${titles
    .map((t) => `<part type="Feature" title="${t}">\n${good(t)}\n</part>`)
    .join("\n")}\n</split>\n${
    epic === undefined
      ? ""
      : `<epic title="${epic}">\n${epic}：一段给人看的开头。\n\n## 目标\nx\n\n## 范围\nx\n</epic>\n`
  }<notes>\n拆成 ${titles.length} 份，各自一个目标。\n</notes>`;

const can = (key: string, priority = "medium", reason = "范围清楚，命令写得出来") => ({
  key,
  category: "能做",
  priority,
  reason,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-plan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const planning = (over: Partial<PlanningConfig> = {}): PlanningConfig => ({
  labels: LABELS,
  backlogColumn: BACKLOG,
  epicTypeId: EPIC,
  templates: { feature: "FEATURE TEMPLATE", bug: "BUG TEMPLATE" },
  maxPending: 5,
  intervalMinutes: 30,
  maxSplit: 4,
  ...over,
});

const backlogItem = (number: number, over: Partial<Issue> = {}) =>
  issue({
    id: 100 + number,
    number,
    key: `CYC-${number}`,
    title: `原来的标题 ${number}`,
    description: `原来的正文 ${number}，说得不太清楚。`,
    columnId: BACKLOG,
    labelIds: [],
    ...over,
  });

const epicItem = () =>
  backlogItem(70, {
    id: 700,
    title: "大目标",
    typeId: EPIC,
    subtaskCount: 3,
    description: "Epic 的开头。",
  });

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

const setup = (
  script: Partial<Script>,
  issues: Issue[],
  over: { planning?: Partial<PlanningConfig>; config?: Record<string, unknown> } = {},
) => {
  const repoRoot = join(dir, "repo");
  const cfg = config({
    stateDir: join(dir, "state"),
    repoRoot,
    maxFixRounds: 2,
    planning: planning(over.planning),
    ...over.config,
  });
  const tracker = new FakeTracker(issues);
  const clock = { at: new Date("2026-11-26T10:00:00.000Z"), now: () => clock.at };
  // Comments the loop posts are on the work item when it is read again, with the time they were posted.
  let commentId = 1;
  const postComment = tracker.comment.bind(tracker);
  tracker.comment = async (i, text) => {
    await postComment(i, text);
    tracker.threads[i.key] = [
      ...(tracker.threads[i.key] ?? []),
      {
        id: commentId++,
        replyToId: null,
        authorId: "loop",
        authorName: "loop",
        body: text,
        createdAt: clock.now().toISOString(),
      },
    ];
  };
  const sessions = new FakeSessions({ dev: [], qa: [], ...script });
  const w = world();
  const base = makeExec(w);
  // `git worktree add` makes the worktree: the test directory a criterion names, and the work item rules.
  const exec: Exec = async (argv, options) => {
    const at = argv.indexOf("worktree");
    if (at !== -1 && argv[at + 1] === "add") {
      w.calls.push(argv.filter((a) => a !== "-c" && !a.startsWith("core.")).join(" "));
      const path = argv[argv.length - 2] as string;
      await mkdir(join(path, "cloud/loop/test"), { recursive: true });
      await writeFile(join(path, "cloud/loop/test/a.test.ts"), "");
      await mkdir(join(path, ".claude/skills/cycle-workflow"), { recursive: true });
      await copyFile(join(REPO, SKILL), join(path, SKILL));
      return { code: 0, output: "", timedOut: false };
    }
    if (at !== -1 && argv[at + 1] === "remove") {
      w.calls.push(argv.filter((a) => a !== "-c" && !a.startsWith("core.")).join(" "));
      if (w.fail.has("worktree remove")) return { code: 1, output: "boom", timedOut: false };
      await rm(argv[argv.length - 1] as string, { recursive: true, force: true });
      return { code: 0, output: "", timedOut: false };
    }
    return base(argv, options);
  };
  const store = new RunStore(cfg.stateDir, () => clock.now());
  const deps = (more: Partial<Deps> = {}): Deps => ({
    config: cfg,
    tracker,
    sessions,
    exec,
    store,
    clock,
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret" },
    sleep: async () => {},
    mirrorCapMs: 50,
    ...more,
  });
  /** A new process on the same state, tracker and repository. */
  const restart = () => new Pipeline(deps());
  return {
    pipeline: new Pipeline(deps()),
    tracker,
    sessions,
    world: w,
    store,
    clock,
    restart,
    cfg,
  };
};

const events = async (store: RunStore) => await store.events();
const kinds = async (store: RunStore) => (await events(store)).map((e) => e.kind);
const byKey = (s: ReturnType<typeof setup>, key: string) =>
  s.tracker.issues.find((i) => i.key === key) as Issue;
const commentsOn = (s: ReturnType<typeof setup>, key: string) =>
  s.tracker.comments.filter((c) => c.startsWith(`${key}:`)).map((c) => c.slice(key.length + 1));
/** Calls that would build, push or open a pull request: a planning round makes none. */
const forbidden = (calls: string[]) =>
  calls.filter((c) => c.includes("bun install") || c.includes(" push ") || c.startsWith("gh "));

test("a round end to end: priority with a comment, 要问 with 待回答, a rewrite waiting for approval in Backlog", async () => {
  const s = setup(
    {
      triage: [
        done(
          triageReply(
            [
              can("CYC-1", "high", "挡着看板的工作"),
              {
                key: "CYC-2",
                category: "要问",
                priority: "medium",
                reason: "要的东西有两种读法",
                questions: ["要显示在哪一列？"],
              },
              { key: "CYC-3", category: "不适合", priority: "urgent", reason: "要真实账号" },
            ],
            ["CYC-1"],
          ),
        ),
      ],
      shape: [done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1), backlogItem(2), backlogItem(3)],
  );
  const result = await s.pipeline.step();
  expect(result).toMatchObject({ status: "planned", shaped: 1, asked: 1, stopped: 0 });

  // The rewrite: title and body replaced, the original in a comment, 待批准, still in Backlog, never auto.
  const one = byKey(s, "CYC-1");
  expect(one.title).toBe("在看板上显示整理后的工单");
  expect(one.description).toBe(good("整理后").trim());
  expect(one.columnId).toBe(BACKLOG);
  expect(one.labelIds).toEqual([LABELS.pending]);
  expect(one.priority).toBe("high");
  const on1 = commentsOn(s, "CYC-1");
  expect(on1).toEqual([
    "规划节点调整了优先级：medium → high。\n\n理由：挡着看板的工作",
    `${ORIGINAL_HEADING}\n\n标题：原来的标题 1\n\n原来的正文 1，说得不太清楚。`,
    `${NOTES_HEADING}\n\n按模板整理了小节；验收命令待确认。\n\n盘点的理由：挡着看板的工作`,
  ]);
  // 要问: the questions and 待回答; nothing else.
  const two = byKey(s, "CYC-2");
  expect(two.labelIds).toEqual([LABELS.awaitingAnswer]);
  expect(commentsOn(s, "CYC-2")).toEqual([expect.stringContaining("1. 要显示在哪一列？")]);
  expect(two.title).toBe("原来的标题 2");
  // 不适合: nothing written; only remembered.
  expect(commentsOn(s, "CYC-3")).toEqual([]);
  expect(byKey(s, "CYC-3").labelIds).toEqual([]);
  expect(byKey(s, "CYC-3").priority).toBe("medium");
  const memory = await s.store.loadPlanMemory();
  expect(memory["CYC-3"]).toMatchObject({ category: "不适合", stopped: false });

  // No column moved, no auto anywhere, nothing built, pushed or opened.
  expect(s.tracker.moves).toEqual([]);
  expect(s.tracker.issues.some((i) => i.labelIds.includes(AUTO))).toBe(false);
  expect(forbidden(s.world.calls)).toEqual([]);
  // One detached worktree of the base for the round, made after a fetch and removed at the end.
  const add = s.world.calls.find((c) => c.includes("worktree add"));
  expect(add).toContain("worktree add --detach");
  expect(add).toContain(join(dir, "repo/.agents/worktree/plan-2026-11-26T10-00-00-000Z"));
  expect(add?.endsWith("origin/main")).toBe(true);
  expect(s.world.calls.some((c) => c.includes(" fetch origin"))).toBe(true);
  expect(s.world.calls.some((c) => c.includes("worktree remove --force"))).toBe(true);

  // Three read-only sessions in the round's worktree, each told the bodies directory.
  expect(s.sessions.inputs.map((i) => i.role)).toEqual(["triage", "shape", "shape_qa"]);
  const bodies = s.store.planBodiesDir("2026-11-26T10-00-00-000Z");
  expect(s.sessions.prompts.every((p) => p.readRoots?.includes(bodies))).toBe(true);
  expect(await readFile(join(bodies, "CYC-2.md"), "utf8")).toContain("原来的正文 2");
  expect(s.sessions.prompts[0]?.prompt).toContain("CYC-1 — Feature, medium: 原来的标题 1");
  expect(s.sessions.prompts[1]?.prompt).toContain("FEATURE TEMPLATE");
  expect(s.sessions.prompts[1]?.prompt).toContain("Triage put it as 能做: 挡着看板的工作");
  // The phase field showed 规划 and 规划 QA on the work item being shaped, and was cleared.
  expect(s.tracker.phases).toEqual(["CYC-1:plan", "CYC-1:planQa", "CYC-1:clear"]);

  // Events: the round's run, the work item in `issue`, no text.
  const all = await events(s.store);
  expect(all.map((e) => e.kind)).toEqual([
    "plan_started",
    "triage_turn",
    "plan_priority_changed",
    "plan_asked",
    "plan_triaged",
    "shape_turn",
    "shape_qa_turn",
    "plan_shaped",
    "plan_finished",
  ]);
  expect(new Set(all.map((e) => e.run))).toEqual(new Set(["plan-2026-11-26T10-00-00-000Z"]));
  expect(all.find((e) => e.kind === "plan_triaged")).toMatchObject({
    candidates: 3,
    can: 1,
    ask: 1,
    split: 0,
    unfit: 1,
    queued: 1,
  });
  expect(all.find((e) => e.kind === "plan_shaped")).toMatchObject({
    issue: "CYC-1",
    form: "rewrite",
    parts: 1,
    rounds: 0,
  });
  expect(JSON.stringify(all)).not.toContain("原来的");
  expect(JSON.stringify(all)).not.toContain("看板");

  // The round's own writes do not count as a change: the next step has nothing to do.
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(s.sessions.created).toHaveLength(3);
  // Every planning session is asked for by worktree name (CYC-459), never by a `cwd` of its own: a session whose cwd is
  // the round's directory shows in the desktop as a workspace of its own.
  expect(s.sessions.places.length).toBe(3);
  for (const input of s.sessions.places) {
    expect(input.cwd).toBe(join(dir, "repo"));
    expect(input.worktree?.name).toBe("plan-2026-11-26T10-00-00-000Z");
  }
  const round = (await s.store.plans())[0];
  expect(round).toMatchObject({ phase: "finished", worktree: null });
  expect(existsSync(join(dir, "repo/.agents/worktree/plan-2026-11-26T10-00-00-000Z"))).toBe(false);
});

test("approved work comes first: with a Todo work item to take, no round starts", async () => {
  const todo = issue({ number: 9, key: "CYC-9", id: 9, description: readyDescription });
  const s = setup({}, [todo, backlogItem(1)]);
  // The dev run fails at its first turn (none is scripted): what matters is that it was the one taken.
  await s.pipeline.step().catch(() => {});
  expect(s.tracker.moves).toEqual(["CYC-9:inProgress"]);
  expect(s.sessions.inputs.map((i) => i.role)).toEqual(["dev"]);
  expect(await s.store.plans()).toEqual([]);

  // In a dry run likewise; with Todo empty, it says it would plan.
  const dry = setup(
    {},
    [issue({ number: 9, key: "CYC-9", id: 9, description: readyDescription }), backlogItem(1)],
    { config: { dryRun: true } },
  );
  expect(await dry.pipeline.step()).toMatchObject({ status: "would-take", key: "CYC-9" });
  const idleTodo = setup({}, [backlogItem(1)], { config: { dryRun: true } });
  expect(await idleTodo.pipeline.step()).toMatchObject({ status: "would-plan" });
  expect(await idleTodo.store.plans()).toEqual([]);
});

test("planning off: no Backlog read and no round", async () => {
  const s = setup({}, [backlogItem(1)], { config: { planning: null } });
  let reads = 0;
  const list = s.tracker.listBacklog.bind(s.tracker);
  s.tracker.listBacklog = async () => {
    reads++;
    return list();
  };
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(reads).toBe(0);
  expect(s.sessions.created).toEqual([]);
});

test("a split under a parent: the original becomes part 1, the others are siblings in Backlog, each blocking the next", async () => {
  const s = setup(
    {
      triage: [done(triageReply([{ ...can("CYC-1", "high"), category: "要拆" }], ["CYC-1"]))],
      shape: [done(split(["第一份工作", "第二份工作", "第三份工作"]))],
      shape_qa: [done(PASS)],
    },
    [epicItem(), backlogItem(1, { parentId: 700, priority: "low" })],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  const original = byKey(s, "CYC-1");
  expect(original.title).toBe("第一份工作");
  expect(original.typeId).toBe(FEATURE);
  const made = s.tracker.issues.filter((i) => i.number > 70);
  expect(made.map((i) => [i.title, i.parentId, i.columnId, i.priority, i.typeId])).toEqual([
    ["第二份工作", 700, BACKLOG, "high", FEATURE],
    ["第三份工作", 700, BACKLOG, "high", FEATURE],
  ]);
  expect(s.tracker.issueLinks).toEqual([
    `CYC-1:blocks:${made[0]?.id}`,
    `${made[0]?.key}:blocks:${made[1]?.id}`,
  ]);
  for (const i of [original, ...made]) expect(i.labelIds).toEqual([LABELS.pending]);
  const notes = commentsOn(s, "CYC-1").find((c) => c.startsWith(NOTES_HEADING));
  expect(notes).toContain(
    `- CYC-1 第一份工作\n- ${made[0]?.key} 第二份工作\n- ${made[1]?.key} 第三份工作`,
  );
  expect(byKey(s, "CYC-70").labelIds).toEqual([]);
  expect(s.tracker.moves).toEqual([]);
  expect((await events(s.store)).find((e) => e.kind === "plan_shaped")).toMatchObject({
    form: "split",
    parts: 3,
    keys: `CYC-1,${made[0]?.key},${made[1]?.key}`,
  });
});

test("a split of a work item with no parent: it becomes the Epic, every part its child; 待批准 on the parts only", async () => {
  const s = setup(
    {
      triage: [done(triageReply([{ ...can("CYC-1"), category: "要拆" }], ["CYC-1"]))],
      shape: [done(split(["第一份工作", "第二份工作"], "整件事的目标"))],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  const epic = byKey(s, "CYC-1");
  expect([epic.title, epic.typeId, epic.labelIds]).toEqual(["整件事的目标", EPIC, []]);
  expect(epic.description).toContain("整件事的目标：一段给人看的开头。");
  const parts = s.tracker.issues.filter((i) => i.number > 1);
  expect(parts.map((i) => [i.title, i.parentId, i.columnId, i.labelIds])).toEqual([
    ["第一份工作", epic.id, BACKLOG, [LABELS.pending]],
    ["第二份工作", epic.id, BACKLOG, [LABELS.pending]],
  ]);
  expect(s.tracker.issueLinks).toEqual([`${parts[0]?.key}:blocks:${parts[1]?.id}`]);
});

test("QA rejects, the shaping session fixes it in the same session, QA passes", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite("第一版标题")), done(rewrite("第二版标题"))],
      shape_qa: [done(FAIL), done(PASS)],
    },
    [backlogItem(1)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  expect(byKey(s, "CYC-1").title).toBe("第二版标题");
  const shapes = s.sessions.prompts.filter((p) => p.role === "shape");
  expect(shapes.map((p) => p.sessionId)).toEqual(["shape-2", "shape-2"]);
  expect(shapes[1]?.prompt).toContain("fix round 1");
  expect(shapes[1]?.prompt).toContain("criterion 1 cannot fail");
  expect((await events(s.store)).find((e) => e.kind === "plan_shaped")).toMatchObject({
    rounds: 1,
  });
});

test("the loop's own checks send a reply back: a bun test path without ./ is a fix round", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite("标题", good("x").replace("./cloud/", "cloud/"))), done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  const second = s.sessions.prompts.filter((p) => p.role === "shape")[1]?.prompt;
  expect(second).toContain("must start the path with ./");
});

test("over the fix rounds: shaping stops with one comment, writes nothing else, never Blocked, and is not tried again unchanged", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1"), can("CYC-2")], ["CYC-1", "CYC-2"]))],
      shape: [done(rewrite()), done(rewrite()), done(rewrite("第二张"))],
      shape_qa: [done(FAIL), done(FAIL), done(PASS)],
    },
    [backlogItem(1), backlogItem(2)],
    { config: { maxFixRounds: 1 } },
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1, stopped: 1 });
  const one = byKey(s, "CYC-1");
  expect([one.title, one.description, one.labelIds, one.columnId]).toEqual([
    "原来的标题 1",
    "原来的正文 1，说得不太清楚。",
    [],
    BACKLOG,
  ]);
  const on1 = commentsOn(s, "CYC-1");
  expect(on1).toHaveLength(1);
  expect(on1[0]).toStartWith("规划节点没能加工这张工单，这次什么都没有改：修复了 1 轮仍未通过");
  expect(s.tracker.moves).toEqual([]);
  // The next item was still shaped.
  expect(byKey(s, "CYC-2").title).toBe("第二张");
  expect(await kinds(s.store)).toContain("plan_shape_stopped");
  expect((await s.store.loadPlanMemory())["CYC-1"]).toMatchObject({ stopped: true });
  expect(s.tracker.phases).toContain("CYC-1:clear");

  // After the interval: CYC-1 unchanged is not a candidate, CYC-2 waits for approval: nothing to do, and no round.
  s.clock.at = new Date("2026-11-26T11:00:00.000Z");
  const before = s.sessions.created.length;
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(s.sessions.created).toHaveLength(before);
  expect(await s.store.plans()).toHaveLength(1);
  // A new comment from a person makes it a candidate again.
  s.tracker.threads["CYC-1"]?.push({
    id: 99,
    replyToId: null,
    authorId: "p",
    authorName: "person",
    body: "补充：在第二列。",
    createdAt: "2026-11-26T11:30:00.000Z",
  });
  s.clock.at = new Date("2026-11-26T11:31:00.000Z");
  s.sessions.script.triage.push(done(triageReply([{ ...can("CYC-1"), category: "不适合" }], [])));
  await s.pipeline.step();
  expect(s.sessions.prompts.at(-1)?.prompt).toContain("CYC-1 — Feature");
});

test("shaping that asks instead: the questions and 待回答, no 待批准, no QA", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done("<questions>\n1. 要在哪一列显示？\n2. 要不要显示时间？\n</questions>")],
    },
    [backlogItem(1)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 0, asked: 1 });
  expect(byKey(s, "CYC-1").labelIds).toEqual([LABELS.awaitingAnswer]);
  expect(commentsOn(s, "CYC-1")).toEqual([
    expect.stringContaining("1. 要在哪一列显示？\n2. 要不要显示时间？"),
  ]);
  expect(s.sessions.inputs.map((i) => i.role)).toEqual(["triage", "shape"]);
});

test("a restart in the middle of a split makes nothing twice and misses nothing, and posts each comment once", async () => {
  const s = setup(
    {
      triage: [done(triageReply([{ ...can("CYC-1"), category: "要拆" }], ["CYC-1"]))],
      shape: [done(split(["第一份工作", "第二份工作", "第三份工作"], "整件事的目标"))],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  // The second part is made, then the process dies before it is saved.
  let creates = 0;
  const create = s.tracker.createIssue.bind(s.tracker);
  s.tracker.createIssue = async (input) => {
    const made = await create(input);
    creates++;
    if (creates === 2) throw new Error("tracker x: connection reset (killed)");
    return made;
  };
  expect(await s.pipeline.step()).toMatchObject({ status: "network_wait" });
  expect(s.tracker.issues.filter((i) => i.parentId === 101)).toHaveLength(2);

  const again = s.restart();
  expect(await again.step()).toMatchObject({ status: "planned", shaped: 1 });
  const parts = s.tracker.issues.filter((i) => i.parentId === 101);
  expect(parts.map((i) => i.title)).toEqual(["第一份工作", "第二份工作", "第三份工作"]);
  expect(creates).toBe(3);
  expect(s.tracker.issueLinks).toEqual([
    `${parts[0]?.key}:blocks:${parts[1]?.id}`,
    `${parts[1]?.key}:blocks:${parts[2]?.id}`,
  ]);
  const on1 = commentsOn(s, "CYC-1");
  expect(on1.filter((c) => c.startsWith(ORIGINAL_HEADING))).toHaveLength(1);
  expect(on1.filter((c) => c.startsWith(NOTES_HEADING))).toHaveLength(1);
  for (const p of parts) expect(p.labelIds).toEqual([LABELS.pending]);
  expect(await kinds(s.store)).toContain("recovered");
});

test("a comment posted just before a restart is not posted again", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  // The notes comment lands, then the process dies before its step is saved.
  const comment = s.tracker.comment.bind(s.tracker);
  let killed = false;
  s.tracker.comment = async (i, text) => {
    await comment(i, text);
    if (!killed && text.startsWith(NOTES_HEADING)) {
      killed = true;
      throw new Error("tracker x: connection reset (killed)");
    }
  };
  expect(await s.pipeline.step()).toMatchObject({ status: "network_wait" });
  expect(await s.restart().step()).toMatchObject({ status: "planned", shaped: 1 });
  expect(commentsOn(s, "CYC-1").filter((c) => c.startsWith(NOTES_HEADING))).toHaveLength(1);
  expect(byKey(s, "CYC-1").labelIds).toEqual([LABELS.pending]);
});

for (const [name, change, why] of [
  ["a person edited the title", (i: Issue) => Object.assign(i, { title: "人改的标题" }), "edited"],
  [
    "a person edited the body",
    (i: Issue) => Object.assign(i, { description: `${i.description}\n补一句。` }),
    "edited",
  ],
  ["it left Backlog", (i: Issue) => Object.assign(i, { columnId: TODO }), "moved"],
  ["it was marked to skip", (i: Issue) => Object.assign(i, { labelIds: [LABELS.skip] }), "skip"],
] as const) {
  test(`${name} while it was being shaped: abandoned, nothing written`, async () => {
    const s = setup(
      {
        triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
        shape: [done(rewrite())],
        shape_qa: [done(PASS)],
      },
      [backlogItem(1)],
    );
    const turn = s.sessions.turn.bind(s.sessions);
    s.sessions.turn = async (id, prompt, ctx) => {
      const out = await turn(id, prompt, ctx);
      if (ctx.role === "shape_qa") change(byKey(s, "CYC-1"));
      return out;
    };
    expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 0, abandoned: 1 });
    expect(commentsOn(s, "CYC-1")).toEqual([]);
    expect(byKey(s, "CYC-1").labelIds).not.toContain(LABELS.pending);
    expect(byKey(s, "CYC-1").title).not.toBe("在看板上显示整理后的工单");
    expect((await events(s.store)).find((e) => e.kind === "plan_abandoned")).toMatchObject({
      issue: "CYC-1",
      why,
    });
  });
}

test("text shaped like a credential: nothing of it is written, one comment says so without it", async () => {
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite("标题", good(`配置 ${secret}`)))],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 0, stopped: 1 });
  const one = byKey(s, "CYC-1");
  expect([one.title, one.labelIds]).toEqual(["原来的标题 1", []]);
  const on1 = commentsOn(s, "CYC-1");
  expect(on1).toHaveLength(1);
  expect(on1[0]).toContain("疑似凭据（anthropic-key");
  expect(s.tracker.comments.join("\n")).not.toContain(secret);
  expect(JSON.stringify(await events(s.store))).not.toContain(secret);
});

test("a session that changes the worktree is not trusted: that work item stops, the round goes on", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite())],
    },
    [backlogItem(1)],
  );
  const turn = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await turn(id, prompt, ctx);
    if (ctx.role === "shape") s.world.dirty = true;
    return out;
  };
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", stopped: 1 });
  expect(commentsOn(s, "CYC-1")[0]).toContain("加工会话修改了工作区");
  expect(byKey(s, "CYC-1").title).toBe("原来的标题 1");
});

test("triage that cannot be fixed ends the round and writes nothing", async () => {
  const s = setup({ triage: [done("no blocks"), done("still none"), done("none again")] }, [
    backlogItem(1),
  ]);
  const result = await s.pipeline.step();
  expect(result).toMatchObject({ status: "plan_stopped" });
  expect(s.tracker.comments).toEqual([]);
  expect(s.sessions.prompts.map((p) => p.sessionId)).toEqual(["triage-1", "triage-1", "triage-1"]);
  expect(s.sessions.prompts[1]?.prompt).toContain("fix round 1");
  expect((await s.store.plans())[0]).toMatchObject({ phase: "abandoned" });
  expect((await events(s.store)).at(-1)).toMatchObject({
    kind: "plan_finished",
    outcome: "triage_stopped",
  });
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
});

test("a full queue: only as many are shaped as there is room for among those waiting for approval", async () => {
  const waiting = [3, 4, 5, 6].map((n) => backlogItem(n, { labelIds: [LABELS.pending] }));
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1"), can("CYC-2")], ["CYC-2", "CYC-1"]))],
      shape: [done(rewrite("第二张"))],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1), backlogItem(2), ...waiting],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  expect(byKey(s, "CYC-2").title).toBe("第二张");
  expect(byKey(s, "CYC-1").title).toBe("原来的标题 1");
  // Five now wait for approval: no new round, even after the interval.
  s.clock.at = new Date("2026-11-26T12:00:00.000Z");
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
});

test("a planned work item, once approved, is taken by a dev run: the plan's record and worktree are not in its way", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  // A person approves it on the Loop page: Todo, auto, no 待批准.
  const one = byKey(s, "CYC-1");
  one.columnId = TODO;
  one.labelIds = [AUTO];
  s.clock.at = new Date("2026-11-26T10:05:00.000Z");
  await s.pipeline.step().catch(() => {});
  expect(s.tracker.moves).toEqual(["CYC-1:inProgress"]);
  const run = await s.store.load("CYC-1");
  expect(run).toMatchObject({ kind: "dev", remoteBranch: "auto/cyc-1" });
  expect(s.sessions.inputs.at(-1)?.role).toBe("dev");
  // The plan's record is under plans/, the run's under runs/; neither is the other's.
  expect((await s.store.plans()).map((r) => r.phase)).toEqual(["finished"]);
  expect((await s.store.unfinished()).map((r) => r.key)).toEqual(["CYC-1"]);
  const devEvents = (await events(s.store)).filter((e) => e.run === "CYC-1");
  expect(devEvents[0]?.kind).toBe("claimed");

  // Stats count the round apart from the runs, and the claim as the approval of what was shaped.
  const stats = computeStats(await events(s.store));
  expect(stats.runs).toBe(1);
  expect(stats.planning).toEqual({
    rounds: 1,
    triageStopped: 0,
    categories: { can: 1, ask: 0, split: 0, unfit: 0 },
    priorityChanged: 0,
    asked: 0,
    shaped: 1,
    stopped: 0,
    abandoned: 0,
    meanFixRounds: 0,
    approvalRate: 1,
  });
});

test("shaping is shown CYC-443 as an example of form, with its bun test paths as the checks want them", async () => {
  const example = backlogItem(443, {
    columnId: 24,
    title: "看板上显示阶段",
    description: "开头。\n\n## 验收标准\n\n1. x。验证：`bun test apps/desktop/test/loop.test.ts`",
  });
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1), example],
  );
  await s.pipeline.step();
  const brief = s.sessions.prompts.find((p) => p.role === "shape")?.prompt ?? "";
  expect(brief).toContain("A work item of this project written well (CYC-443: 看板上显示阶段)");
  expect(brief).toContain("`bun test ./apps/desktop/test/loop.test.ts`");
});

test("a round killed in the middle goes on after a restart, from where it was", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [new Error("connection reset (daemon gone)"), done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "network_wait" });
  expect((await s.store.unfinishedPlans()).map((r) => r.phase)).toEqual(["shaping"]);
  const again = s.restart();
  expect(await again.step()).toMatchObject({ status: "planned", shaped: 1 });
  // Triage was not run again; the shaping session was reused.
  expect(s.sessions.inputs.map((i) => i.role)).toEqual(["triage", "shape", "shape_qa"]);
  expect(await kinds(s.store)).toContain("recovered");
});

test("a worktree that could not be removed when the round ended is removed by a later cleanup", async () => {
  const s = setup(
    {
      triage: [
        done(
          triageReply(
            [{ key: "CYC-1", category: "不适合", priority: "medium", reason: "要真实账号" }],
            [],
          ),
        ),
      ],
    },
    [backlogItem(1)],
  );
  s.world.fail.add("worktree remove");
  expect(await s.pipeline.step()).toMatchObject({ status: "planned" });
  const path = join(dir, "repo/.agents/worktree/plan-2026-11-26T10-00-00-000Z");
  expect((await s.store.plans())[0]?.worktree).toBe(path);
  s.world.fail.delete("worktree remove");
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect((await s.store.plans())[0]?.worktree).toBeNull();
  expect(existsSync(path)).toBe(false);
});

/** Counts the tracker reads and the round records read, from now on. */
const spy = (s: ReturnType<typeof setup>) => {
  const n = { rows: 0, backlog: 0, get: 0, comments: 0, loadPlan: 0, plans: 0 };
  const t = s.tracker;
  const wrap = <K extends "listBacklogRows" | "listBacklog" | "get" | "listComments">(
    name: K,
    field: keyof typeof n,
  ) => {
    const original = (t[name] as (...a: unknown[]) => Promise<unknown>).bind(t);
    (t as unknown as Record<string, unknown>)[name] = async (...a: unknown[]) => {
      n[field]++;
      return original(...a);
    };
  };
  wrap("listBacklogRows", "rows");
  wrap("listBacklog", "backlog");
  wrap("get", "get");
  wrap("listComments", "comments");
  const loadPlan = s.store.loadPlan.bind(s.store);
  s.store.loadPlan = async (id) => {
    n.loadPlan++;
    return loadPlan(id);
  };
  const plans = s.store.plans.bind(s.store);
  s.store.plans = async () => {
    n.plans++;
    return plans();
  };
  return n;
};

const unfit = (key: string) => ({
  key,
  category: "不适合",
  priority: "medium",
  reason: "要真实账号",
});

test("an idle step looks at the Backlog at most once every checkMinutes, in one list call, and reads no past round", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1"), unfit("CYC-3")], ["CYC-1"]))],
      shape: [done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1), backlogItem(3)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  const n = spy(s);
  // Inside checkMinutes (5): nothing is read at all, in this process or a new one (the index is on disk).
  s.clock.at = new Date("2026-11-26T10:04:00.000Z");
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(await s.restart().step()).toEqual({ status: "idle" });
  expect(n).toEqual({ rows: 0, backlog: 0, get: 0, comments: 0, loadPlan: 0, plans: 0 });
  // After it, inside the interval: one list call, and the comments of the one watched work item (CYC-3; CYC-1
  // waits for approval), each read once. No issue is read in full and no past round is read.
  s.clock.at = new Date("2026-11-26T10:06:00.000Z");
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(n).toEqual({ rows: 1, backlog: 0, get: 0, comments: 1, loadPlan: 0, plans: 0 });
  // And not again for the next five minutes.
  s.clock.at = new Date("2026-11-26T10:10:00.000Z");
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(n.rows).toBe(1);
});

test("checkMinutes comes from the config", async () => {
  const s = setup({ triage: [done(triageReply([unfit("CYC-1")], []))] }, [backlogItem(1)], {
    planning: { checkMinutes: 20 },
  });
  await s.pipeline.step();
  const n = spy(s);
  s.clock.at = new Date("2026-11-26T10:15:00.000Z");
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(n.rows).toBe(0);
  s.clock.at = new Date("2026-11-26T10:21:00.000Z");
  await s.pipeline.step();
  expect(n.rows).toBe(1);
});

test("inside the interval, a new comment or an edit by a person starts a round; an edited row needs no comment read", async () => {
  const s = setup(
    {
      triage: [
        done(triageReply([unfit("CYC-1"), unfit("CYC-2")], [])),
        done(triageReply([can("CYC-1")], ["CYC-1"])),
        done(triageReply([can("CYC-2")], ["CYC-2"])),
      ],
      shape: [done(rewrite()), done(rewrite("第二张"))],
      shape_qa: [done(PASS), done(PASS)],
    },
    [backlogItem(1), backlogItem(2)],
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 0 });
  // A person answers on CYC-1: the rows are as they were, so the comments are read, and the new one counts.
  s.tracker.threads["CYC-1"] = [
    {
      id: 99,
      replyToId: null,
      authorId: "p",
      authorName: "person",
      body: "补充：只要在第二列显示。",
      createdAt: "2026-11-26T10:05:00.000Z",
    },
  ];
  s.clock.at = new Date("2026-11-26T10:06:00.000Z");
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  // A person rewrites CYC-2: its row's updatedAt moved, which is enough; no comment is read to find it.
  byKey(s, "CYC-2").description = "人重写了正文，说清楚了。";
  s.clock.at = new Date("2026-11-26T10:12:00.000Z");
  const n = spy(s);
  const listComments = s.tracker.listComments.bind(s.tracker);
  let readBeforeTheRound = 0;
  s.tracker.listComments = async (i) => {
    if (n.backlog === 0) readBeforeTheRound++;
    return listComments(i);
  };
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1 });
  expect(readBeforeTheRound).toBe(0);
  expect(n.rows).toBeGreaterThanOrEqual(1);
});

test("nothing to plan makes no round: no directory under plans/, only the index", async () => {
  // An Epic and a work item already waiting for approval: no candidate.
  const s = setup({}, [epicItem(), backlogItem(1, { labelIds: [LABELS.pending] })]);
  const n = spy(s);
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(s.sessions.created).toEqual([]);
  expect(await s.store.plans()).toEqual([]);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(join(s.cfg.stateDir, "plans"))).toEqual(["index.json"]);
  expect(await s.store.loadPlanIndex()).toMatchObject({
    open: null,
    lastEndedAt: "2026-11-26T10:00:00.000Z",
  });
  expect(await kinds(s.store)).toEqual([]);
  expect(n.loadPlan).toBe(0);
  // Each interval the same: still no directory.
  s.clock.at = new Date("2026-11-26T10:31:00.000Z");
  expect(await s.pipeline.step()).toEqual({ status: "idle" });
  expect(await readdir(join(s.cfg.stateDir, "plans"))).toEqual(["index.json"]);
});

test("a work item deleted in the middle of a round does not hold it up", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1"), can("CYC-2")], ["CYC-1", "CYC-2"]))],
      shape: [done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1), backlogItem(2)],
  );
  const turn = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await turn(id, prompt, ctx);
    if (ctx.role === "shape") s.tracker.issues = s.tracker.issues.filter((i) => i.key !== "CYC-2");
    return out;
  };
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1, abandoned: 1 });
  expect((await events(s.store)).find((e) => e.kind === "plan_abandoned")).toMatchObject({
    issue: "CYC-2",
    why: "gone",
  });
  expect((await s.store.plans())[0]?.phase).toBe("finished");
});

test("GitHub out of reach when the round fetches: a wait, and the round goes on later", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  // A process whose `git fetch` cannot resolve the host, on the same state and tracker.
  const fetchDown = new Pipeline({
    config: s.cfg,
    tracker: s.tracker,
    sessions: s.sessions,
    exec: async (argv) =>
      argv.includes("fetch")
        ? { code: 128, output: "fatal: unable to access: Could not resolve host", timedOut: false }
        : { code: 0, output: "", timedOut: false },
    store: s.store,
    clock: s.clock,
    log: () => {},
    env: {},
    sleep: async () => {},
  });
  expect(await fetchDown.step()).toMatchObject({ status: "network_wait", command: "git fetch" });
  expect((await s.store.unfinishedPlans()).map((r) => r.phase)).toEqual(["triage"]);
  expect(await s.restart().step()).toMatchObject({ status: "planned", shaped: 1 });
});

test("a round asks about at most maxAsk work items, highest priority first; the rest wait, unwritten, for a later round", async () => {
  const ask = (n: number, priority: string) => ({
    key: `CYC-${n}`,
    category: "要问",
    priority,
    reason: "只有人能定",
    questions: ["要不要做？"],
  });
  const s = setup(
    {
      triage: [
        done(triageReply([ask(1, "low"), ask(2, "high"), ask(3, "medium"), ask(4, "high")], [])),
      ],
    },
    [1, 2, 3, 4].map((n) => backlogItem(n, { priority: null })),
    { planning: { maxAsk: 2 } },
  );
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", asked: 2 });
  for (const n of [2, 4]) expect(byKey(s, `CYC-${n}`).labelIds).toEqual([LABELS.awaitingAnswer]);
  for (const n of [1, 3]) {
    expect(byKey(s, `CYC-${n}`).labelIds).toEqual([]);
    expect(commentsOn(s, `CYC-${n}`).some((c) => c.includes("要不要做"))).toBe(false);
  }
  expect(
    (await events(s.store)).filter((e) => e.kind === "plan_asked").map((e) => e.issue),
  ).toEqual(["CYC-2", "CYC-4"]);
});

test("a work item deleted after shaping stops alone: the next one is shaped, and a new round can begin", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1"), can("CYC-2")], ["CYC-1", "CYC-2"]))],
      shape: [done(rewrite()), done(rewrite("第二张的新标题", good("第二张")))],
      shape_qa: [done(PASS), done(PASS)],
    },
    [backlogItem(1), backlogItem(2)],
  );
  const turn = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await turn(id, prompt, ctx);
    if (ctx.role === "shape_qa" && s.tracker.issues.some((i) => i.number === 1))
      s.tracker.issues = s.tracker.issues.filter((i) => i.number !== 1);
    return out;
  };
  expect(await s.pipeline.step()).toMatchObject({ status: "planned", shaped: 1, stopped: 1 });
  expect(byKey(s, "CYC-2").labelIds).toEqual([LABELS.pending]);
  const failed = (await events(s.store)).find((e) => e.kind === "plan_item_failed");
  expect(failed).toMatchObject({ issue: "CYC-1" });
  expect(Object.keys(failed ?? {}).sort()).toEqual(["error", "issue", "kind", "run", "ts"]);
  expect(await s.store.unfinishedPlans()).toEqual([]);
});

test("an error that is not the network's ends the round, and the next step is not stuck on it", async () => {
  const s = setup({ triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))] }, [backlogItem(1)]);
  const rows = s.tracker.listBacklogRows.bind(s.tracker);
  let broken = true;
  let calls = 0;
  s.tracker.listBacklogRows = async () => {
    if (broken && ++calls > 1) throw new Error("boom: secret detail");
    return rows();
  };
  // The round's end reads the Backlog rows; that fails, and the round ends instead of failing again on every step.
  expect(await s.pipeline.step()).toMatchObject({ status: "plan_stopped" });
  expect((await events(s.store)).find((e) => e.kind === "plan_failed")).toMatchObject({
    error: "Error",
  });
  expect(JSON.stringify(await events(s.store))).not.toContain("secret detail");
  expect(await s.store.unfinishedPlans()).toEqual([]);
  broken = false;
});

test("after a restart, a person's edit before the next write leaves the rest unwritten", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite())],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  // The original is commented, then the process dies; a person edits meanwhile.
  const comment = s.tracker.comment.bind(s.tracker);
  s.tracker.comment = async (i, text) => {
    await comment(i, text);
    if (text.startsWith(ORIGINAL_HEADING)) throw new Error("connection reset (killed)");
  };
  expect(await s.pipeline.step()).toMatchObject({ status: "network_wait" });
  s.tracker.comment = comment;
  Object.assign(byKey(s, "CYC-1"), { description: "人在重启期间改的正文" });
  expect(await s.restart().step()).toMatchObject({ status: "planned", shaped: 0, abandoned: 1 });
  expect(byKey(s, "CYC-1").description).toBe("人在重启期间改的正文");
  expect(commentsOn(s, "CYC-1").filter((c) => c.startsWith(NOTES_HEADING))).toEqual([]);
  expect(byKey(s, "CYC-1").labelIds).not.toContain(LABELS.pending);
});

test("a rewrite that keeps the title still gives way to a person's edit of the body before the first write", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite("原来的标题 1"))],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  const turn = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await turn(id, prompt, ctx);
    if (ctx.role === "shape_qa") Object.assign(byKey(s, "CYC-1"), { description: "人改的正文" });
    return out;
  };
  expect(await s.pipeline.step()).toMatchObject({ shaped: 0, abandoned: 1 });
  expect(byKey(s, "CYC-1").description).toBe("人改的正文");
  expect(commentsOn(s, "CYC-1")).toEqual([]);
});

for (const [name, title, killAfter] of [
  ["the title unchanged, killed after the description", "原来的标题 1", "setDescription"],
  ["a new title, killed after the title", "全新的标题", "setTitle"],
] as const) {
  test(`a restart in the middle of the rewrite (${name}) finishes the item`, async () => {
    const s = setup(
      {
        triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
        shape: [done(rewrite(title))],
        shape_qa: [done(PASS)],
      },
      [backlogItem(1)],
    );
    const call = s.tracker[killAfter].bind(s.tracker);
    s.tracker[killAfter] = async (i, text) => {
      await call(i, text);
      throw new Error("connection reset (killed)");
    };
    expect(await s.pipeline.step()).toMatchObject({ status: "network_wait" });
    s.tracker[killAfter] = call;
    expect(await s.restart().step()).toMatchObject({ status: "planned", shaped: 1 });
    expect(byKey(s, "CYC-1").labelIds).toEqual([LABELS.pending]);
    expect(commentsOn(s, "CYC-1").filter((c) => c.startsWith(NOTES_HEADING))).toHaveLength(1);
  });
}

test("a person's edit between the title and the description writes is not overwritten", async () => {
  const s = setup(
    {
      triage: [done(triageReply([can("CYC-1")], ["CYC-1"]))],
      shape: [done(rewrite("全新的标题"))],
      shape_qa: [done(PASS)],
    },
    [backlogItem(1)],
  );
  const setTitle = s.tracker.setTitle.bind(s.tracker);
  s.tracker.setTitle = async (i, text) => {
    await setTitle(i, text);
    throw new Error("connection reset (killed)");
  };
  await s.pipeline.step();
  s.tracker.setTitle = setTitle;
  Object.assign(byKey(s, "CYC-1"), { description: "人改的正文" });
  expect(await s.restart().step()).toMatchObject({ shaped: 0, abandoned: 1 });
  expect(byKey(s, "CYC-1").description).toBe("人改的正文");
});
