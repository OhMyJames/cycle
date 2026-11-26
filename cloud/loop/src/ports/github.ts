// The forge over `gh` (CYC-477). Every command carries `deliverEnv`: only the allowlisted GitHub credentials. The
// readers below were `pr.ts`'s functions; they are internal now, and the loop reaches them through `Forge`.
import { z } from "zod";
import { deliverEnv } from "../env.ts";
import type { Exec } from "../types.ts";
import {
  type At,
  type CiCheckItem,
  type CiCheckStatus,
  type CiStatus,
  DEFAULT_CI_CHECKS,
  type Failed,
  type Forge,
  type ReadAutoMergeResult,
  type ReadCiStatusResult,
  type ReadPrMergeStatusResult,
  type ReadPrStateResult,
} from "./forge.ts";

const RollupEntrySchema = z.object({
  __typename: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  context: z.string().optional(),
  state: z.string().optional(),
  targetUrl: z.string().nullable().optional(),
});

const PrChecksViewSchema = z.object({
  headRefOid: z.string().nullable().optional(),
  statusCheckRollup: z.array(RollupEntrySchema).nullable().optional(),
});

type RollupEntry = z.infer<typeof RollupEntrySchema>;

const classifyEntry = (name: string, entry: RollupEntry): CiCheckItem => {
  const detailsUrl = entry.detailsUrl ?? entry.targetUrl ?? null;
  const isStatusContext =
    entry.__typename === "StatusContext" ||
    (entry.state !== undefined && entry.status === undefined);
  if (isStatusContext) {
    const state = (entry.state ?? "").toUpperCase();
    if (state === "SUCCESS") return { name, status: "passed", rawState: state, detailsUrl };
    if (state === "PENDING" || state === "EXPECTED" || state === "")
      return { name, status: "pending", rawState: state || "PENDING", detailsUrl };
    return { name, status: "failed", rawState: state, detailsUrl };
  }
  const status = (entry.status ?? "").toUpperCase();
  const conclusion = (entry.conclusion ?? "").toUpperCase();
  if (status !== "COMPLETED") {
    return { name, status: "pending", rawState: status || "PENDING", detailsUrl };
  }
  if (conclusion === "SUCCESS") {
    return { name, status: "passed", rawState: "SUCCESS", detailsUrl };
  }
  return { name, status: "failed", rawState: conclusion || "UNKNOWN", detailsUrl };
};

const isNewerEntry = (candidate: RollupEntry, current: RollupEntry): boolean => {
  const cStart = candidate.startedAt ?? "";
  const curStart = current.startedAt ?? "";
  if (cStart !== "" && curStart !== "") {
    if (cStart !== curStart) return cStart > curStart;
    const cEnd = candidate.completedAt ?? "";
    const curEnd = current.completedAt ?? "";
    if (cEnd !== curEnd) return cEnd > curEnd;
    return true;
  }
  if (cStart === "" && curStart !== "") {
    // A queued re-run has no startedAt yet and is newer than an already-completed older attempt.
    return (candidate.status ?? "").toUpperCase() !== "COMPLETED";
  }
  if (cStart !== "" && curStart === "") {
    return (current.status ?? "").toUpperCase() === "COMPLETED";
  }
  return true;
};

/** Evaluates `gh pr view --json headRefOid,statusCheckRollup` output against the required CI checks. */
export const evaluateCiStatus = (
  view: z.infer<typeof PrChecksViewSchema>,
  requiredChecks: readonly string[] = DEFAULT_CI_CHECKS,
  expectedHeadSha?: string,
): CiStatus => {
  const headSha = view.headRefOid ?? null;
  if (expectedHeadSha !== undefined && expectedHeadSha !== "" && headSha !== expectedHeadSha) {
    const checks: CiCheckItem[] = requiredChecks.map((name) => ({
      name,
      status: "pending",
      rawState: "STALE_HEAD",
      detailsUrl: null,
    }));
    return { state: "pending", headSha, checks, failed: [], pending: checks };
  }

  const latestByName = new Map<string, RollupEntry>();
  for (const entry of view.statusCheckRollup ?? []) {
    const name = entry.name ?? entry.context;
    if (name === undefined || name === "") continue;
    const existing = latestByName.get(name);
    if (existing === undefined || isNewerEntry(entry, existing)) {
      latestByName.set(name, entry);
    }
  }

  const checks: CiCheckItem[] = requiredChecks.map((name) => {
    const entry = latestByName.get(name);
    if (entry === undefined) {
      return { name, status: "pending", rawState: "MISSING", detailsUrl: null };
    }
    return classifyEntry(name, entry);
  });

  const pending = checks.filter((c) => c.status === "pending");
  const failed = checks.filter((c) => c.status === "failed");
  const state: CiCheckStatus =
    pending.length > 0 ? "pending" : failed.length > 0 ? "failed" : "passed";
  return { state, headSha, checks, failed, pending };
};

/** Extracts numeric GitHub Actions workflow run and job ids from a check run's detailsUrl. */
export const parseActionsUrl = (url: string | null): { runId?: string; jobId?: string } => {
  if (url === null) return {};
  const match = url.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  if (match === null) return {};
  const [, runId, jobId] = match;
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(jobId !== undefined ? { jobId } : {}),
  };
};

/**
 * Reads CI status for a pull request using `gh pr view` with `deliverEnv` (only allowlisted GitHub/git credentials).
 */
const readCiStatus = async (input: {
  prRef: string;
  requiredChecks?: readonly string[] | undefined;
  expectedHeadSha?: string | undefined;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<ReadCiStatusResult> => {
  const done = await input.exec(
    ["gh", "pr", "view", input.prRef, "--json", "headRefOid,statusCheckRollup"],
    {
      cwd: input.cwd,
      env: deliverEnv(input.env),
      timeoutMs: input.timeoutMs,
    },
  );
  if (done.timedOut) return { ok: false, error: "gh pr view 超时。" };
  if (done.code !== 0) {
    return { ok: false, error: `gh pr view 失败（exit ${done.code}）：${done.output.trim()}` };
  }
  let parsed: z.infer<typeof PrChecksViewSchema>;
  try {
    parsed = PrChecksViewSchema.parse(JSON.parse(done.output));
  } catch (error) {
    return {
      ok: false,
      error: `gh pr view 返回无法解析的 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    status: evaluateCiStatus(
      parsed,
      input.requiredChecks ?? DEFAULT_CI_CHECKS,
      input.expectedHeadSha,
    ),
  };
};

const PrStateViewSchema = z.object({ state: z.enum(["OPEN", "CLOSED", "MERGED"]) });

/**
 * Reads whether a pull request is open, closed without merging, or merged, via `gh pr view --json state` using
 * `deliverEnv`. A failed or unreadable read is an error, never taken as OPEN.
 */
const readPrState = async (input: {
  prRef: string;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<ReadPrStateResult> => {
  const done = await input.exec(["gh", "pr", "view", input.prRef, "--json", "state"], {
    cwd: input.cwd,
    env: deliverEnv(input.env),
    timeoutMs: input.timeoutMs,
  });
  if (done.timedOut) return { ok: false, error: "gh pr view 超时。" };
  if (done.code !== 0) {
    return { ok: false, error: `gh pr view 失败（exit ${done.code}）：${done.output.trim()}` };
  }
  try {
    return { ok: true, state: PrStateViewSchema.parse(JSON.parse(done.output)).state };
  } catch (error) {
    return {
      ok: false,
      error: `gh pr view 返回无法解析的 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const PrMergeViewSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
});

/**
 * Reads whether a pull request has merged, can merge, conflicts with its base, or is not yet known (GitHub computes
 * mergeability lazily), via `gh pr view --json state,mergeable` using `deliverEnv`. A failed or unreadable read is an
 * error, never taken as mergeable.
 */
const readPrMergeStatus = async (input: {
  prRef: string;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<ReadPrMergeStatusResult> => {
  const done = await input.exec(["gh", "pr", "view", input.prRef, "--json", "state,mergeable"], {
    cwd: input.cwd,
    env: deliverEnv(input.env),
    timeoutMs: input.timeoutMs,
  });
  if (done.timedOut) return { ok: false, error: "gh pr view 超时。" };
  if (done.code !== 0) {
    return { ok: false, error: `gh pr view 失败（exit ${done.code}）：${done.output.trim()}` };
  }
  try {
    const view = PrMergeViewSchema.parse(JSON.parse(done.output));
    if (view.state === "MERGED") return { ok: true, status: "merged" };
    if (view.state === "CLOSED") return { ok: true, status: "closed" };
    const status = {
      MERGEABLE: "mergeable",
      CONFLICTING: "conflicting",
      UNKNOWN: "unknown",
    } as const;
    return { ok: true, status: status[view.mergeable] };
  } catch (error) {
    return {
      ok: false,
      error: `gh pr view 返回无法解析的 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const MAX_CI_LOG_PER_CHECK = 4000;

const tailLog = (text: string, max = MAX_CI_LOG_PER_CHECK): string => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…\n${trimmed.slice(trimmed.length - max).trim()}`;
};

/**
 * Fetches failed step logs for each red CI check via `gh run view --log-failed` using `deliverEnv`.
 */
const readCiFailureLogs = async (input: {
  failed: readonly CiCheckItem[];
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxLogChars?: number | undefined;
}): Promise<string> => {
  const env = deliverEnv(input.env);
  const maxChars = input.maxLogChars ?? MAX_CI_LOG_PER_CHECK;
  const sections: string[] = [];

  for (const check of input.failed) {
    const { runId, jobId } = parseActionsUrl(check.detailsUrl);
    let logText = "";
    let note = "";

    if (jobId !== undefined) {
      const done = await input.exec(["gh", "run", "view", "--job", jobId, "--log-failed"], {
        cwd: input.cwd,
        env,
        timeoutMs: input.timeoutMs,
      });
      if (!done.timedOut && done.code === 0 && done.output.trim() !== "") {
        logText = done.output;
      } else if (runId !== undefined) {
        const fallback = await input.exec(["gh", "run", "view", runId, "--log-failed"], {
          cwd: input.cwd,
          env,
          timeoutMs: input.timeoutMs,
        });
        if (!fallback.timedOut && fallback.code === 0 && fallback.output.trim() !== "") {
          logText = fallback.output;
        } else {
          const detail = (fallback.output || done.output).trim();
          note = `（获取失败日志失败：${detail !== "" ? detail : `exit ${fallback.code}`}）`;
        }
      } else {
        const detail = done.output.trim();
        note = `（获取失败日志失败：${detail !== "" ? detail : `exit ${done.code}`}）`;
      }
    } else if (runId !== undefined) {
      const done = await input.exec(["gh", "run", "view", runId, "--log-failed"], {
        cwd: input.cwd,
        env,
        timeoutMs: input.timeoutMs,
      });
      if (!done.timedOut && done.code === 0 && done.output.trim() !== "") {
        logText = done.output;
      } else {
        const detail = done.output.trim();
        note = `（获取失败日志失败：${detail !== "" ? detail : `exit ${done.code}`}）`;
      }
    } else {
      note = "（无 GitHub Actions job/run 链接，无法拉取日志）";
    }

    const urlLine = check.detailsUrl !== null ? `\nURL: ${check.detailsUrl}` : "";
    const header = `### CI check \`${check.name}\` failed (${check.rawState})${urlLine}`;
    const body = logText !== "" ? `\`\`\`\n${tailLog(logText, maxChars)}\n\`\`\`` : note;
    sections.push(`${header}\n${body}`);
  }

  return sections.join("\n\n");
};

/**
 * Reruns the failed jobs of the workflow runs behind red checks (`gh run rerun <id> --failed`) using `deliverEnv`.
 * Refused once `ciRound` is past `maxCiRetries`, so reruns never outlive the retry budget.
 */
const rerunFailedCi = async (input: {
  failed: readonly CiCheckItem[];
  ciRound: number;
  maxCiRetries: number;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<{ ok: true; runIds: string[] } | { ok: false; error: string }> => {
  if (input.ciRound > input.maxCiRetries) {
    return { ok: false, error: `已达重试上限（${input.maxCiRetries}），不再重新运行 CI。` };
  }
  const runIds = [
    ...new Set(
      input.failed.flatMap((c) => {
        const { runId } = parseActionsUrl(c.detailsUrl);
        return runId === undefined ? [] : [runId];
      }),
    ),
  ];
  if (runIds.length === 0) {
    return { ok: false, error: "失败项没有 GitHub Actions 运行链接，无法重新运行。" };
  }
  const env = deliverEnv(input.env);
  for (const runId of runIds) {
    const done = await input.exec(["gh", "run", "rerun", runId, "--failed"], {
      cwd: input.cwd,
      env,
      timeoutMs: input.timeoutMs,
    });
    if (done.timedOut) return { ok: false, error: `gh run rerun ${runId} 超时。` };
    if (done.code !== 0) {
      return {
        ok: false,
        error: `gh run rerun ${runId} 失败（exit ${done.code}）：${done.output.trim()}`,
      };
    }
  }
  return { ok: true, runIds };
};

/** Posts a comment on a pull request via `gh pr comment --body-file` using `deliverEnv`. */
const postPrComment = async (input: {
  prRef: string;
  bodyPath: string;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> => {
  const done = await input.exec(
    ["gh", "pr", "comment", input.prRef, "--body-file", input.bodyPath],
    {
      cwd: input.cwd,
      env: deliverEnv(input.env),
      timeoutMs: input.timeoutMs,
    },
  );
  if (done.timedOut) return { ok: false, error: "gh pr comment 超时。" };
  if (done.code !== 0) {
    return {
      ok: false,
      error: `gh pr comment 失败（exit ${done.code}）：${done.output.trim()}`,
    };
  }
  return { ok: true };
};

/** Enables GitHub auto-merge (squash) on a pull request via `gh pr merge --auto --squash` using `deliverEnv`. */
const enableAutoMerge = async (input: {
  prRef: string;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> => {
  const done = await input.exec(["gh", "pr", "merge", input.prRef, "--auto", "--squash"], {
    cwd: input.cwd,
    env: deliverEnv(input.env),
    timeoutMs: input.timeoutMs,
  });
  if (done.timedOut) return { ok: false, error: "gh pr merge --auto --squash 超时。" };
  if (done.code !== 0) {
    return {
      ok: false,
      error: `gh pr merge --auto --squash 失败（exit ${done.code}）：${done.output.trim()}`,
    };
  }
  return { ok: true };
};

const AutoMergeViewSchema = z.object({ autoMergeRequest: z.unknown().nullable() });

/**
 * Reads whether auto-merge is on for a pull request (`gh pr view --json autoMergeRequest`) using `deliverEnv`. A failed
 * or unreadable read is an error, never taken as off.
 */
const readAutoMerge = async (input: {
  prRef: string;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<ReadAutoMergeResult> => {
  const done = await input.exec(["gh", "pr", "view", input.prRef, "--json", "autoMergeRequest"], {
    cwd: input.cwd,
    env: deliverEnv(input.env),
    timeoutMs: input.timeoutMs,
  });
  if (done.timedOut) return { ok: false, error: "gh pr view 超时。" };
  if (done.code !== 0) {
    return { ok: false, error: `gh pr view 失败（exit ${done.code}）：${done.output.trim()}` };
  }
  try {
    const view = AutoMergeViewSchema.parse(JSON.parse(done.output));
    return { ok: true, enabled: view.autoMergeRequest != null };
  } catch (error) {
    return {
      ok: false,
      error: `gh pr view 返回无法解析的 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/** Turns auto-merge off (`gh pr merge <pr> --disable-auto`) using `deliverEnv`. */
const disableAutoMerge = async (input: {
  prRef: string;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> => {
  const done = await input.exec(["gh", "pr", "merge", input.prRef, "--disable-auto"], {
    cwd: input.cwd,
    env: deliverEnv(input.env),
    timeoutMs: input.timeoutMs,
  });
  if (done.timedOut) return { ok: false, error: "gh pr merge --disable-auto 超时。" };
  if (done.code !== 0) {
    return {
      ok: false,
      error: `gh pr merge --disable-auto 失败（exit ${done.code}）：${done.output.trim()}`,
    };
  }
  return { ok: true };
};

const timedOutOrFailed = (
  command: string,
  done: { code: number; output: string; timedOut: boolean },
): Failed => ({
  ok: false,
  error: done.timedOut
    ? `${command} 超时。`
    : `${command} 失败（exit ${done.code}）：${done.output.trim()}`,
});

/** The command's own output, so a network error in it is told as before; a timeout is named. */
const rawFailed = (command: string, done: { output: string; timedOut: boolean }): Failed => ({
  ok: false,
  error: done.timedOut ? `${command} 超时。` : done.output,
});

const findUrl = (text: string): string | undefined =>
  text
    .split("\n")
    .reverse()
    .find((line) => /^https:\/\/\S+$/.test(line.trim()))
    ?.trim();

/** The forge over `gh`: the same commands the loop ran itself before, with `deliverEnv`. */
export const githubForge = (deps: {
  exec: Exec;
  env: Record<string, string | undefined>;
}): Forge => {
  const { exec, env } = deps;
  const run = (at: At, argv: string[]) =>
    exec(argv, { cwd: at.cwd, env: deliverEnv(env), timeoutMs: at.timeoutMs });
  const base = (at: At) => ({ cwd: at.cwd, env, timeoutMs: at.timeoutMs });
  return {
    async prFor(at, branch) {
      const done = await run(at, ["gh", "pr", "view", branch, "--json", "url", "--jq", ".url"]);
      const url = findUrl(done.output);
      if (done.timedOut || done.code !== 0 || url === undefined) {
        return rawFailed("gh pr view", done);
      }
      return { ok: true, url };
    },
    async createPr(at, input) {
      const done = await run(at, [
        "gh",
        "pr",
        "create",
        "--base",
        input.base,
        "--head",
        input.head,
        "--title",
        input.title,
        "--body-file",
        input.bodyPath,
      ]);
      const url = findUrl(done.output);
      if (done.timedOut || done.code !== 0 || url === undefined) {
        return rawFailed("gh pr create", done);
      }
      return { ok: true, url };
    },
    async editPr(at, pr, input) {
      const done = await run(at, [
        "gh",
        "pr",
        "edit",
        pr,
        "--title",
        input.title,
        "--body-file",
        input.bodyPath,
      ]);
      return done.timedOut || done.code !== 0 ? rawFailed("gh pr edit", done) : { ok: true };
    },
    prState: (at, pr) => readPrState({ prRef: pr, exec, ...base(at) }),
    prMergeStatus: (at, pr) => readPrMergeStatus({ prRef: pr, exec, ...base(at) }),
    ciStatus: (at, pr, headSha, required) =>
      readCiStatus({
        prRef: pr,
        requiredChecks: required,
        expectedHeadSha: headSha,
        exec,
        ...base(at),
      }),
    failedLogs: (at, failed, maxLogChars) =>
      readCiFailureLogs({ failed, exec, maxLogChars, ...base(at) }),
    rerunFailed: (at, failed, budget) => rerunFailedCi({ failed, ...budget, exec, ...base(at) }),
    comment: (at, pr, bodyPath) => postPrComment({ prRef: pr, bodyPath, exec, ...base(at) }),
    autoMerge: (at, pr, on) =>
      on
        ? enableAutoMerge({ prRef: pr, exec, ...base(at) })
        : disableAutoMerge({ prRef: pr, exec, ...base(at) }),
    autoMergeOn: (at, pr) => readAutoMerge({ prRef: pr, exec, ...base(at) }),
    async changedPaths(at, pr) {
      const done = await run(at, ["gh", "pr", "diff", pr, "--name-only"]);
      if (done.timedOut || done.code !== 0) return timedOutOrFailed("gh pr diff", done);
      return {
        ok: true,
        paths: done.output
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== ""),
      };
    },
  };
};
