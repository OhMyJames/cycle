// The research flow in the pipeline (CYC-447): claim, a read-only research session, QA, and the loop's own publication.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deps, Pipeline } from "../src/pipeline.ts";
import { RunStore } from "../src/store.ts";
import { type Issue, SessionLost } from "../src/types.ts";
import {
  CHECKED,
  config,
  done,
  FakeSessions,
  FakeTracker,
  fullBug,
  issue,
  makeExec,
  PASS,
  readyDescription,
  type Script,
  type World,
  WT,
} from "./helpers.ts";

const RESEARCH_TYPE = 23;
const BACKLOG = 21;
const FOLDER = 10;
const ROOTS = ["/repo", "/data/runs"];

const FAIL = `${CHECKED}<verdict>{"pass":false,"findings":[{"severity":"major","where":"问题 1","problem":"the evidence does not hold","fix":"check a.ts again"}]}</verdict>`;

const description = `## 背景
x

## 要回答的问题

1. 有多少 worktree？
2. 能删多少？

## 方法与范围
只读本地文件。

## 产出形式
一份报告。

## 结论

（做完后回填）
`;

const reply = (summary = "能删一半。") => `<summary>${summary}</summary>
<report>
## 问题 1
12 个。依据：\`ls .agents/worktree\`。

## 问题 2
6 个。依据：\`git worktree list\`。
</report>
<followup type="Feature" title="Delete stale worktrees">
${readyDescription}</followup>
<followup type="Bug" title="Worktree left after Done">
${fullBug}</followup>`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-research-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const researchConfig = (over = {}) =>
  config({
    stateDir: dir,
    allowedTypeIds: [20, 25, RESEARCH_TYPE],
    research: {
      typeId: RESEARCH_TYPE,
      backlogColumn: BACKLOG,
      folderId: FOLDER,
      readRoots: ROOTS,
      maxFollowups: 5,
    },
    ...over,
  });

const researchIssue = (over: Partial<Issue> = {}) =>
  issue({ typeId: RESEARCH_TYPE, description, parentId: 77, ...over });

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
});

const setup = (script: Partial<Script>, over = {}, issues: Issue[] = [researchIssue()]) => {
  const cfg = researchConfig(over);
  const tracker = new FakeTracker(issues);
  const sessions = new FakeSessions({ dev: [], qa: [], ...script });
  const w = world();
  const clock = { now: () => new Date("2026-11-25T00:00:00Z") };
  const store = new RunStore(cfg.stateDir, () => clock.now());
  const deps = (more: Partial<Deps> = {}): Deps => ({
    config: cfg,
    tracker,
    sessions,
    exec: makeExec(w),
    store,
    clock,
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret" },
    sleep: async () => {},
    ...more,
  });
  /** A new process on the same state, tracker and repository. */
  const restart = (more: Partial<Deps> = {}) => new Pipeline(deps(more));
  return { pipeline: new Pipeline(deps()), tracker, sessions, world: w, store, restart };
};

const kinds = async (store: RunStore) => (await store.events()).map((e) => e.kind);

/** Calls that would build, push or open a pull request: a research run makes none. */
const forbidden = (calls: string[]) =>
  calls.filter((c) => c.includes("bun install") || c.includes(" push ") || c.startsWith("gh "));

/** Makes the role's turns, after they end, change the worktree. */
const writes = (s: ReturnType<typeof setup>, role: string) => {
  const original = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await original(id, prompt, ctx);
    if (ctx.role === role) s.world.dirty = true;
    return out;
  };
};

const putBack = (s: ReturnType<typeof setup>) => {
  const found = s.tracker.issues[0] as Issue;
  found.columnId = 22;
};

test("happy path: claim, research, QA, publish, Done; nothing installed, pushed or opened", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const result = await s.pipeline.step();
  expect(result).toEqual({
    status: "researched",
    key: "CYC-1",
    docId: 1000,
    followups: ["CYC-2", "CYC-3"],
  });

  // Claim: a fresh origin/main, a research session in the work item's worktree, no install.
  expect(s.world.calls.some((c) => c.includes(" fetch origin"))).toBe(true);
  expect(forbidden(s.world.calls)).toEqual([]);
  expect(s.sessions.created).toEqual(["research-1", "research_qa-2"]);
  expect(s.sessions.inputs.map((i) => i.role)).toEqual(["research", "research_qa"]);
  // Every turn is told the read roots, and QA is told them in its brief.
  expect(s.sessions.prompts.map((p) => [p.role, p.readRoots])).toEqual([
    ["research", ROOTS],
    ["research_qa", ROOTS],
  ]);
  expect(s.sessions.prompts[0]?.prompt).toContain("You are the researcher for work item CYC-1");
  expect(s.sessions.prompts[1]?.prompt).toContain("- /repo\n- /data/runs");

  // The report, under the folder, on the work item.
  expect(s.tracker.written).toEqual([
    {
      id: 1000,
      parentId: FOLDER,
      title: "CYC-1 title",
      content: expect.stringContaining("## 问题 1"),
    },
  ]);
  expect(s.tracker.docLinks).toEqual(["CYC-1:1000"]);
  // 「结论」 is the summary and the report's title; the rest of the description is as it was.
  const after = (s.tracker.issues[0] as Issue).description;
  expect(after).toContain("## 结论\n\n能删一半。\n\n报告：「CYC-1 title」");
  expect(after).not.toContain("做完后回填");
  expect(after.split("## 结论")[0]).toBe(description.split("## 结论")[0]);
  // Follow-ups in Backlog, under the research item's parent, no labels or priority, linked.
  const made = s.tracker.issues.slice(1);
  expect(
    made.map((i) => [i.key, i.title, i.typeId, i.columnId, i.parentId, i.labelIds, i.priority]),
  ).toEqual([
    ["CYC-2", "Delete stale worktrees", 20, BACKLOG, 77, [], null],
    ["CYC-3", "Worktree left after Done", 25, BACKLOG, 77, [], null],
  ]);
  expect(made[0]?.description).toBe(readyDescription.trim());
  expect(s.tracker.issueLinks).toEqual([
    `CYC-1:relates:${made[0]?.id}`,
    `CYC-1:relates:${made[1]?.id}`,
  ]);
  // One closing comment, then Done; the phase field went 调研 → 调研 QA → cleared.
  expect(s.tracker.comments).toHaveLength(1);
  expect(s.tracker.comments[0]).toContain("报告：「CYC-1 title」");
  expect(s.tracker.comments[0]).toContain(
    "- CYC-2 Delete stale worktrees\n- CYC-3 Worktree left after Done",
  );
  expect(s.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:done"]);
  expect(s.tracker.phases).toEqual(["CYC-1:research", "CYC-1:researchQa", "CYC-1:clear"]);

  const run = await s.store.load("CYC-1");
  expect(run?.kind).toBe("research");
  expect(run?.phase).toBe("done");
  expect(run?.devSessionId).toBe("research-1");
  expect(run?.qaSessionId).toBe("research_qa-2");
  expect(run?.prUrl).toBeNull();
  const events = await s.store.events();
  expect(events.find((e) => e.kind === "claimed")).toMatchObject({
    runKind: "research",
    questions: 2,
  });
  expect(events.find((e) => e.kind === "researched")).toMatchObject({ docId: 1000, followups: 2 });
});

test("a reply that fails the checks goes back to the same session as a fix round", async () => {
  const s = setup({
    research: [done("<report>## 问题 1\nx</report>"), done(reply())],
    research_qa: [done(PASS)],
  });
  expect((await s.pipeline.step()).status).toBe("researched");
  expect(s.sessions.created).toEqual(["research-1", "research_qa-2"]);
  const second = s.sessions.prompts[1];
  expect(second?.sessionId).toBe("research-1");
  expect(second?.prompt).toContain("fix round 1");
  expect(second?.prompt).toContain("There is no <summary>");
  expect(second?.prompt).toContain("「问题 2」");
  expect(await kinds(s.store)).toContain("round_failed");
});

test("QA that does not pass sends its findings back to research, which goes to QA again", async () => {
  const s = setup({
    research: [done(reply("初稿。")), done(reply("改过的。"))],
    research_qa: [done(FAIL), done(PASS)],
  });
  expect((await s.pipeline.step()).status).toBe("researched");
  const research = s.sessions.prompts.filter((p) => p.role === "research");
  expect(research).toHaveLength(2);
  expect(research[1]?.sessionId).toBe("research-1");
  expect(research[1]?.prompt).toContain("Independent review found");
  expect(research[1]?.prompt).toContain("the evidence does not hold");
  // What is published is the reply QA passed.
  expect((s.tracker.issues[0] as Issue).description).toContain("改过的。");
  expect(s.sessions.prompts.at(-1)?.prompt).toContain("改过的。");
});

test("QA that keeps failing past the fix rounds blocks; put back, research goes on in the same session", async () => {
  const s = setup(
    { research: [done(reply()), done(reply())], research_qa: [done(FAIL), done(FAIL)] },
    { maxFixRounds: 1 },
  );
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.moves).toEqual(["CYC-1:inProgress", "CYC-1:blocked"]);
  expect(s.tracker.comments[0]).toContain("「调研 QA」卡住了");
  expect(s.tracker.comments[0]).toContain("调研会话「[CYC-1] Research」");
  expect(s.tracker.written).toEqual([]);
  let run = await s.store.load("CYC-1");
  expect(run?.resumeFrom).toBe("research");
  expect(run?.findings).toContain("the evidence does not hold");
  expect(s.tracker.phases.at(-1)).toBe("CYC-1:clear");

  // Nothing while it stays Blocked.
  expect((await s.pipeline.step()).status).toBe("idle");

  putBack(s);
  s.sessions.script.research.push(done(reply("人看过后。")));
  s.sessions.script.research_qa.push(done(PASS));
  expect((await s.pipeline.step()).status).toBe("researched");
  const resumed = s.sessions.prompts.filter((p) => p.role === "research").at(-1);
  expect(resumed?.sessionId).toBe("research-1");
  expect(resumed?.prompt).toContain("the evidence does not hold");
  expect(s.sessions.created.filter((id) => id.startsWith("research-"))).toEqual(["research-1"]);
  run = await s.store.load("CYC-1");
  expect(run?.phase).toBe("done");
  expect(await kinds(s.store)).toContain("resumed");
});

test("checks that keep failing past the fix rounds block in research", async () => {
  const s = setup({ research: [done("nothing"), done("nothing")] }, { maxFixRounds: 1 });
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.tracker.comments[0]).toContain("「调研」卡住了");
  expect((await s.store.load("CYC-1"))?.resumeFrom).toBe("research");
  expect(s.sessions.created).toEqual(["research-1"]);
});

test("a research session that changes the worktree blocks, and nothing goes to QA", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  writes(s, "research");
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  if (result.status === "blocked") expect(result.reason).toContain("调研会话修改了工作区");
  expect(s.sessions.created).toEqual(["research-1"]);
  expect(s.tracker.written).toEqual([]);
});

test("a research QA session that changes the worktree blocks; put back, QA runs again", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  writes(s, "research_qa");
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect((await s.store.load("CYC-1"))?.resumeFrom).toBe("research_qa");
  expect(s.tracker.written).toEqual([]);

  // A person tidied the worktree and put it back: QA judges the saved reply again, research is not run again.
  s.world.dirty = false;
  s.sessions.turn = FakeSessions.prototype.turn.bind(s.sessions);
  s.sessions.script.research_qa.push(done(PASS));
  putBack(s);
  expect((await s.pipeline.step()).status).toBe("researched");
  expect(s.sessions.prompts.filter((p) => p.role === "research")).toHaveLength(1);
});

test("a research session that cannot be continued is replaced and given the whole brief", async () => {
  const s = setup({
    research: [new SessionLost("gone"), done(reply())],
    research_qa: [done(PASS)],
  });
  expect((await s.pipeline.step()).status).toBe("researched");
  expect(s.sessions.created).toEqual(["research-1", "research-2", "research_qa-3"]);
  expect((await s.store.load("CYC-1"))?.replacedSessions).toEqual(["research-1"]);
  expect(s.sessions.prompts[1]?.prompt).toContain("You are the researcher for work item CYC-1");
  expect(s.sessions.prompts[1]?.readRoots).toEqual(ROOTS);
});

test("a restart after the report was made, before any follow-up: no second report, every follow-up once", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const createIssue = s.tracker.createIssue.bind(s.tracker);
  s.tracker.createIssue = async () => {
    throw new Error("killed");
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  expect((await s.store.load("CYC-1"))?.phase).toBe("publishing");
  expect(s.tracker.written).toHaveLength(1);

  s.tracker.createIssue = createIssue;
  const result = await s.restart().step();
  expect(result.status).toBe("researched");
  expect(s.tracker.written).toHaveLength(1);
  expect(s.tracker.docLinks).toEqual(["CYC-1:1000"]);
  expect(s.tracker.issues.slice(1).map((i) => i.title)).toEqual([
    "Delete stale worktrees",
    "Worktree left after Done",
  ]);
  expect(s.tracker.issueLinks).toHaveLength(2);
  expect(s.tracker.comments).toHaveLength(1);
  expect(await kinds(s.store)).toContain("recovered");
});

test("a restart after the first follow-up was made: it is not made again and the second is made once", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const createIssue = s.tracker.createIssue.bind(s.tracker);
  let made = 0;
  s.tracker.createIssue = async (input) => {
    if (made++ === 1) throw new Error("killed");
    return createIssue(input);
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  expect(s.tracker.issues).toHaveLength(2);

  s.tracker.createIssue = createIssue;
  expect((await s.restart().step()).status).toBe("researched");
  expect(s.tracker.issues.slice(1).map((i) => i.key)).toEqual(["CYC-2", "CYC-3"]);
  expect(s.tracker.issueLinks).toHaveLength(2);
  expect(s.tracker.written).toHaveLength(1);
});

test("a restart between making a follow-up and linking it links it once and makes nothing again", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const linkIssues = s.tracker.linkIssues.bind(s.tracker);
  s.tracker.linkIssues = async () => {
    throw new Error("killed");
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  s.tracker.linkIssues = linkIssues;
  expect((await s.restart().step()).status).toBe("researched");
  expect(s.tracker.issues).toHaveLength(3);
  const ids = s.tracker.issues.slice(1).map((i) => `CYC-1:relates:${i.id}`);
  expect(s.tracker.issueLinks).toEqual(ids);
});

test("a restart after 「结论」 was written does not take the written one for a person's and comment it", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const setDescription = s.tracker.setDescription.bind(s.tracker);
  s.tracker.setDescription = async (i, text) => {
    await setDescription(i, text);
    throw new Error("killed");
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  s.tracker.setDescription = setDescription;
  expect((await s.restart().step()).status).toBe("researched");
  // Only the closing comment: the summary was not sent as a comment as well.
  expect(s.tracker.comments).toHaveLength(1);
  expect(s.tracker.comments[0]).toContain("调研完成");
  expect((s.tracker.issues[0] as Issue).description.match(/能删一半/g)).toHaveLength(1);
});

test("a 「结论」 someone wrote meanwhile is not overwritten: the summary goes in a comment", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const written = description.replace("（做完后回填）", "人已经写好的结论。");
  const original = s.sessions.turn.bind(s.sessions);
  s.sessions.turn = async (id, prompt, ctx) => {
    const out = await original(id, prompt, ctx);
    (s.tracker.issues[0] as Issue).description = written;
    return out;
  };
  expect((await s.pipeline.step()).status).toBe("researched");
  expect((s.tracker.issues[0] as Issue).description).toBe(written);
  expect(s.tracker.comments).toHaveLength(2);
  expect(s.tracker.comments[0]).toContain("没有覆盖");
  expect(s.tracker.comments[0]).toContain("能删一半。");
  expect(s.tracker.docLinks).toEqual(["CYC-1:1000"]);
});

test("a credential in the reply blocks before anything is published; put back, research writes it again", async () => {
  const token = `ghp_${"a1".repeat(18)}`;
  const leaky = reply().replace("12 个。", `12 个。远端用的是 ${token}。`);
  const s = setup({ research: [done(leaky)], research_qa: [done(PASS)] });
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.written).toEqual([]);
  expect(s.tracker.docLinks).toEqual([]);
  expect(s.tracker.issues).toHaveLength(1);
  expect((s.tracker.issues[0] as Issue).description).toBe(description);
  expect(s.tracker.comments).toHaveLength(1);
  expect(s.tracker.comments[0]).toContain("github-token");
  expect(s.tracker.comments[0]).not.toContain(token);
  expect(s.tracker.comments[0]).toContain("「发布」卡住了");
  const run = await s.store.load("CYC-1");
  expect(run?.resumeFrom).toBe("research");
  expect(JSON.stringify(await s.store.events())).not.toContain(token);

  putBack(s);
  s.sessions.script.research.push(done(reply()));
  s.sessions.script.research_qa.push(done(PASS));
  expect((await s.pipeline.step()).status).toBe("researched");
  const resumed = s.sessions.prompts.filter((p) => p.role === "research").at(-1);
  expect(resumed?.sessionId).toBe("research-1");
  expect(resumed?.prompt).toContain("shaped like a credential (github-token)");
  expect(s.tracker.written[0]?.content).not.toContain(token);
});

test("a process restarted in research with findings saved sends the fix brief, not the first one again", async () => {
  const s = setup({ research: [done("no blocks")] }, { maxFixRounds: 3 });
  const original = s.sessions.turn.bind(s.sessions);
  let calls = 0;
  s.sessions.turn = async (id, prompt, ctx) => {
    if (calls++ === 1) throw new Error("killed");
    return original(id, prompt, ctx);
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  // The first reply failed the checks; the second turn was cut off by the crash. Findings are saved: a fix brief.
  s.sessions.turn = original;
  s.sessions.script.research.push(done(reply()));
  s.sessions.script.research_qa.push(done(PASS));
  expect((await s.restart().step()).status).toBe("researched");
  const last = s.sessions.prompts.filter((p) => p.role === "research").at(-1);
  expect(last?.prompt).toContain("fix round 1");
});

test("a recovered research run with no saved findings is told to carry on", async () => {
  const s = setup({ research: [done(reply())], research_qa: [] });
  // Killed during QA, then the run is put back into research as a person would not: recovery from `research`.
  s.sessions.turn = async (id, prompt, ctx) => {
    if (ctx.role === "research_qa") throw new Error("killed");
    return FakeSessions.prototype.turn.call(s.sessions, id, prompt, ctx);
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  const run = await s.store.load("CYC-1");
  if (run === undefined) throw new Error("no run");
  await s.store.save({ ...run, phase: "research" });
  s.sessions.turn = FakeSessions.prototype.turn.bind(s.sessions);
  s.sessions.script.research.push(done(reply()));
  s.sessions.script.research_qa.push(done(PASS));
  expect((await s.restart().step()).status).toBe("researched");
  const last = s.sessions.prompts.filter((p) => p.role === "research").at(-1);
  expect(last?.prompt).toContain("The loop was restarted. Carry on with CYC-1.");
});

test("a restart between making the report and attaching it attaches it once and makes no second one", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const linkDocument = s.tracker.linkDocument.bind(s.tracker);
  s.tracker.linkDocument = async () => {
    throw new Error("killed");
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  s.tracker.linkDocument = linkDocument;
  expect((await s.restart().step()).status).toBe("researched");
  expect(s.tracker.written).toHaveLength(1);
  expect(s.tracker.docLinks).toEqual(["CYC-1:1000"]);
});

test("a restart after the closing comment, before Done, does not comment again", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  const move = s.tracker.move.bind(s.tracker);
  s.tracker.move = async (i, stage) => {
    if (stage === "done") throw new Error("killed");
    return move(i, stage);
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  expect(s.tracker.comments).toHaveLength(1);
  s.tracker.move = move;
  expect((await s.restart().step()).status).toBe("researched");
  expect(s.tracker.comments).toHaveLength(1);
  expect(s.tracker.moves.at(-1)).toBe("CYC-1:done");
  expect(s.tracker.issues).toHaveLength(3);
  expect((await s.store.load("CYC-1"))?.phase).toBe("done");
});

test("a block whose reason quotes a credential from QA names its kind only", async () => {
  const token = `ghp_${"b2".repeat(18)}`;
  const leakyFail = `${CHECKED}<verdict>{"pass":false,"findings":[{"severity":"major","where":"问题 1","problem":"the report quotes ${token}","fix":"drop it"}]}</verdict>`;
  const s = setup(
    { research: [done(reply())], research_qa: [done(leakyFail)] },
    { maxFixRounds: 0 },
  );
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.comments).toHaveLength(1);
  expect(s.tracker.comments[0]).toContain("github-token");
  expect(s.tracker.comments[0]).not.toContain(token);
  if (result.status === "blocked") expect(result.reason).not.toContain(token);
  // The research session still gets the findings in full when it is put back.
  expect((await s.store.load("CYC-1"))?.findings).toContain(token);
});

// ---- cleanup ----

const removals = (s: ReturnType<typeof setup>) =>
  s.world.calls.filter((c) => c.includes("worktree remove") || c.includes("branch -D"));

test("a Done research run loses its worktree and local branches, with no pull request read", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  expect((await s.pipeline.step()).status).toBe("researched");
  expect(removals(s)).toEqual([]);
  expect((await s.pipeline.step()).status).toBe("idle");
  expect(removals(s)).toEqual([
    `git worktree remove ${WT}`,
    "git branch -D worktree-auto/cyc-1",
    "git branch -D auto/cyc-1",
  ]);
  expect(s.world.calls.some((c) => c.startsWith("gh "))).toBe(false);
  expect((await s.store.load("CYC-1"))?.cleanedAt).not.toBeNull();
  expect(await kinds(s.store)).toContain("cleaned");
});

test("a Done research run with uncommitted changes in its worktree is left for a person", async () => {
  const s = setup({ research: [done(reply())], research_qa: [done(PASS)] });
  expect((await s.pipeline.step()).status).toBe("researched");
  s.world.dirty = true;
  await s.pipeline.step();
  await s.pipeline.step();
  expect(removals(s)).toEqual([]);
  expect((await kinds(s.store)).filter((k) => k === "cleanup_skipped_dirty")).toHaveLength(1);
  expect((await s.store.load("CYC-1"))?.cleanedAt).toBeNull();
});

test("a research run not in Done is not cleaned", async () => {
  const s = setup({ research: [done("nothing"), done("nothing")] }, { maxFixRounds: 1 });
  expect((await s.pipeline.step()).status).toBe("blocked");
  await s.pipeline.step();
  expect(removals(s)).toEqual([]);
});

// ---- the rest ----

test("dry run says it would take a research work item, with its questions, and writes nothing", async () => {
  const s = setup({}, { dryRun: true });
  expect(await s.pipeline.step()).toEqual({
    status: "would-take",
    key: "CYC-1",
    kind: "research",
    questions: 2,
  });
  expect(s.tracker.moves).toEqual([]);
  expect(s.sessions.created).toEqual([]);
  expect(await s.store.events()).toEqual([]);
});

test("with research turned off, a research run under way waits and its work item is not taken again", async () => {
  const s = setup({ research: [done(reply())], research_qa: [] });
  s.sessions.turn = async (id, prompt, ctx) => {
    if (ctx.role === "research_qa") throw new Error("killed");
    return FakeSessions.prototype.turn.call(s.sessions, id, prompt, ctx);
  };
  await expect(s.pipeline.step()).rejects.toThrow("killed");
  const off = s.restart({ config: researchConfig({ research: null }) });
  expect((await off.step()).status).toBe("idle");
  expect((await s.store.load("CYC-1"))?.phase).toBe("research_qa");
});

test("a run.json from before research runs reads as a dev run", async () => {
  const store = new RunStore(dir, () => new Date("2026-11-25T00:00:00Z"));
  const old = {
    key: "CYC-9",
    issueId: 9,
    issueNumber: 9,
    title: "t",
    phase: "ci",
    round: 0,
    worktree: "/wt",
    localBranch: "b",
    remoteBranch: "auto/cyc-9",
    devSessionId: "d",
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    prUrl: null,
    findings: null,
    startedAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  };
  await mkdir(join(dir, "runs", "CYC-9"), { recursive: true });
  await writeFile(join(dir, "runs", "CYC-9", "run.json"), JSON.stringify(old));
  const loaded = await store.load("CYC-9");
  expect(loaded?.kind).toBe("dev");
  expect(loaded?.research).toBeNull();
  // A dev run's stats are unchanged by the new field: the claimed event of a dev run carries no runKind.
  expect(await store.unfinished()).toHaveLength(1);
});
