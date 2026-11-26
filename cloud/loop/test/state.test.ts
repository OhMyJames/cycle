import { expect, test } from "bun:test";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { SqliteStore } from "../src/db/store.ts";
import {
  formatFindings,
  listsWhatWasChecked,
  parseProgress,
  parseReviewVerdict,
  parseVerdict,
  qaBrief,
  researchBrief,
  researchContinueBrief,
  researchFixBrief,
  researchQaBrief,
  reviewBrief,
} from "../src/prompts/index.ts";
import { computeStats } from "../src/stats.ts";
import {
  acquireLock,
  type LoopEvent,
  type LoopStore,
  type PlanRoundInput,
  planRoundId,
  RunStore,
} from "../src/store.ts";
import { issue } from "./helpers.ts";

const now = () => new Date("2026-11-25T00:00:00Z");

// The store tests run on both ways of keeping the state (CYC-475): the files and `loop.db`.
const KINDS = ["files", "sqlite"] as const;
const make = (kind: (typeof KINDS)[number], dir: string): LoopStore =>
  kind === "sqlite" ? SqliteStore.open(dir, now) : new RunStore(dir, now);

test("progress: the last block wins", () => {
  expect(parseProgress("a <progress>one</progress> b <progress>two</progress>")).toBe("two");
  expect(parseProgress("none")).toBeUndefined();
});

test("verdict: a pass with a non-minor finding is not a pass; junk is unreadable", () => {
  const finding = (severity: string) =>
    `<verdict>{"pass":true,"findings":[{"severity":"${severity}","where":"a","problem":"p","fix":"f"}]}</verdict>`;
  expect(parseVerdict(finding("major"))?.pass).toBe(false);
  expect(parseVerdict(finding("minor"))?.pass).toBe(true);
  expect(parseVerdict("<verdict>{nope</verdict>")).toBeUndefined();
  const major = parseVerdict(finding("major"));
  expect(major === undefined ? "" : formatFindings(major)).toContain("[major] a: p");
});

for (const kind of KINDS) {
  test(`${kind} store: events and progress append; unfinished lists runs not done`, async () => {
    const store = make(kind, await mkdtemp(join(tmpdir(), "al-")));
    await store.event("CYC-1", "claimed", { n: 1 });
    expect((await store.events()).map((e) => e.kind)).toEqual(["claimed"]);
    await store.appendProgress("CYC-1", 0, "did x");
    expect(await store.readProgress("CYC-1")).toContain("did x");
    expect(await store.unfinished()).toEqual([]);
  });

  test(`${kind} store: a run.json from before the conflict fields still loads, with conflictRound 0 and conflict null`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "al-"));
    const store = make(kind, dir);
    const saved = await store.save({
      key: "CYC-1",
      issueId: 1,
      issueNumber: 1,
      title: "t",
      phase: "ci",
      round: 0,
      ciRound: 0,
      ciFailedSha: null,
      nodeModulesReleased: false,
      fullFlowDocs: [],
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      worktree: "/wt",
      localBranch: "b",
      remoteBranch: "auto/cyc-1",
      devSessionId: "d",
      qaSessionId: null,
      reviewSessionId: null,
      replacedSessions: [],
      blockedReason: null,
      resumeFrom: null,
      prUrl: null,
      findings: null,
      cleanedAt: null,
      cleanupNote: null,
      kind: "dev",
      research: null,
      startedAt: "2026-11-25T00:00:00.000Z",
      updatedAt: "2026-11-25T00:00:00.000Z",
    });
    const { conflictRound: _a, conflict: _b, ...old } = saved;
    if (kind === "files") {
      await writeFile(join(dir, "runs", "CYC-1", "run.json"), JSON.stringify(old));
    } else {
      // The same record as an older loop wrote it: the fields it did not know are not in `state`.
      const db = openDb(dir);
      const {
        key: _k,
        kind: _kind,
        phase: _p,
        round: _r,
        issueId: _i,
        issueNumber: _n,
        title: _t,
        worktree: _w,
        blockedReason: _b,
        resumeFrom: _f,
        prUrl: _u,
        startedAt: _s,
        updatedAt: _a2,
        ...state
      } = old;
      db.run("UPDATE runs SET state = ? WHERE key = 'CYC-1'", [JSON.stringify(state)]);
      db.close();
    }
    const loaded = await store.load("CYC-1");
    expect(loaded?.conflictRound).toBe(0);
    expect(loaded?.conflict).toBeNull();
  });

  // The planning node's rounds (CYC-322) live in `plans/`, apart from the work item runs.
  const round = (startedAt: Date, over: Partial<PlanRoundInput> = {}): PlanRoundInput => ({
    id: planRoundId(startedAt),
    startedAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
    phase: "shaping",
    worktree: "/repo/.agents/worktree/plan-x",
    triageSessionId: "triage-1",
    candidates: ["CYC-5", "CYC-6"],
    triage: {
      categories: { "CYC-5": "shape", "CYC-6": "unfit" },
      priorities: { "CYC-5": "high" },
      order: ["CYC-5"],
    },
    queue: [
      {
        key: "CYC-5",
        issueId: 505,
        number: 5,
        hash: "abc",
        state: "writing",
        round: 1,
        shapeSessionId: "shape-2",
        qaSessionId: "shape_qa-3",
        stoppedReason: null,
        originalCommented: true,
        rewritten: false,
        created: [7, 8],
        pendingCreate: { index: 2, title: "third" },
        linked: false,
        notesCommented: false,
        labelled: false,
      },
    ],
    ...over,
  });

  test(`${kind} store: a planning round round-trips under plans/<id>/ with its bodies directory, apart from the runs`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "al-"));
    const store = make(kind, dir);
    const startedAt = new Date("2026-11-26T15:30:00.123Z");
    expect(planRoundId(startedAt)).toBe("2026-11-26T15-30-00-123Z");
    const saved = await store.savePlan(round(startedAt));
    expect(saved.updatedAt).toBe(now().toISOString());
    expect(await store.loadPlan(saved.id)).toEqual(saved);
    const bodies = store.planBodiesDir(saved.id);
    expect(bodies).toBe(join(dir, "plans", "2026-11-26T15-30-00-123Z", "bodies"));
    expect((await stat(bodies)).isDirectory()).toBe(true);
    expect((await readdir(join(dir, "plans", saved.id))).sort()).toEqual(
      kind === "files" ? ["bodies", "run.json"] : ["bodies"],
    );
    // The dev and research runs do not see it, and events still go to the one log.
    expect(await store.all()).toEqual([]);
    expect(await store.unfinished()).toEqual([]);
    await store.event(`plan-${saved.id}`, "plan_started");
    expect((await store.events()).map((e) => e.run)).toEqual([`plan-${saved.id}`]);
    expect(await store.loadPlan("2026-01-01T00-00-00-000Z")).toBeUndefined();
  });

  test(`${kind} store: unfinished rounds are the ones not finished or abandoned, oldest first; a bad id is refused`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "al-"));
    const store = make(kind, dir);
    expect(await store.unfinishedPlans()).toEqual([]);
    await store.savePlan(round(new Date("2026-11-26T12:00:00Z"), { phase: "triage" }));
    await store.savePlan(round(new Date("2026-11-26T10:00:00Z")));
    await store.savePlan(round(new Date("2026-11-26T09:00:00Z"), { phase: "finished" }));
    await store.savePlan(round(new Date("2026-11-26T08:00:00Z"), { phase: "abandoned" }));
    // memory.json beside the rounds is not one.
    await store.savePlanMemory({});
    expect((await store.unfinishedPlans()).map((r) => [r.id, r.phase])).toEqual([
      ["2026-11-26T10-00-00-000Z", "shaping"],
      ["2026-11-26T12-00-00-000Z", "triage"],
    ]);
    expect(() => store.planBodiesDir("../runs")).toThrow("not a planning round id");
    await expect(store.loadPlan("../../etc")).rejects.toThrow("not a planning round id");
    await expect(
      store.savePlan({ ...round(new Date("2026-11-26T12:00:00Z")), id: "../x" }),
    ).rejects.toThrow("not a planning round id");
  });

  test(`${kind} store: the planning memory is empty at first and round-trips`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "al-"));
    const store = make(kind, dir);
    expect(await store.loadPlanMemory()).toEqual({});
    const memory = {
      "CYC-5": {
        category: "unfit",
        bodyHash: "abc",
        lastCommentAt: "2026-11-25T01:00:00.000Z",
        stopped: false,
      },
      "CYC-6": { category: null, bodyHash: "def", lastCommentAt: null, stopped: true },
    };
    await store.savePlanMemory(memory);
    expect(await store.loadPlanMemory()).toEqual(memory);
    if (kind === "files") expect(await readdir(join(dir, "plans"))).toEqual(["memory.json"]);
    expect(await store.unfinishedPlans()).toEqual([]);
  });
}

test("lock: a live holder refuses, a dead one is taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "al-"));
  const release = await acquireLock(dir, () => true, 111);
  await expect(acquireLock(dir, () => true, 222)).rejects.toThrow("another loop");
  await release();
  await writeFile(join(dir, "loop.lock"), "999");
  await (await acquireLock(dir, () => false, 222))();
});

test("stats: rates from the event log", () => {
  const e = (
    run: string,
    kind: string,
    extra: Record<string, string | boolean> = {},
  ): LoopEvent => ({
    ts: "t",
    run,
    kind,
    ...extra,
  });
  const stats = computeStats([
    e("A", "claimed"),
    e("A", "verify"),
    e("A", "delivered", { prUrl: "u", autoMerge: true }),
    e("B", "claimed"),
    e("B", "verify"),
    e("B", "round_failed"),
    e("B", "blocked"),
  ]);
  expect(stats.runs).toBe(2);
  expect(stats.delivered).toBe(1);
  expect(stats.autonomousCompletionRate).toBe(0.5);
  expect(stats.interventionRate).toBe(0.5);
  expect(stats.reworkRate).toBe(0.5);
  expect(stats.autoMerged).toBe(1);
});

test("stats: delivered without auto-merge is not autonomous", () => {
  const e = (
    run: string,
    kind: string,
    extra: Record<string, string | boolean> = {},
  ): LoopEvent => ({
    ts: "t",
    run,
    kind,
    ...extra,
  });
  const stats = computeStats([
    e("A", "claimed"),
    e("A", "verify"),
    e("A", "review_decided", { decision: "escalate" }),
    e("A", "delivered", { prUrl: "u", autoMerge: false }),
  ]);
  expect(stats.delivered).toBe(1);
  expect(stats.autoMerged).toBe(0);
  expect(stats.autonomousCompletionRate).toBe(0);
});

test("the QA brief asks for the code-review skill, read-only", () => {
  const brief = qaBrief(issue(), [], "diff", "checks");
  expect(brief).toContain('skill "code-review"');
  expect(brief).toContain("never pass --fix or --comment");
});

test("the QA brief points at the files Dev resolved a merge conflict in", () => {
  const plain = qaBrief(issue(), [], "diff", "checks");
  expect(plain).not.toContain("merge conflict");
  const brief = qaBrief(issue(), [], "diff", "checks", ["src/a.ts", "src/b.ts"]);
  expect(brief).toContain("merge conflict");
  expect(brief).toContain("- src/a.ts");
  expect(brief).toContain("- src/b.ts");
});

const researchIssue = issue({
  key: "CYC-445",
  title: "Measure worktrees",
  description: "## 要回答的问题\n1. a?",
});

test("the research brief is read-only, names its bounds and limits, and the blocks the loop reads", () => {
  const brief = researchBrief(researchIssue, ["a?", "b?"], {
    readRoots: ["/repo", "/data/runs"],
    maxFollowups: 4,
    maxCriteria: 6,
  });
  expect(brief).toContain("CYC-445: Measure worktrees");
  expect(brief).toContain("READ-ONLY");
  expect(brief).toContain("do not use MCP tools");
  expect(brief).toContain("- /repo\n- /data/runs");
  expect(brief).toContain("1. a?\n2. b?");
  expect(brief).toContain("## 要回答的问题\n1. a?");
  expect(brief).toContain("「未验证」");
  expect(brief).toContain("never as `NAME=value`");
  expect(brief).toContain("「背景与证据」, 「范围」, 「非目标」, 「涉及面」 and 「验收标准」");
  expect(brief).toContain(
    "「现象」, 「复现步骤」, 「预期与实际」, 「环境与版本」, 「严重度」 and 「验收标准」",
  );
  expect(brief).toContain("at most 6 items");
  expect(brief).toContain("bun run check, bun run test:browser");
  expect(brief).toContain("zero to 4 <followup> blocks");
  expect(brief).toContain("at most 600 characters");
  expect(brief).toMatch(
    /<summary>[\s\S]*<report>[\s\S]*「## 问题 N」[\s\S]*<followup type="Feature"/,
  );
});

test("the research fix and continue briefs ask for the complete blocks again", () => {
  const fix = researchFixBrief(2, "- The summary is 700 characters long", 5);
  expect(fix).toContain("fix round 2");
  expect(fix).toContain("The summary is 700 characters long");
  expect(fix).toContain("complete blocks again");
  expect(fix).toContain("zero to 5 <followup> blocks");
  const byPerson = researchContinueBrief(researchIssue, true, 5);
  expect(byPerson).toContain("A person looked at CYC-445");
  expect(byPerson).toContain("## 要回答的问题\n1. a?");
  expect(researchContinueBrief(researchIssue, false, 5)).toContain("The loop was restarted");
});

test("the research QA brief carries the report and drafts, the four checks, and the verdict block", () => {
  const brief = researchQaBrief(
    researchIssue,
    ["a?"],
    {
      summary: "能删一半。",
      report: "## 问题 1\n答。",
      followups: [{ type: "Feature", title: "Delete stale worktrees", body: "## 背景与证据\nx" }],
    },
    ["/repo", "/data/runs"],
  );
  expect(brief).toContain("independent reviewer of the research for work item CYC-445");
  expect(brief).toContain("READ-ONLY");
  // QA must know where it may check the evidence: it is often outside its own worktree.
  expect(brief).toContain("- /repo\n- /data/runs");
  expect(brief).toContain("能删一半。");
  expect(brief).toContain("## 问题 1\n答。");
  expect(brief).toContain("Follow-up 1: Feature — Delete stale worktrees");
  expect(brief).toContain("「未验证」");
  expect(brief).toContain("「方法与范围」");
  expect(brief).toContain("at least three pieces of evidence");
  expect(brief).toContain('"What I checked"');
  expect(brief).toContain("<verdict>");
  expect(brief).not.toContain("code-review");
});

test("the PR review brief is read-only, references REVIEW.md, and requires one of three structured conclusions", () => {
  const brief = reviewBrief(issue(), "https://github.com/o/r/pull/9", [], "diff", [
    "check",
    "browser",
    "integration",
  ]);
  // Read-only instructions
  expect(brief).toContain("READ-ONLY");
  expect(brief).toContain("Do not edit, create, delete, commit, push, merge, or comment");
  // References REVIEW.md
  expect(brief).toContain("REVIEW.md");
  // Requires one of the three structured conclusions: merge, reject, or escalate
  expect(brief).toContain("<review>");
  expect(brief).toContain("</review>");
  expect(brief).toContain('"decision"');
  expect(brief).toContain('"merge"');
  expect(brief).toContain('"reject"');
  expect(brief).toContain('"escalate"');
  expect(brief).toContain('"summary"');
  expect(brief).toContain('"reasons"');
  expect(brief).toContain('"findings"');
  expect(brief).toContain("leaving no conclusion is not allowed");
  expect(brief).toContain("What I checked");

  // Retry note is included when retrying after a failed review attempt.
  const retryBrief = reviewBrief(
    issue(),
    "https://github.com/o/r/pull/9",
    [],
    "diff",
    ["check"],
    "Previous review attempt #1 failed",
  );
  expect(retryBrief).toContain("Previous review attempt #1 failed");

  // Paired parsers handle <review> structured verdicts and checklist validation.
  const valid =
    'What I checked:\n- read REVIEW.md\n<review>{"decision":"merge","summary":"ok","reasons":["checked"]}</review>';
  expect(parseReviewVerdict(valid)?.decision).toBe("merge");
  expect(listsWhatWasChecked(valid)).toBe(true);
  expect(
    listsWhatWasChecked('<review>{"decision":"merge","summary":"ok","reasons":[]}</review>'),
  ).toBe(false);
});

test("stats: permissions ranked by what people allowed, at most 10, empty without events", () => {
  expect(computeStats([]).permissions).toEqual([]);
  const e = (kind: string, extra: Record<string, string>): LoopEvent => ({
    ts: "t",
    run: "A",
    kind,
    tool: "execute",
    ...extra,
  });
  const events: LoopEvent[] = [
    e("permission_requested", { command: "git mv", decision: "ask" }),
    e("permission_answered", { command: "git mv", answer: "allow" }),
    e("permission_requested", { command: "bunx biome", decision: "ask" }),
    e("permission_requested", { command: "bunx biome", decision: "ask" }),
    e("permission_answered", { command: "bunx biome", answer: "allow" }),
    e("permission_answered", { command: "bunx biome", answer: "allow" }),
    e("permission_requested", { command: "rm", decision: "ask" }),
    e("permission_answered", { command: "rm", answer: "deny" }),
    { ts: "t", run: "A", kind: "permission_requested", tool: "edit", decision: "ask" },
  ];
  for (let i = 0; i < 12; i++)
    events.push(e("permission_requested", { command: `tool${i}`, decision: "ask" }));
  const rows = computeStats(events).permissions;
  expect(rows).toHaveLength(10);
  expect(rows[0]).toEqual({
    kind: "execute",
    command: "bunx biome",
    requested: 2,
    allowed: 2,
    denied: 0,
  });
  expect(rows[1]).toEqual({
    kind: "execute",
    command: "git mv",
    requested: 1,
    allowed: 1,
    denied: 0,
  });
  expect(rows.find((r) => r.command === "rm")).toEqual({
    kind: "execute",
    command: "rm",
    requested: 1,
    allowed: 0,
    denied: 1,
  });
});

test("stats: events of two runs written interleaved give the same result as in run order", () => {
  const e = (
    run: string,
    kind: string,
    extra: Record<string, string | boolean> = {},
  ): LoopEvent => ({ ts: "t", run, kind, ...extra });
  const a = [
    e("A", "claimed"),
    e("A", "verify"),
    e("A", "delivered", { prUrl: "u", autoMerge: true }),
  ];
  const b = [e("B", "claimed"), e("B", "verify"), e("B", "round_failed"), e("B", "blocked")];
  const inOrder = computeStats([...a, ...b]);
  const mixed = computeStats([b[0], a[0], a[1], b[1], b[2], a[2], b[3]] as LoopEvent[]);
  expect(mixed).toEqual(inOrder);
});

test("stats: first pass rate, rework by stage and duration percentiles", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 25, 0, min)).toISOString();
  const ev: LoopEvent[] = [];
  const add = (run: string, min: number, kind: string, extra: Record<string, boolean> = {}) =>
    ev.push({ ts: at(min), run, kind, ...extra });
  // A: clean. B: auto rework then merged. C: human help then merged. D: not auto-merged. E: undelivered.
  add("A", 0, "claimed");
  add("A", 10, "delivered", { autoMerge: true });
  add("B", 0, "claimed");
  add("B", 1, "verify");
  add("B", 2, "round_failed");
  add("B", 3, "qa_turn");
  add("B", 4, "round_failed");
  add("B", 5, "ci_failed");
  add("B", 6, "round_failed");
  add("B", 20, "delivered", { autoMerge: true });
  add("C", 0, "claimed");
  add("C", 1, "blocked");
  add("C", 2, "review_decided");
  add("C", 3, "round_failed");
  add("C", 4, "resumed");
  add("C", 5, "round_failed");
  add("C", 30, "delivered", { autoMerge: true });
  add("D", 0, "claimed");
  add("D", 40, "delivered", { autoMerge: false });
  add("E", 0, "claimed");
  add("E", 1, "verify");
  add("E", 2, "round_failed");
  const s = computeStats(ev);
  expect(s.firstPassRate).toBe(1 / 5);
  expect(s.reworkByStage).toEqual({
    verify: { events: 2, runs: 2 },
    qa: { events: 1, runs: 1 },
    ci: { events: 1, runs: 1 },
    review: { events: 1, runs: 1 },
    other: { events: 1, runs: 1 },
  });
  const min = 60_000;
  expect(s.durationMs).toEqual({ median: 20 * min, p90: 40 * min });
  expect(computeStats([]).durationMs).toEqual({ median: null, p90: null });
  expect(computeStats([]).firstPassRate).toBe(0);
});

test("stats: research runs are counted apart and change none of the dev metrics", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 25, 0, min)).toISOString();
  const add = (
    list: LoopEvent[],
    run: string,
    min: number,
    kind: string,
    extra: Record<string, string | number | boolean> = {},
  ) => list.push({ ts: at(min), run, kind, ...extra });
  // Dev runs, as written before research runs: no runKind.
  const dev: LoopEvent[] = [];
  add(dev, "A", 0, "claimed", { criteria: 2 });
  add(dev, "A", 1, "verify");
  add(dev, "A", 10, "delivered", { prUrl: "u", autoMerge: true });
  add(dev, "B", 0, "claimed", { criteria: 1 });
  add(dev, "B", 1, "verify");
  add(dev, "B", 2, "round_failed");
  add(dev, "B", 3, "blocked");
  // R: published after a QA rejection and a block. S: still under way.
  const research: LoopEvent[] = [];
  add(research, "R", 0, "claimed", { runKind: "research", questions: 2 });
  add(research, "R", 1, "qa_turn");
  add(research, "R", 2, "round_failed");
  add(research, "R", 3, "blocked");
  add(research, "R", 4, "resumed");
  add(research, "R", 50, "researched", { docId: 1000, followups: 2 });
  add(research, "S", 0, "claimed", { runKind: "research", questions: 1 });
  add(research, "S", 1, "permission_requested", { tool: "read", decision: "deny" });

  const alone = computeStats(dev);
  const mixed = computeStats([...research, ...dev]);
  expect(alone.researched).toBe(0);
  expect(mixed.researched).toBe(1);
  const { researched: _a, permissions: _b, ...devMixed } = mixed;
  const { researched: _c, permissions: _d, ...devAlone } = alone;
  expect(devMixed).toEqual(devAlone);
  expect(mixed.runs).toBe(2);
  expect(mixed.reworkRate).toBe(0.5);
  expect(mixed.interventionRate).toBe(0.5);
  // The permission table is over every session, research ones included.
  expect(mixed.permissions).toEqual([{ kind: "read", requested: 1, allowed: 0, denied: 0 }]);
});
