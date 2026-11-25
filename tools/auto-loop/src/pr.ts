import type { Criterion } from "./criteria.ts";
import type { Issue } from "./types.ts";

const firstLine = (text: string | null): string =>
  (text ?? "").split("\n").find((line) => line.trim() !== "" && !line.startsWith("$")) ?? "";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` contains the exact closing keyword `Closes <key>` (not a prefix of a larger number). */
export const hasClosingKeyword = (text: string, key: string): boolean =>
  new RegExp(`(?:^|\\W)Closes ${escapeRegExp(key)}(?=$|\\W)`).test(text);

/**
 * The pull request's title. Always carries `Closes <key>` so the tracker's GitHub integration moves the work item to
 * Done when the pull request is merged.
 */
export const renderPrTitle = (issue: Pick<Issue, "key" | "title">): string =>
  `${issue.key} ${issue.title.trim()} (Closes ${issue.key})`;

/**
 * Checks that both title and body carry `Closes <key>` before opening a pull request.
 */
export const validatePr = (
  key: string,
  title: string,
  body: string,
): { ok: true } | { ok: false; reason: string } => {
  if (!hasClosingKeyword(title, key))
    return { ok: false, reason: `PR 标题缺少关闭关键词「Closes ${key}」。` };
  if (!hasClosingKeyword(body, key))
    return { ok: false, reason: `PR 正文缺少关闭关键词「Closes ${key}」。` };
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
