import type { Criterion } from "./criteria.ts";
import type { Issue } from "./types.ts";

const firstLine = (text: string | null): string =>
  (text ?? "").split("\n").find((line) => line.trim() !== "" && !line.startsWith("$")) ?? "";

/**
 * The pull request's text. It leads with what the change is for and whether each criterion held, so a person reads
 * the intent and the evidence, not the diff first.
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
  return `## 目的

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
