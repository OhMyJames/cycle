import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderReviewComment } from "../src/pr.ts";
import { parseReviewVerdict } from "../src/prompts.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
const reviewDocPath = resolve(repoRoot, "REVIEW.md");

test("REVIEW.md exists at repository root and defines review verdicts, criteria, and fail-closed rule", async () => {
  expect(existsSync(reviewDocPath)).toBe(true);
  const content = await readFile(reviewDocPath, "utf8");
  expect(content.trim().length).toBeGreaterThan(200);
  // Both structured outcomes are documented.
  expect(content).toContain("auto_merge");
  expect(content).toContain("human_review");
  // Explains read-only review, AGENTS.md alignment, and no code-enforced path floor.
  expect(content).toContain("只读");
  expect(content).toContain("AGENTS.md");
  expect(content).toContain("路径底线");
  // Fail-closed rule when CI is green but review is incomplete.
  expect(content).toContain("评审未完成");
  expect(content).toContain("In Review");
});

test("parseReviewVerdict parses structured auto_merge and human_review verdicts and rejects malformed ones", () => {
  const ok = parseReviewVerdict(
    'What I checked:\n- read a.ts\n<review>{"decision":"auto_merge","summary":"all good","reasons":["scoped change","tests cover behavior"]}</review>',
  );
  expect(ok).toEqual({
    decision: "auto_merge",
    summary: "all good",
    reasons: ["scoped change", "tests cover behavior"],
  });

  const human = parseReviewVerdict(
    '<review>{"decision":"human_review","summary":"needs human","reasons":["weakens permission boundary"]}</review>',
  );
  expect(human).toEqual({
    decision: "human_review",
    summary: "needs human",
    reasons: ["weakens permission boundary"],
  });

  // Last <review> block wins.
  const multi = parseReviewVerdict(
    '<review>{"decision":"auto_merge","summary":"first"}</review>\n<review>{"decision":"human_review","summary":"second","reasons":["found issue"]}</review>',
  );
  expect(multi?.decision).toBe("human_review");
  expect(multi?.summary).toBe("second");

  // Missing, malformed, unknown decision, or blank summary -> undefined.
  expect(parseReviewVerdict("looks good to me")).toBeUndefined();
  expect(parseReviewVerdict("<review>{not json</review>")).toBeUndefined();
  expect(
    parseReviewVerdict('<review>{"decision":"approve","summary":"x"}</review>'),
  ).toBeUndefined();
  expect(
    parseReviewVerdict('<review>{"decision":"auto_merge","summary":"   "}</review>'),
  ).toBeUndefined();
});

test("renderReviewComment formats auto-merge, human-review, and incomplete-review PR comments", () => {
  const autoComment = renderReviewComment({
    issueKey: "CYC-332",
    ciChecks: ["check", "browser", "integration"],
    ciGreen: true,
    sessionId: "review-3",
    verdict: { decision: "auto_merge", summary: "改动清晰且测试充分", reasons: ["符合 REVIEW.md"] },
  });
  expect(autoComment).toContain("可自动合并");
  expect(autoComment).toContain("squash");
  expect(autoComment).toContain("REVIEW.md");
  expect(autoComment).toContain("`review-3`");

  const humanComment = renderReviewComment({
    issueKey: "CYC-332",
    ciChecks: ["check", "browser", "integration"],
    ciGreen: true,
    sessionId: "review-4",
    verdict: {
      decision: "human_review",
      summary: "涉及权限边界调整",
      reasons: ["放宽了命令白名单"],
    },
  });
  expect(humanComment).toContain("需要人参与");
  expect(humanComment).toContain("放宽了命令白名单");
  expect(humanComment).toContain("未开启自动合并");

  const incompleteComment = renderReviewComment({
    issueKey: "CYC-332",
    ciChecks: ["check", "browser", "integration"],
    ciGreen: true,
    sessionId: "review-5",
    incompleteReason: "评审会话单回合超时被取消。",
  });
  expect(incompleteComment).toContain("评审未完成");
  expect(incompleteComment).toContain("需要人参与");
  expect(incompleteComment).toContain("评审会话单回合超时被取消");
});
