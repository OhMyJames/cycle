import { expect, test } from "bun:test";
import type { Criterion } from "../src/criteria.ts";
import {
  DEFAULT_CI_CHECKS,
  disableAutoMerge,
  enableAutoMerge,
  hasClosingKeyword,
  MAX_PR_TITLE_LENGTH,
  parseActionsUrl,
  postPrComment,
  readAutoMerge,
  readCiFailureLogs,
  readCiStatus,
  readPrMergeStatus,
  readPrState,
  renderPr,
  renderPrTitle,
  rerunFailedCi,
  validatePr,
  waitForCi,
} from "../src/pr.ts";
import type { Exec, ExecResult } from "../src/types.ts";
import { issue } from "./helpers.ts";

const sampleIssue = issue({
  number: 330,
  key: "CYC-330",
  title: "Loop 只选 Feature/Bug 叶子工单，PR 带 Closes CYC-<num>",
});

const sampleCriteria: Criterion[] = [
  {
    id: 1,
    text: "选单只取 Feature/Bug 叶子",
    verify: [["bun", "test", "tools/auto-loop/test/select.test.ts"]],
    status: "passed",
    evidence: "5 pass\n0 fail",
    checkedAt: "2026-11-25T00:00:00.000Z",
  },
];

test("PR title contains the issue key and Closes CYC-<num>, capped at 256 chars", () => {
  const title = renderPrTitle(sampleIssue);
  expect(title).toContain("CYC-330");
  expect(title).toContain("Closes CYC-330");
  expect(hasClosingKeyword(title, "CYC-330")).toBe(true);

  const longTitle = renderPrTitle({ key: "CYC-330", title: "a".repeat(300) });
  expect(longTitle.length).toBeLessThanOrEqual(MAX_PR_TITLE_LENGTH);
  expect(longTitle.startsWith("CYC-330 ")).toBe(true);
  expect(longTitle.endsWith(" (Closes CYC-330)")).toBe(true);
  expect(hasClosingKeyword(longTitle, "CYC-330")).toBe(true);

  const emptyTitle = renderPrTitle({ key: "CYC-330", title: "   " });
  expect(emptyTitle).toBe("CYC-330 (Closes CYC-330)");
});

test("PR body leads with Closes CYC-<num> and includes criteria, checks, and sessions", () => {
  const body = renderPr({
    issue: sampleIssue,
    criteria: sampleCriteria,
    checks: [{ command: "bun run check", passed: true }],
    rounds: 0,
    summary: "- feat(auto-loop): filter leaf issues",
    sessions: { dev: "dev-1", qa: "qa-2" },
  });
  const firstLine = body.split("\n")[0];
  expect(firstLine).toBe("Closes CYC-330");
  expect(hasClosingKeyword(body, "CYC-330")).toBe(true);
  expect(body).toContain("CYC-330");
  expect(body).toContain("选单只取 Feature/Bug 叶子");
  expect(body).toContain("`bun run check`");
  expect(body).toContain("`dev-1`");
  expect(body).toContain("`qa-2`");
});

test("validatePr accepts rendered PR title and body, and rejects missing or mismatched Closes keyword", () => {
  const title = renderPrTitle(sampleIssue);
  const body = renderPr({
    issue: sampleIssue,
    criteria: sampleCriteria,
    checks: [{ command: "bun run check", passed: true }],
    rounds: 0,
    summary: "- change",
    sessions: { dev: "dev-1", qa: "qa-2" },
  });
  expect(validatePr("CYC-330", title, body)).toEqual({ ok: true });

  expect(validatePr("CYC-330", "CYC-330 title without keyword", body).ok).toBe(false);
  expect(validatePr("CYC-330", `${"x".repeat(250)} (Closes CYC-330)`, body).ok).toBe(false);
  expect(validatePr("CYC-330", title, "## 目的\n\nCYC-330 title").ok).toBe(false);
  // Keyword appearing only later in the body (e.g. inside issue title or criteria) does not satisfy the first-line rule.
  expect(validatePr("CYC-330", title, "## 目的\n\nCloses CYC-330").ok).toBe(false);
  // Prefix collision must not match (CYC-33 must not match CYC-330).
  expect(validatePr("CYC-33", title, body).ok).toBe(false);
  expect(validatePr("CYC-331", title, body).ok).toBe(false);
});

const fullEnv = {
  PATH: "/bin",
  HOME: "/home/u",
  GH_TOKEN: "gh-secret",
  SSH_AUTH_SOCK: "/tmp/ssh.sock",
  AUTO_LOOP_PLAN_KEY: "plan-secret",
  ANTHROPIC_API_KEY: "model-secret",
};

const checkRun = (
  name: string,
  status: string,
  conclusion: string | null,
  extra: Record<string, unknown> = {},
) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/o/r/actions/runs/100/job/${name === "check" ? "1" : name === "browser" ? "2" : "3"}`,
  ...extra,
});

const okExec = (output: string): ExecResult => ({ code: 0, output, timedOut: false });

test("readCiStatus uses gh pr view with deliverEnv and passes when check, browser, and integration are green", async () => {
  const seen: { argv: string[]; env: Record<string, string> }[] = [];
  const exec: Exec = async (argv, opts) => {
    seen.push({ argv, env: opts.env });
    return okExec(
      JSON.stringify({
        headRefOid: "sha-1",
        statusCheckRollup: [
          checkRun("check", "COMPLETED", "SUCCESS"),
          checkRun("browser", "COMPLETED", "SUCCESS"),
          checkRun("integration", "COMPLETED", "SUCCESS"),
          checkRun("unrelated-bot", "COMPLETED", "FAILURE"),
        ],
      }),
    );
  };

  const res = await readCiStatus({
    prRef: "https://github.com/o/r/pull/9",
    expectedHeadSha: "sha-1",
    exec,
    cwd: "/wt",
    env: fullEnv,
    timeoutMs: 5000,
  });

  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.status.state).toBe("passed");
    expect(res.status.checks.map((c) => c.name)).toEqual([...DEFAULT_CI_CHECKS]);
    expect(res.status.failed).toEqual([]);
    expect(res.status.pending).toEqual([]);
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]?.argv).toEqual([
    "gh",
    "pr",
    "view",
    "https://github.com/o/r/pull/9",
    "--json",
    "headRefOid,statusCheckRollup",
  ]);
  expect(seen[0]?.env.GH_TOKEN).toBe("gh-secret");
  expect(seen[0]?.env.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");
  expect(seen[0]?.env.AUTO_LOOP_PLAN_KEY).toBeUndefined();
  expect(seen[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("readCiStatus detects red checks, pending/missing checks, stale headRefOid, duplicate re-runs, and errors", async () => {
  const runWith = (result: ExecResult, expectedHeadSha?: string) =>
    readCiStatus({
      prRef: "auto/cyc-331",
      expectedHeadSha,
      exec: async () => result,
      cwd: "/wt",
      env: fullEnv,
      timeoutMs: 5000,
    });

  // One check red -> failed once all three have completed.
  const red = await runWith(
    okExec(
      JSON.stringify({
        headRefOid: "sha-1",
        statusCheckRollup: [
          checkRun("check", "COMPLETED", "SUCCESS"),
          checkRun("browser", "COMPLETED", "FAILURE"),
          checkRun("integration", "COMPLETED", "SKIPPED"),
        ],
      }),
    ),
    "sha-1",
  );
  expect(red.ok && red.status.state).toBe("failed");
  if (red.ok) {
    expect(red.status.failed.map((c) => c.name)).toEqual(["browser", "integration"]);
  }

  // Pending check keeps aggregate pending even if another check already failed.
  const pending = await runWith(
    okExec(
      JSON.stringify({
        headRefOid: "sha-1",
        statusCheckRollup: [
          checkRun("check", "COMPLETED", "SUCCESS"),
          checkRun("browser", "COMPLETED", "FAILURE"),
          checkRun("integration", "IN_PROGRESS", null),
        ],
      }),
    ),
    "sha-1",
  );
  expect(pending.ok && pending.status.state).toBe("pending");

  // Missing required check -> pending.
  const missing = await runWith(
    okExec(
      JSON.stringify({
        headRefOid: "sha-1",
        statusCheckRollup: [checkRun("check", "COMPLETED", "SUCCESS")],
      }),
    ),
    "sha-1",
  );
  expect(missing.ok && missing.status.state).toBe("pending");
  if (missing.ok) {
    expect(missing.status.pending.map((c) => c.name)).toEqual(["browser", "integration"]);
  }

  // Stale headRefOid from previous commit -> pending, not failed.
  const stale = await runWith(
    okExec(
      JSON.stringify({
        headRefOid: "sha-old",
        statusCheckRollup: [
          checkRun("check", "COMPLETED", "FAILURE"),
          checkRun("browser", "COMPLETED", "FAILURE"),
          checkRun("integration", "COMPLETED", "FAILURE"),
        ],
      }),
    ),
    "sha-new",
  );
  expect(stale.ok && stale.status.state).toBe("pending");

  // Duplicate check runs for the same job -> latest startedAt wins.
  const rerun = await runWith(
    okExec(
      JSON.stringify({
        headRefOid: "sha-1",
        statusCheckRollup: [
          checkRun("check", "COMPLETED", "SUCCESS", { startedAt: "2026-11-25T00:01:00Z" }),
          checkRun("browser", "COMPLETED", "FAILURE", { startedAt: "2026-11-25T00:01:00Z" }),
          checkRun("browser", "COMPLETED", "SUCCESS", { startedAt: "2026-11-25T00:05:00Z" }),
          checkRun("integration", "COMPLETED", "SUCCESS", { startedAt: "2026-11-25T00:01:00Z" }),
        ],
      }),
    ),
    "sha-1",
  );
  expect(rerun.ok && rerun.status.state).toBe("passed");

  // Non-zero exit and malformed JSON return ok: false.
  const failedCmd = await runWith({ code: 1, output: "auth required", timedOut: false });
  expect(failedCmd.ok).toBe(false);
  const badJson = await runWith(okExec("not json"));
  expect(badJson.ok).toBe(false);
});

test("parseActionsUrl and readCiFailureLogs fetch job logs via gh run view with deliverEnv and fallback to runId", async () => {
  expect(parseActionsUrl("https://github.com/o/r/actions/runs/12345/job/67890")).toEqual({
    runId: "12345",
    jobId: "67890",
  });
  expect(parseActionsUrl("https://github.com/o/r/actions/runs/12345")).toEqual({
    runId: "12345",
  });
  expect(parseActionsUrl("https://example.com/status")).toEqual({});

  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, env: opts.env });
    if (argv.includes("111")) return okExec("Error: browser assertion failed\n");
    if (argv.includes("222")) return { code: 1, output: "job log unavailable", timedOut: false };
    if (argv.includes("999")) return okExec("Fallback run log: integration failed\n");
    return okExec("");
  };

  const logs = await readCiFailureLogs({
    failed: [
      {
        name: "browser",
        status: "failed",
        rawState: "FAILURE",
        detailsUrl: "https://github.com/o/r/actions/runs/888/job/111",
      },
      {
        name: "integration",
        status: "failed",
        rawState: "TIMED_OUT",
        detailsUrl: "https://github.com/o/r/actions/runs/999/job/222",
      },
    ],
    exec,
    cwd: "/wt",
    env: fullEnv,
    timeoutMs: 5000,
  });

  expect(logs).toContain("browser");
  expect(logs).toContain("Error: browser assertion failed");
  expect(logs).toContain("integration");
  expect(logs).toContain("Fallback run log: integration failed");
  expect(calls.map((c) => c.argv)).toEqual([
    ["gh", "run", "view", "--job", "111", "--log-failed"],
    ["gh", "run", "view", "--job", "222", "--log-failed"],
    ["gh", "run", "view", "999", "--log-failed"],
  ]);
  for (const call of calls) {
    expect(call.env.GH_TOKEN).toBe("gh-secret");
    expect(call.env.AUTO_LOOP_PLAN_KEY).toBeUndefined();
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  }

  // Truncates long logs to the tail and handles missing Actions URLs.
  const longLogs = await readCiFailureLogs({
    failed: [
      {
        name: "check",
        status: "failed",
        rawState: "FAILURE",
        detailsUrl: "https://github.com/o/r/actions/runs/500/job/501",
      },
      {
        name: "browser",
        status: "failed",
        rawState: "FAILURE",
        detailsUrl: null,
      },
    ],
    exec: async () => okExec(`${"x".repeat(200)}TAIL_MARKER`),
    cwd: "/wt",
    env: fullEnv,
    timeoutMs: 5000,
    maxLogChars: 40,
  });
  expect(longLogs).toContain("TAIL_MARKER");
  expect(longLogs).toContain("…");
  expect(longLogs).toContain("无法拉取日志");
});

test("waitForCi polls until green, returns logs on red, and stops on timeout", async () => {
  // Pending -> passed.
  const views = [
    JSON.stringify({
      headRefOid: "sha-1",
      statusCheckRollup: [
        checkRun("check", "COMPLETED", "SUCCESS"),
        checkRun("browser", "IN_PROGRESS", null),
        checkRun("integration", "QUEUED", null),
      ],
    }),
    JSON.stringify({
      headRefOid: "sha-1",
      statusCheckRollup: [
        checkRun("check", "COMPLETED", "SUCCESS"),
        checkRun("browser", "COMPLETED", "SUCCESS"),
        checkRun("integration", "COMPLETED", "SUCCESS"),
      ],
    }),
  ];
  let sleeps = 0;
  let nowMs = 0;
  const passed = await waitForCi({
    prRef: "https://github.com/o/r/pull/9",
    expectedHeadSha: "sha-1",
    exec: async (argv) =>
      okExec(
        argv.includes("state,mergeable")
          ? JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" })
          : (views.shift() ?? "{}"),
      ),
    cwd: "/wt",
    env: fullEnv,
    commandTimeoutMs: 5000,
    pollIntervalMs: 1000,
    timeoutMs: 5000,
    clock: { now: () => new Date(nowMs) },
    sleep: async (ms) => {
      sleeps++;
      nowMs += ms;
    },
  });
  expect(passed.outcome).toBe("passed");
  expect(sleeps).toBe(1);

  // Timeout when checks stay pending.
  nowMs = 0;
  const timedOut = await waitForCi({
    prRef: "https://github.com/o/r/pull/9",
    expectedHeadSha: "sha-1",
    exec: async () =>
      okExec(
        JSON.stringify({
          headRefOid: "sha-1",
          statusCheckRollup: [checkRun("check", "IN_PROGRESS", null)],
        }),
      ),
    cwd: "/wt",
    env: fullEnv,
    commandTimeoutMs: 5000,
    pollIntervalMs: 1000,
    timeoutMs: 2500,
    clock: { now: () => new Date(nowMs) },
    sleep: async (ms) => {
      nowMs += ms;
    },
  });
  expect(timedOut.outcome).toBe("timeout");
});

test("waitForCi stops at once on a conflicting PR but keeps waiting while mergeability is UNKNOWN", async () => {
  const pending = JSON.stringify({
    headRefOid: "sha-1",
    statusCheckRollup: [checkRun("check", "IN_PROGRESS", null)],
  });
  const run = async (mergeable: string) => {
    let nowMs = 0;
    let sleeps = 0;
    const result = await waitForCi({
      prRef: "https://github.com/o/r/pull/9",
      expectedHeadSha: "sha-1",
      exec: async (argv) =>
        okExec(
          argv.includes("state,mergeable") ? JSON.stringify({ state: "OPEN", mergeable }) : pending,
        ),
      cwd: "/wt",
      env: fullEnv,
      commandTimeoutMs: 5000,
      pollIntervalMs: 1000,
      timeoutMs: 2500,
      clock: { now: () => new Date(nowMs) },
      sleep: async (ms) => {
        sleeps++;
        nowMs += ms;
      },
    });
    return { result, sleeps };
  };
  const conflict = await run("CONFLICTING");
  expect(conflict.result.outcome).toBe("conflict");
  expect(conflict.sleeps).toBe(0);
  const unknown = await run("UNKNOWN");
  expect(unknown.result.outcome).toBe("timeout");
  expect(unknown.sleeps).toBeGreaterThan(0);
});

test("postPrComment and enableAutoMerge invoke gh with deliverEnv and handle failures", async () => {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, env: opts.env });
    return okExec("");
  };

  const commented = await postPrComment({
    prRef: "https://github.com/o/r/pull/9",
    bodyPath: "/state/runs/CYC-332/review-comment.md",
    exec,
    cwd: "/wt",
    env: fullEnv,
    timeoutMs: 5000,
  });
  expect(commented).toEqual({ ok: true });

  const merged = await enableAutoMerge({
    prRef: "https://github.com/o/r/pull/9",
    exec,
    cwd: "/wt",
    env: fullEnv,
    timeoutMs: 5000,
  });
  expect(merged).toEqual({ ok: true });

  expect(calls.map((c) => c.argv)).toEqual([
    [
      "gh",
      "pr",
      "comment",
      "https://github.com/o/r/pull/9",
      "--body-file",
      "/state/runs/CYC-332/review-comment.md",
    ],
    ["gh", "pr", "merge", "https://github.com/o/r/pull/9", "--auto", "--squash"],
  ]);
  for (const call of calls) {
    expect(call.env.GH_TOKEN).toBe("gh-secret");
    expect(call.env.AUTO_LOOP_PLAN_KEY).toBeUndefined();
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  }

  const failedMerge = await enableAutoMerge({
    prRef: "https://github.com/o/r/pull/9",
    exec: async () => ({
      code: 1,
      output: "Pull request Auto merge is not allowed",
      timedOut: false,
    }),
    cwd: "/wt",
    env: fullEnv,
    timeoutMs: 5000,
  });
  expect(failedMerge.ok).toBe(false);
  if (!failedMerge.ok) expect(failedMerge.error).toContain("not allowed");

  const timedOutComment = await postPrComment({
    prRef: "https://github.com/o/r/pull/9",
    bodyPath: "/state/runs/CYC-332/review-comment.md",
    exec: async () => ({ code: 1, output: "", timedOut: true }),
    cwd: "/wt",
    env: fullEnv,
    timeoutMs: 5000,
  });
  expect(timedOutComment.ok).toBe(false);
  if (!timedOutComment.ok) expect(timedOutComment.error).toContain("超时");
});

const stateExec =
  (result: Partial<ExecResult>): Exec =>
  async () => ({
    code: 0,
    output: "",
    timedOut: false,
    ...result,
  });
const readState = (exec: Exec) =>
  readPrState({ prRef: "u", exec, cwd: "/", env: {}, timeoutMs: 1 });

test("readPrState tells OPEN, CLOSED and MERGED apart", async () => {
  for (const state of ["OPEN", "CLOSED", "MERGED"] as const) {
    expect(await readState(stateExec({ output: JSON.stringify({ state }) }))).toEqual({
      ok: true,
      state,
    });
  }
});

test("readPrState returns an error, not OPEN, when the read fails or is unreadable", async () => {
  expect((await readState(stateExec({ code: 1, output: "no" }))).ok).toBe(false);
  expect((await readState(stateExec({ timedOut: true }))).ok).toBe(false);
  expect((await readState(stateExec({ output: "not json" }))).ok).toBe(false);
  expect((await readState(stateExec({ output: '{"state":"DRAFT"}' }))).ok).toBe(false);
});

test("readPrMergeStatus tells merged, mergeable, conflicting, closed and unknown apart", async () => {
  const read = (state: string, mergeable: string) =>
    readPrMergeStatus({
      prRef: "u",
      exec: stateExec({ output: JSON.stringify({ state, mergeable }) }),
      cwd: "/",
      env: {},
      timeoutMs: 1,
    });
  expect(await read("MERGED", "UNKNOWN")).toEqual({ ok: true, status: "merged" });
  expect(await read("OPEN", "MERGEABLE")).toEqual({ ok: true, status: "mergeable" });
  expect(await read("OPEN", "CONFLICTING")).toEqual({ ok: true, status: "conflicting" });
  expect(await read("OPEN", "UNKNOWN")).toEqual({ ok: true, status: "unknown" });
  expect(await read("CLOSED", "CONFLICTING")).toEqual({ ok: true, status: "closed" });
});

test("readPrMergeStatus returns an error, not mergeable, when the read fails or is unreadable", async () => {
  const read = (result: Partial<ExecResult>) =>
    readPrMergeStatus({ prRef: "u", exec: stateExec(result), cwd: "/", env: {}, timeoutMs: 1 });
  expect((await read({ code: 1, output: "no" })).ok).toBe(false);
  expect((await read({ timedOut: true })).ok).toBe(false);
  expect((await read({ output: "not json" })).ok).toBe(false);
  expect((await read({ output: '{"state":"OPEN"}' })).ok).toBe(false);
});

test("rerunFailedCi reruns each failed run once with deliverEnv and respects maxCiRetries", async () => {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, env: opts.env });
    return okExec("");
  };
  const failed = (job: string) => ({
    name: `job${job}`,
    status: "failed" as const,
    rawState: "FAILURE",
    detailsUrl: `https://github.com/o/r/actions/runs/20/job/${job}`,
  });
  const base = {
    failed: [failed("1"), failed("2")],
    maxCiRetries: 2,
    exec,
    cwd: "/wt",
    env: { ...fullEnv, ANTHROPIC_API_KEY: "sk-secret" },
    timeoutMs: 1000,
  };
  const ok = await rerunFailedCi({ ...base, ciRound: 2 });
  expect(ok).toEqual({ ok: true, runIds: ["20"] });
  expect(calls.map((c) => c.argv)).toEqual([["gh", "run", "rerun", "20", "--failed"]]);
  expect(calls[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();

  const over = await rerunFailedCi({ ...base, ciRound: 3 });
  expect(over.ok).toBe(false);
  expect(calls).toHaveLength(1);

  const noRun = await rerunFailedCi({
    ...base,
    failed: [{ ...failed("1"), detailsUrl: null }],
    ciRound: 1,
  });
  expect(noRun.ok).toBe(false);

  const bad = await rerunFailedCi({
    ...base,
    ciRound: 1,
    exec: async () => ({ code: 1, output: "nope", timedOut: false }),
  });
  expect(bad.ok).toBe(false);
});

test("readAutoMerge and disableAutoMerge use gh with deliverEnv; failures and timeouts are errors", async () => {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  const reply: { next: ExecResult } = {
    next: okExec('{"autoMergeRequest":{"mergeMethod":"SQUASH"}}'),
  };
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, env: opts.env });
    return reply.next;
  };
  const input = {
    prRef: "https://github.com/o/r/pull/9",
    exec,
    cwd: "/wt",
    env: fullEnv,
    timeoutMs: 5000,
  };
  expect(await readAutoMerge(input)).toEqual({ ok: true, enabled: true });
  reply.next = okExec('{"autoMergeRequest":null}');
  expect(await readAutoMerge(input)).toEqual({ ok: true, enabled: false });
  reply.next = okExec("not json");
  expect((await readAutoMerge(input)).ok).toBe(false);
  reply.next = { code: 1, output: "nope", timedOut: false };
  expect((await readAutoMerge(input)).ok).toBe(false);
  reply.next = { code: 0, output: "", timedOut: true };
  expect((await readAutoMerge(input)).ok).toBe(false);

  reply.next = okExec("");
  expect(await disableAutoMerge(input)).toEqual({ ok: true });
  reply.next = { code: 1, output: "nope", timedOut: false };
  expect((await disableAutoMerge(input)).ok).toBe(false);
  reply.next = { code: 0, output: "", timedOut: true };
  expect((await disableAutoMerge(input)).ok).toBe(false);

  expect(calls[0]?.argv).toEqual([
    "gh",
    "pr",
    "view",
    "https://github.com/o/r/pull/9",
    "--json",
    "autoMergeRequest",
  ]);
  expect(calls[5]?.argv).toEqual([
    "gh",
    "pr",
    "merge",
    "https://github.com/o/r/pull/9",
    "--disable-auto",
  ]);
  for (const c of calls) {
    expect(c.env.GH_TOKEN).toBeDefined();
    expect(c.env.OPENAI_API_KEY).toBeUndefined();
  }
});
