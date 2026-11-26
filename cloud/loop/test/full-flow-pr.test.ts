import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { docsBaseOf, renderPr } from "../src/pr.ts";
import { fourDocs, fullFlowIssue, setupFullFlow } from "./full-flow-helpers.ts";
import { done, issue, PASS, REVIEW_MERGE } from "./helpers.ts";

const happy = { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] };
const BASE = "https://plan.ops.shrimpdot.ai/infra/CYC/docs";

const prBody = async (docsBase: string | null) => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), happy);
  (s.cfg as { docsBase: string | null }).docsBase = docsBase;
  expect((await s.pipeline.step()).status).toBe("delivered");
  return readFile(join(s.cfg.stateDir, "runs", "CYC-1", "pr-body.md"), "utf8");
};

test("the base of a document link is the origin of planUrl plus the team and project of the key", () => {
  expect(docsBaseOf("https://plan.ops.shrimpdot.ai/mcp", "infra.CYC")).toBe(BASE);
  expect(docsBaseOf("https://plan.ops.shrimpdot.ai", "CYC")).toBeNull();
  expect(docsBaseOf("https://plan.ops.shrimpdot.ai", "a.b.c")).toBeNull();
  expect(docsBaseOf("not a url", "infra.CYC")).toBeNull();
});

test("a 大档 pull request lists the four documents with their links", async () => {
  const body = await prBody(BASE);
  expect(body).toContain("## 依据文档");
  for (const [i, name] of ["Intent", "Spec", "Design", "Plan"].entries())
    expect(body).toContain(`- [\\[CYC-1\\] ${name}](${BASE}/${100 + i})`);
});

test("without a team prefix the pull request lists the titles only", async () => {
  const body = await prBody(null);
  expect(body).toContain("## 依据文档");
  for (const name of ["Intent", "Spec", "Design", "Plan"])
    expect(body).toContain(`- [CYC-1] ${name}\n`);
  expect(body).not.toContain("](");
  expect(body).not.toContain("http");
});

test("a small work item's pull request has no documents section", () => {
  const body = renderPr({
    issue: issue(),
    criteria: [],
    checks: [],
    rounds: 0,
    summary: "x",
    sessions: { dev: null, qa: null },
    docsBase: BASE,
  });
  expect(body).not.toContain("依据文档");
});
