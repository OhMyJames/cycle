import type { Criterion } from "./criteria.ts";
import type { CiStatus, Forge, ReadCiStatusResult } from "./ports/forge.ts";
import type { ReviewVerdict } from "./prompts.ts";
import type { Clock, Issue } from "./types.ts";

export { DEFAULT_CI_CHECKS } from "./ports/forge.ts";

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
 * The base of a document page's address, `<origin of planUrl>/<team>/<project>/docs`, from the `projectKey` (`infra.CYC`).
 * Null when the key has no team prefix (or the url is unusable): the address cannot be made, so none is made up.
 */
export const docsBaseOf = (planUrl: string, projectKey: string): string | null => {
  const [team, project, ...rest] = projectKey.split(".");
  if (
    team === undefined ||
    team === "" ||
    project === undefined ||
    project === "" ||
    rest.length > 0
  )
    return null;
  try {
    return `${new URL(planUrl).origin}/${encodeURIComponent(team)}/${encodeURIComponent(project)}/docs`;
  } catch {
    return null;
  }
};

/** The 「依据文档」 section of a 大档 pull request: each document's title, linked when the base is known. */
const renderDocuments = (
  documents: { id: number; title: string }[],
  docsBase: string | null,
): string =>
  documents.length === 0
    ? ""
    : `## 依据文档

${documents
  .map((d) => {
    const title = d.title.replace(/\s+/g, " ").trim();
    return docsBase === null
      ? `- ${title}`
      : `- [${title.replace(/([[\]\\])/g, "\\$1")}](${docsBase}/${d.id})`;
  })
  .join("\n")}

`;

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
  /** 大档 (CYC-454): the Intent / Spec / Design / Plan documents; omitted or empty for a small one. */
  documents?: { id: number; title: string }[];
  docsBase?: string | null;
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

${renderDocuments(input.documents ?? [], input.docsBase ?? null)}## 这次改了什么

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

由 cloud/loop 自动生成（${input.issue.key}）。
`;
};

export type WaitForCiResult =
  | { outcome: "passed"; status: CiStatus }
  | { outcome: "failed"; status: CiStatus; logs: string }
  | { outcome: "timeout"; status: CiStatus | null }
  | { outcome: "conflict"; status: CiStatus }
  | { outcome: "error"; error: string };

/**
 * Polls CI status until all required checks pass, any finishes red (and returns its failure logs), or timeout/error.
 */
export const waitForCi = async (input: {
  prRef: string;
  requiredChecks?: readonly string[] | undefined;
  expectedHeadSha?: string | undefined;
  forge: Forge;
  cwd: string;
  commandTimeoutMs: number;
  pollIntervalMs: number;
  timeoutMs: number;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  /** Job links of a red attempt that was just rerun: while only these are red, the new attempt has not shown up yet. */
  staleFailedUrls?: ReadonlySet<string> | undefined;
  /** Wraps each status read, so a caller can retry a failed one without restarting the wait (CYC-444). */
  guardRead?: (read: () => Promise<ReadCiStatusResult>) => Promise<ReadCiStatusResult>;
}): Promise<WaitForCiResult> => {
  const startedAt = input.clock.now().getTime();
  const maxPolls =
    input.pollIntervalMs > 0
      ? Math.max(1, Math.ceil(input.timeoutMs / input.pollIntervalMs) + 1)
      : 100;
  let lastStatus: CiStatus | null = null;

  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const at = { cwd: input.cwd, timeoutMs: input.commandTimeoutMs };
    const poll = () =>
      input.forge.ciStatus(at, input.prRef, input.expectedHeadSha, input.requiredChecks);
    const read = await (input.guardRead ? input.guardRead(poll) : poll());
    if (!read.ok) return { outcome: "error", error: read.error };
    lastStatus = read.status;
    if (read.status.state === "passed") return { outcome: "passed", status: read.status };
    const stale = input.staleFailedUrls;
    const onlyOldAttempt =
      stale !== undefined &&
      read.status.state === "failed" &&
      read.status.failed.every((c) => c.detailsUrl !== null && stale.has(c.detailsUrl));
    if (read.status.state === "failed" && !onlyOldAttempt) {
      const logs = await input.forge.failedLogs(at, read.status.failed);
      return { outcome: "failed", status: read.status, logs };
    }
    // GitHub runs no CI on a PR that conflicts with its base, so pending checks would never finish. UNKNOWN (not yet
    // computed) and unreadable states keep waiting.
    const merge = await input.forge.prMergeStatus(at, input.prRef);
    if (merge.ok && merge.status === "conflicting") {
      return { outcome: "conflict", status: read.status };
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

/**
 * Formats the independent PR review conclusion posted as a GitHub PR comment (CYC-332).
 */
export const renderReviewComment = (input: {
  issueKey: string;
  ciChecks: readonly string[];
  ciGreen: boolean;
  sessionId: string | null;
  verdict?: ReviewVerdict | undefined;
  rejectLimitReached?: boolean | undefined;
  systemError?: { reason: string; attempts: number } | null | undefined;
}): string => {
  const ciLine = input.ciGreen
    ? `CI（${input.ciChecks.join(" / ")}）：✅ 全绿`
    : `CI（${input.ciChecks.join(" / ")}）：❌ 未确认全绿`;
  const sessionLine = `评审会话：\`${input.sessionId ?? "-"}\` · 依据：\`REVIEW.md\` · 工单：${input.issueKey}`;

  if (input.systemError != null) {
    return `## 独立评审结论：⚠️ 评审系统故障（已升级给人，非代码问题）

本次升级是**评审系统故障而非代码问题**。按 \`REVIEW.md\` 重试规则已尝试 ${input.systemError.attempts} 次仍未获得有效结论，未开启自动合并。

- 原因：${input.systemError.reason}
- ${ciLine}
- 后续动作：未开启自动合并，工单移入 In Review 等待人工处理

${sessionLine}
`;
  }

  if (input.verdict?.decision === "merge" && input.ciGreen) {
    const reasons =
      input.verdict.reasons.length > 0
        ? `\n### 评审说明\n\n${input.verdict.reasons.map((r) => `- ${r}`).join("\n")}\n`
        : "";
    return `## 独立评审结论：✅ 合并（merge）

${input.verdict.summary}
${reasons}
- ${ciLine}
- 后续动作：开启 GitHub 自动合并（squash）

${sessionLine}
`;
  }

  if (input.verdict?.decision === "reject") {
    const reasonsSection =
      input.verdict.reasons.length > 0
        ? `\n### 评审意见\n\n${input.verdict.reasons.map((r) => `- ${r}`).join("\n")}\n`
        : "";
    const findingsSection =
      input.verdict.findings.length > 0
        ? `\n### 问题清单\n\n${input.verdict.findings
            .map(
              (f, i) =>
                `${i + 1}. **[${f.severity}]** \`${f.where}\`：${f.problem}（建议：${f.fix}）`,
            )
            .join("\n")}\n`
        : "";
    const nextAction = input.rejectLimitReached
      ? "未开启自动合并；已达修复轮数上限，升级给人并将工单移入 In Review"
      : "未开启自动合并；已带评审意见打回 Dev 修改，修复后将重新跑 CI 和评审";
    return `## 独立评审结论：🔁 拒绝（reject）

${input.verdict.summary}
${reasonsSection}${findingsSection}
- ${ciLine}
- 后续动作：${nextAction}

${sessionLine}
`;
  }

  const summary =
    input.verdict?.summary ??
    (input.ciGreen ? "评审要求升级给人。" : "CI 未确认全绿，不能开启自动合并。");
  const reasonsList =
    input.verdict !== undefined && input.verdict.reasons.length > 0
      ? input.verdict.reasons
      : [summary];
  const findingsSection =
    input.verdict !== undefined && input.verdict.findings.length > 0
      ? `\n### 相关发现\n\n${input.verdict.findings
          .map(
            (f, i) =>
              `${i + 1}. **[${f.severity}]** \`${f.where}\`：${f.problem}（建议：${f.fix}）`,
          )
          .join("\n")}\n`
      : "";
  return `## 独立评审结论：👀 升级给人（escalate）

${summary}

### 原因

${reasonsList.map((r) => `- ${r}`).join("\n")}
${findingsSection}
- ${ciLine}
- 后续动作：未开启自动合并，工单移入 In Review 等待人工审阅

${sessionLine}
`;
};
