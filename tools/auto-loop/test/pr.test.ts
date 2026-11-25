import { expect, test } from "bun:test";
import type { Criterion } from "../src/criteria.ts";
import { hasClosingKeyword, renderPr, renderPrTitle, validatePr } from "../src/pr.ts";
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

test("PR title contains the issue key and Closes CYC-<num>", () => {
  const title = renderPrTitle(sampleIssue);
  expect(title).toContain("CYC-330");
  expect(title).toContain("Closes CYC-330");
  expect(hasClosingKeyword(title, "CYC-330")).toBe(true);
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
  expect(validatePr("CYC-330", title, "## 目的\n\nCYC-330 title").ok).toBe(false);
  // Prefix collision must not match (CYC-33 must not match CYC-330).
  expect(validatePr("CYC-33", title, body).ok).toBe(false);
  expect(validatePr("CYC-331", title, body).ok).toBe(false);
});
