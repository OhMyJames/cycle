import { z } from "zod";
import type { Criterion } from "./criteria.ts";
import { deliverEnv } from "./env.ts";
import type { Clock, Exec, Issue } from "./types.ts";

const firstLine = (text: string | null): string =>
  (text ?? "").split("\n").find((line) => line.trim() !== "" && !line.startsWith("$")) ?? "";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const MAX_PR_TITLE_LENGTH = 256;

/** Whether `text` contains the exact closing keyword `Closes <key>` (not a prefix of a larger number). */
export const hasClosingKeyword = (text: string, key: string): boolean =>
  new RegExp(`(?:^|\\W)Closes ${escapeRegExp(key)}(?=$|\\W)`).test(text);

/**
 * The pull request's title. Always carries `Closes <key>` within GitHub's 256-character cap so the tracker's GitHub
 * integration moves the work item to Done when the pull request is merged.
 */
export const renderPrTitle = (issue: Pick<Issue, "key" | "title">): string => {
  const prefix = `${issue.key} `;
  const suffix = ` (Closes ${issue.key})`;
  const cleanTitle = issue.title.replace(/\s+/g, " ").trim();
  const budget = MAX_PR_TITLE_LENGTH - prefix.length - suffix.length;
  const text =
    budget <= 0
      ? ""
      : cleanTitle.length <= budget
        ? cleanTitle
        : `${cleanTitle.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
  return text === "" ? `${issue.key}${suffix}` : `${prefix}${text}${suffix}`;
};

/**
 * Checks that the title (within 256 chars) and the first line of the body carry `Closes <key>` before opening a PR.
 */
export const validatePr = (
  key: string,
  title: string,
  body: string,
): { ok: true } | { ok: false; reason: string } => {
  if (title.length > MAX_PR_TITLE_LENGTH)
    return { ok: false, reason: `PR 标题超过 ${MAX_PR_TITLE_LENGTH} 字符上限。` };
  if (!hasClosingKeyword(title, key))
    return { ok: false, reason: `PR 标题缺少关闭关键词「Closes ${key}」。` };
  const firstBodyLine = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!hasClosingKeyword(firstBodyLine, key))
    return { ok: false, reason: `PR 正文首行缺少关闭关键词「Closes ${key}」。` };
  return { ok: true };
};

/**
 * The pull request's text. Leads with `Closes <key>` so merging closes the work item in the tracker, followed by what
 * the change is for and whether each criterion held, so a person reads the intent and the evidence, not the diff first.
 */
export const renderPr = (input: {
  issue: Issue;
  criteria: Criterion[];
  checks: { command: string; passed: boolean }[];
  rounds: number;
  summary: string;
  sessions: { dev: string | null; qa: string | null };
}): string => {
  const rows = input.criteria
    .map(
      (c) =>
        `| ${c.id} | ${c.text.replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${c.verify.map((argv) => `\`${argv.join(" ")}\``).join("<br>")} | ${c.status === "passed" ? "✅ 通过" : "❌ 未通过"} | ${firstLine(c.evidence).replace(/\|/g, "\\|").slice(0, 80)} |`,
    )
    .join("\n");
  const checks = input.checks.map((c) => `- ${c.passed ? "✅" : "❌"} \`${c.command}\``).join("\n");
  return `Closes ${input.issue.key}

## 目的

${input.issue.key} ${input.issue.title}

## 这次改了什么

${input.summary.trim() === "" ? "（Dev 没有给出摘要）" : input.summary.trim()}

## 验收标准逐条核对

每一条都由自动化执行验证命令得出，不是会话自述。

| # | 标准 | 验证 | 结果 | 输出 |
|---|---|---|---|---|
${rows}

## 测试

${checks}

独立 QA 审查通过；修复轮数：${input.rounds}。

## 会话

- Dev：\`${input.sessions.dev ?? "-"}\`
- QA：\`${input.sessions.qa ?? "-"}\`

由 tools/auto-loop 自动生成（${input.issue.key}）。
`;
};

export const DEFAULT_CI_CHECKS = ["check", "browser", "integration"] as const;

export type CiCheckStatus = "passed" | "failed" | "pending";

export type CiCheckItem = {
  name: string;
  status: CiCheckStatus;
  /** Raw state/conclusion from GitHub (e.g. "SUCCESS", "FAILURE", "IN_PROGRESS", "MISSING"). */
  rawState: string;
  detailsUrl: string | null;
};

export type CiStatus = {
  state: CiCheckStatus;
  headSha: string | null;
  checks: CiCheckItem[];
  failed: CiCheckItem[];
  pending: CiCheckItem[];
};

export type ReadCiStatusResult = { ok: true; status: CiStatus } | { ok: false; error: string };

export type WaitForCiResult =
  | { outcome: "passed"; status: CiStatus }
  | { outcome: "failed"; status: CiStatus; logs: string }
  | { outcome: "timeout"; status: CiStatus | null }
  | { outcome: "error"; error: string };

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
export const readCiStatus = async (input: {
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

const MAX_CI_LOG_PER_CHECK = 4000;

const tailLog = (text: string, max = MAX_CI_LOG_PER_CHECK): string => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…\n${trimmed.slice(trimmed.length - max).trim()}`;
};

/**
 * Fetches failed step logs for each red CI check via `gh run view --log-failed` using `deliverEnv`.
 */
export const readCiFailureLogs = async (input: {
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
 * Polls CI status until all required checks pass, any finishes red (and returns its failure logs), or timeout/error.
 */
export const waitForCi = async (input: {
  prRef: string;
  requiredChecks?: readonly string[] | undefined;
  expectedHeadSha?: string | undefined;
  exec: Exec;
  cwd: string;
  env: Record<string, string | undefined>;
  commandTimeoutMs: number;
  pollIntervalMs: number;
  timeoutMs: number;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
}): Promise<WaitForCiResult> => {
  const startedAt = input.clock.now().getTime();
  const maxPolls =
    input.pollIntervalMs > 0
      ? Math.max(1, Math.ceil(input.timeoutMs / input.pollIntervalMs) + 1)
      : 100;
  let lastStatus: CiStatus | null = null;

  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const read = await readCiStatus({
      prRef: input.prRef,
      requiredChecks: input.requiredChecks,
      expectedHeadSha: input.expectedHeadSha,
      exec: input.exec,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.commandTimeoutMs,
    });
    if (!read.ok) return { outcome: "error", error: read.error };
    lastStatus = read.status;
    if (read.status.state === "passed") return { outcome: "passed", status: read.status };
    if (read.status.state === "failed") {
      const logs = await readCiFailureLogs({
        failed: read.status.failed,
        exec: input.exec,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.commandTimeoutMs,
      });
      return { outcome: "failed", status: read.status, logs };
    }
    const elapsed = input.clock.now().getTime() - startedAt;
    if (elapsed >= input.timeoutMs || attempt + 1 >= maxPolls) {
      return { outcome: "timeout", status: lastStatus };
    }
    const remaining = Math.max(0, input.timeoutMs - elapsed);
    await input.sleep(Math.min(input.pollIntervalMs, remaining));
  }

  return { outcome: "timeout", status: lastStatus };
};
