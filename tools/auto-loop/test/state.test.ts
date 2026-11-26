import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatFindings,
  listsWhatWasChecked,
  parseProgress,
  parseReviewVerdict,
  parseVerdict,
  qaBrief,
  reviewBrief,
} from "../src/prompts.ts";
import { computeStats } from "../src/stats.ts";
import { acquireLock, type LoopEvent, RunStore } from "../src/store.ts";
import { issue } from "./helpers.ts";

const now = () => new Date("2026-11-25T00:00:00Z");

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

test("store: events and progress append; unfinished lists runs not done", async () => {
  const store = new RunStore(await mkdtemp(join(tmpdir(), "al-")), now);
  await store.event("CYC-1", "claimed", { n: 1 });
  expect((await store.events()).map((e) => e.kind)).toEqual(["claimed"]);
  await store.appendProgress("CYC-1", 0, "did x");
  expect(await store.readProgress("CYC-1")).toContain("did x");
  expect(await store.unfinished()).toEqual([]);
});

test("store: a run.json from before the conflict fields still loads, with conflictRound 0 and conflict null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "al-"));
  const store = new RunStore(dir, now);
  const saved = await store.save({
    key: "CYC-1",
    issueId: 1,
    issueNumber: 1,
    title: "t",
    phase: "ci",
    round: 0,
    ciRound: 0,
    ciFailedSha: null,
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
    startedAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  });
  const { conflictRound: _a, conflict: _b, ...old } = saved;
  await writeFile(join(dir, "runs", "CYC-1", "run.json"), JSON.stringify(old));
  const loaded = await store.load("CYC-1");
  expect(loaded?.conflictRound).toBe(0);
  expect(loaded?.conflict).toBeNull();
});

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
