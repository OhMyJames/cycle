import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { type DepsInput, Pipeline } from "../src/pipeline.ts";
import type { CiStatus, OpenPr } from "../src/ports/forge.ts";
import { config, FakeSessions, FakeTracker, REVIEW_MERGE } from "./helpers.ts";

const REJECT = `What I checked:\n- a.ts\n<review>{"decision":"reject","summary":"bug","reasons":["x"],"findings":[]}</review>`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const pr = (over: Partial<OpenPr> = {}): OpenPr => ({
  number: 7,
  headBranch: "feature",
  headSha: SHA_A,
  baseBranch: "main",
  isDraft: false,
  crossRepository: false,
  author: "alice",
  title: "T",
  body: "B",
  ...over,
});

const setup = async (
  opts: {
    prs?: OpenPr[];
    enabled?: boolean;
    max?: number;
    review?: ReturnType<typeof import("./helpers.ts").done>[];
    paths?: string[];
    commentFails?: boolean;
  } = {},
) => {
  const dir = await mkdtemp(join(tmpdir(), "al-pr-"));
  let now = new Date("2026-11-28T00:00:00Z");
  const clock = { now: () => now };
  const store = SqliteStore.open(dir, () => now);
  const state = {
    prs: opts.prs ?? [pr()],
    ci: "passed" as CiStatus["state"],
    permission: "write",
    paths: opts.paths ?? ["src/a.ts"],
    prState: "OPEN" as "OPEN" | "MERGED",
  };
  const calls: string[] = [];
  const comments: string[] = [];
  const headOf = (n: number) => state.prs.find((p) => p.number === n)?.headSha ?? SHA_A;
  const forge = {
    openPrs: async () => {
      calls.push("openPrs");
      return { ok: true, prs: state.prs };
    },
    prHead: async (_a: unknown, ref: string) => ({
      ok: true,
      sha: headOf(Number(ref)),
      state: state.prState,
      isDraft: false,
      baseBranch: "main",
    }),
    authorPermission: async () => {
      calls.push("permission");
      return { ok: true, permission: state.permission };
    },
    ciStatus: async (_a: unknown, ref: string) => ({
      ok: true,
      status: {
        state: state.ci,
        headSha: headOf(Number(ref)),
        checks: [],
        failed: [],
        pending: [],
      },
    }),
    changedPaths: async () => ({ ok: true, paths: state.paths }),
    mergeAt: async (_a: unknown, ref: string, sha: string) => {
      calls.push(`merge ${ref} ${sha}`);
      return { ok: true };
    },
    comment: async (_a: unknown, _ref: string, path: string) => {
      if (opts.commentFails) return { ok: false, error: "boom" };
      comments.push(await readFile(path, "utf8"));
      return { ok: true };
    },
    autoMerge: async () => {
      calls.push("autoMerge");
      return { ok: true };
    },
  };
  let fetchedBranch = "";
  const workspace = {
    diff: async () => "diff --git a/a b/a",
    snapshot: async () => "snap",
    fetchMain: async () => ({ code: 0, output: "", timedOut: false }),
    fetchPrBranch: async (_a: unknown, branch: string) => {
      fetchedBranch = branch;
      return { code: 0, output: "", timedOut: false };
    },
    // The worktree holds the commit of the branch that was fetched last.
    head: async () => ({
      ok: true,
      sha: state.prs.find((p) => p.headBranch === fetchedBranch)?.headSha ?? SHA_A,
    }),
  };
  const sessions = new FakeSessions({
    dev: [],
    qa: [],
    ...(opts.review ? { review: opts.review } : {}),
  });
  const cfg = config({
    stateDir: dir,
    repoRoot: dir,
    repoSlug: "o/r",
    prReview: opts.enabled === false ? null : { maxReviewsPerPr: opts.max ?? 5 },
  });
  const pipeline = new Pipeline({
    config: cfg,
    tracker: new FakeTracker([]),
    sessions,
    exec: async () => ({ code: 0, output: "", timedOut: false }),
    forge,
    workspace,
    store,
    clock,
    log: () => {},
    env: {},
    sleep: async () => {},
  } as unknown as DepsInput);
  return {
    pipeline,
    store,
    state,
    calls,
    comments,
    sessions,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
};

test("with the switch off no pull request is read", async () => {
  const t = await setup({ enabled: false });
  expect((await t.pipeline.step()).status).toBe("idle");
  expect(t.calls).toEqual([]);
});

test("forks, drafts, the loop's own branches and authors without write access are skipped without a comment", async () => {
  const t = await setup({
    prs: [
      pr({ number: 1, crossRepository: true }),
      pr({ number: 2, isDraft: true }),
      pr({ number: 3, headBranch: "auto/cyc-9" }),
      pr({ number: 4 }),
    ],
  });
  t.state.permission = "read";
  const first = await t.pipeline.step();
  expect(first).toEqual({ status: "pr_step", key: "pr:o/r#4", outcome: "no-write-access" });
  expect((await t.pipeline.step()).status).toBe("idle");
  expect(t.comments).toEqual([]);
  expect(t.sessions.created).toEqual([]);
});

test("a commit with green CI is reviewed once and merged pinned to that commit, without auto-merge", async () => {
  const t = await setup({
    review: [{ text: REVIEW_MERGE, stopReason: "end_turn", timedOut: false }],
  });
  const r = await t.pipeline.step();
  expect(r).toEqual({ status: "pr_step", key: "pr:o/r#7", outcome: "merged" });
  expect(t.calls).toContain(`merge 7 ${SHA_A}`);
  expect(t.calls).not.toContain("autoMerge");
  expect(t.comments.length).toBe(1);
  expect(t.sessions.created.length).toBe(1);
  // the same commit is not taken again, and not reviewed again
  expect((await t.pipeline.step()).status).toBe("idle");
  expect(t.sessions.created.length).toBe(1);
  expect(t.store.prReview("o/r", 7).reviews).toBe(1);
});

test("a reject conclusion only comments", async () => {
  const t = await setup({ review: [{ text: REJECT, stopReason: "end_turn", timedOut: false }] });
  const r = await t.pipeline.step();
  expect(r).toEqual({ status: "pr_step", key: "pr:o/r#7", outcome: "reject" });
  expect(t.comments.length).toBe(1);
  expect(t.calls.some((c) => c.startsWith("merge"))).toBe(false);
});

test("a pull request into another base branch is not looked at", async () => {
  const t = await setup({ prs: [pr({ baseBranch: "release" })] });
  expect((await t.pipeline.step()).status).not.toBe("pr_step");
  expect(t.sessions.created).toEqual([]);
});

test("a review whose comment did not get onto the pull request is not merged", async () => {
  const t = await setup({
    review: [{ text: REVIEW_MERGE, stopReason: "end_turn", timedOut: false }],
    commentFails: true,
  });
  const r = await t.pipeline.step();
  expect(r).toMatchObject({ status: "pr_step", outcome: "comment-failed" });
  expect(t.calls.some((c) => c.startsWith("merge"))).toBe(false);
});

test("a merge conclusion on a change to the path floor is refused with a comment", async () => {
  const t = await setup({
    review: [{ text: REVIEW_MERGE, stopReason: "end_turn", timedOut: false }],
    paths: ["cloud/loop/src/guard/floor.ts"],
  });
  const r = await t.pipeline.step();
  expect(r).toEqual({ status: "pr_step", key: "pr:o/r#7", outcome: "merge-refused" });
  expect(t.calls.some((c) => c.startsWith("merge"))).toBe(false);
  expect(t.comments.length).toBe(2);
});

test("CI still running registers a wait and ends the step; a signal or the recheck time wakes it", async () => {
  const t = await setup({ review: [{ text: REJECT, stopReason: "end_turn", timedOut: false }] });
  t.state.ci = "pending";
  const r = await t.pipeline.step();
  expect(r).toEqual({ status: "pr_step", key: "pr:o/r#7", outcome: "waiting-ci" });
  expect(t.store.waits("pr:o/r#7").map((w) => w.subject)).toEqual([`ci:o/r@${SHA_A}`]);
  expect(t.sessions.created).toEqual([]);
  // the supervisor does not call a registered wait stuck: the heartbeat has no deadline
  const beat = t.store.heartbeats().find((b) => b.runKey === "pr:o/r#7");
  expect(JSON.parse(beat?.detail ?? "{}")).toMatchObject({ waitingOn: "ci", deadline: null });
  // nothing new before the recheck time or a signal
  expect((await t.pipeline.step()).status).toBe("idle");
  // CI finishes: the poll writes the signal and the wait is woken
  t.state.ci = "passed";
  t.advance(31_000);
  const r2 = await t.pipeline.step();
  expect(r2).toEqual({ status: "pr_step", key: "pr:o/r#7", outcome: "reject" });
  expect(t.store.waits("pr:o/r#7")).toEqual([]);
});

test("a new commit is a new review; the old conclusion does not merge it", async () => {
  const t = await setup({
    review: [
      { text: REJECT, stopReason: "end_turn", timedOut: false },
      { text: REVIEW_MERGE, stopReason: "end_turn", timedOut: false },
    ],
  });
  await t.pipeline.step();
  t.state.prs = [pr({ headSha: SHA_B })];
  t.advance(31_000);
  const r = await t.pipeline.step();
  expect(r).toEqual({ status: "pr_step", key: "pr:o/r#7", outcome: "merged" });
  expect(t.calls).toContain(`merge 7 ${SHA_B}`);
  expect(t.sessions.created.length).toBe(2);
});

test("at the review cap one comment says so and the loop stops reviewing", async () => {
  const t = await setup({
    max: 1,
    review: [{ text: REJECT, stopReason: "end_turn", timedOut: false }],
  });
  await t.pipeline.step();
  t.state.prs = [pr({ headSha: SHA_B })];
  t.advance(31_000);
  expect(await t.pipeline.step()).toEqual({
    status: "pr_step",
    key: "pr:o/r#7",
    outcome: "capped",
  });
  const n = t.comments.length;
  t.state.prs = [pr({ headSha: "c".repeat(40) })];
  t.advance(31_000);
  await t.pipeline.step();
  expect(t.comments.length).toBe(n);
  expect(t.sessions.created.length).toBe(1);
});
