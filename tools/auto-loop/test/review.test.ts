import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderReviewComment } from "../src/pr.ts";
import { formatReviewFindings, parseReviewVerdict } from "../src/prompts.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
const reviewDocPath = resolve(repoRoot, "REVIEW.md");

test("REVIEW.md exists at repository root and defines the three conclusions and retry rule", async () => {
  expect(existsSync(reviewDocPath)).toBe(true);
  const content = await readFile(reviewDocPath, "utf8");
  expect(content.trim().length).toBeGreaterThan(200);
  // All three structured conclusions are documented.
  expect(content).toContain("merge");
  expect(content).toContain("reject");
  expect(content).toContain("escalate");
  expect(content).toContain("合并");
  expect(content).toContain("拒绝");
  expect(content).toContain("升级给人");
  // Explains read-only review, AGENTS.md alignment, and no code-enforced path floor.
  expect(content).toContain("只读");
  expect(content).toContain("AGENTS.md");
  expect(content).toContain("路径底线");
  expect(content).toContain("In Review");
  // Defines the retry rule instead of the old "incomplete review directly escalates" rule.
  expect(content).toContain("重试");
  expect(content).toContain("重试次数用完");
  expect(content).toContain("评审系统故障");
  expect(content).toContain("不是代码问题");
  expect(content).not.toContain("auto_merge");
  expect(content).not.toContain("human_review");
  expect(content).not.toContain("「CI 绿但评审未完成」一律按**需要人参与**处理");
});

test("parseReviewVerdict parses merge, reject, and escalate verdicts, downgrades contradictory merge, and rejects malformed ones", () => {
  const ok = parseReviewVerdict(
    'What I checked:\n- read a.ts\n<review>{"decision":"merge","summary":"all good","reasons":["scoped change","tests cover behavior"]}</review>',
  );
  expect(ok).toEqual({
    decision: "merge",
    summary: "all good",
    reasons: ["scoped change", "tests cover behavior"],
    findings: [],
  });

  const rejected = parseReviewVerdict(
    '<review>{"decision":"reject","summary":"missing null check","reasons":["breaks on empty input"],"findings":[{"severity":"major","where":"src/a.ts","problem":"crashes on empty","fix":"guard empty input"}]}</review>',
  );
  expect(rejected).toEqual({
    decision: "reject",
    summary: "missing null check",
    reasons: ["breaks on empty input"],
    findings: [
      {
        severity: "major",
        where: "src/a.ts",
        problem: "crashes on empty",
        fix: "guard empty input",
      },
    ],
  });
  expect(rejected === undefined ? "" : formatReviewFindings(rejected)).toContain(
    "[major] src/a.ts: crashes on empty",
  );

  const escalated = parseReviewVerdict(
    '<review>{"decision":"escalate","summary":"needs human","reasons":["weakens permission boundary"]}</review>',
  );
  expect(escalated).toEqual({
    decision: "escalate",
    summary: "needs human",
    reasons: ["weakens permission boundary"],
    findings: [],
  });

  // A merge verdict carrying a blocker or major finding is downgraded to reject; minor finding stays merge.
  const contradictory = parseReviewVerdict(
    '<review>{"decision":"merge","summary":"mostly ok","findings":[{"severity":"blocker","where":"a.ts","problem":"leak","fix":"close"}]}</review>',
  );
  expect(contradictory?.decision).toBe("reject");
  const minorOnly = parseReviewVerdict(
    '<review>{"decision":"merge","summary":"ok","findings":[{"severity":"minor","where":"a.ts","problem":"nit","fix":"rename"}]}</review>',
  );
  expect(minorOnly?.decision).toBe("merge");

  // Last <review> block wins.
  const multi = parseReviewVerdict(
    '<review>{"decision":"merge","summary":"first"}</review>\n<review>{"decision":"escalate","summary":"second","reasons":["found risk"]}</review>',
  );
  expect(multi?.decision).toBe("escalate");
  expect(multi?.summary).toBe("second");

  // Missing, malformed, legacy/unknown decision, or blank summary -> undefined.
  expect(parseReviewVerdict("looks good to me")).toBeUndefined();
  expect(parseReviewVerdict("<review>{not json</review>")).toBeUndefined();
  expect(
    parseReviewVerdict('<review>{"decision":"auto_merge","summary":"x"}</review>'),
  ).toBeUndefined();
  expect(
    parseReviewVerdict('<review>{"decision":"human_review","summary":"x"}</review>'),
  ).toBeUndefined();
  expect(
    parseReviewVerdict('<review>{"decision":"merge","summary":"   "}</review>'),
  ).toBeUndefined();
});

test("renderReviewComment formats merge, reject, escalate, and review system error PR comments", () => {
  const mergeComment = renderReviewComment({
    issueKey: "CYC-332",
    ciChecks: ["check", "browser", "integration"],
    ciGreen: true,
    sessionId: "review-3",
    verdict: {
      decision: "merge",
      summary: "改动清晰且测试充分",
      reasons: ["符合 REVIEW.md"],
      findings: [],
    },
  });
  expect(mergeComment).toContain("合并（merge）");
  expect(mergeComment).toContain("squash");
  expect(mergeComment).toContain("REVIEW.md");
  expect(mergeComment).toContain("`review-3`");

  const rejectComment = renderReviewComment({
    issueKey: "CYC-332",
    ciChecks: ["check", "browser", "integration"],
    ciGreen: true,
    sessionId: "review-4",
    verdict: {
      decision: "reject",
      summary: "存在主要边界缺陷",
      reasons: ["缺少失败路径测试"],
      findings: [
        {
          severity: "major",
          where: "src/pipeline.ts",
          problem: "未处理空输入",
          fix: "补充校验与单测",
        },
      ],
    },
  });
  expect(rejectComment).toContain("拒绝（reject）");
  expect(rejectComment).toContain("打回 Dev 修改");
  expect(rejectComment).toContain("src/pipeline.ts");

  const rejectLimitComment = renderReviewComment({
    issueKey: "CYC-332",
    ciChecks: ["check", "browser", "integration"],
    ciGreen: true,
    sessionId: "review-4",
    verdict: {
      decision: "reject",
      summary: "仍有未修问题",
      reasons: [],
      findings: [],
    },
    rejectLimitReached: true,
  });
  expect(rejectLimitComment).toContain("修复轮数上限");
  expect(rejectLimitComment).toContain("In Review");

  const escalateComment = renderReviewComment({
    issueKey: "CYC-332",
    ciChecks: ["check", "browser", "integration"],
    ciGreen: true,
    sessionId: "review-5",
    verdict: {
      decision: "escalate",
      summary: "涉及权限边界调整",
      reasons: ["放宽了命令白名单"],
      findings: [],
    },
  });
  expect(escalateComment).toContain("升级给人（escalate）");
  expect(escalateComment).toContain("放宽了命令白名单");
  expect(escalateComment).toContain("未开启自动合并");

  const systemErrorComment = renderReviewComment({
    issueKey: "CYC-332",
    ciChecks: ["check", "browser", "integration"],
    ciGreen: true,
    sessionId: "review-6",
    systemError: { reason: "评审会话单回合超时被取消。", attempts: 3 },
  });
  expect(systemErrorComment).toContain("评审系统故障");
  expect(systemErrorComment).toContain("非代码问题");
  expect(systemErrorComment).toContain("3 次");
  expect(systemErrorComment).toContain("评审会话单回合超时被取消");
});
