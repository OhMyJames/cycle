// CYC-453: a 大档 run's Dev prompt carries the Design and Plan, its QA prompt the Spec, Design and Plan.

import { expect, test } from "bun:test";
import { devBrief, qaBrief } from "../src/prompts.ts";
import { fourDocs, fullFlowIssue, setupFullFlow } from "./full-flow-helpers.ts";
import { done, issue, PASS, REVIEW_MERGE } from "./helpers.ts";

const happy = { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] };
const texts = { spec: "SPEC-BODY", design: "DESIGN-BODY line 1\nline 2", plan: "PLAN-BODY step 1" };

const run = async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), happy);
  s.tracker.docContent[102] = texts.design;
  s.tracker.docContent[103] = texts.plan;
  s.tracker.docContent[101] = `${texts.spec}\n\n## 验收标准\n\n1. ok。验证：\`bun run check\`\n`;
  expect((await s.pipeline.step()).status).toBe("delivered");
  return s.sessions.prompts;
};

test("a 大档 Dev prompt has the Design and Plan in full and asks for the reason of a departure", async () => {
  const dev = (await run()).find((p) => p.role === "dev")?.prompt ?? "";
  expect(dev).toContain(texts.design);
  expect(dev).toContain(texts.plan);
  expect(dev).toContain("depart from the Plan");
  expect(dev).toContain("progress block");
});

test("a 大档 QA prompt has the Spec, Design and Plan and asks for departures from the Plan", async () => {
  const qa = (await run()).find((p) => p.role === "qa")?.prompt ?? "";
  expect(qa).toContain("SPEC-BODY");
  expect(qa).toContain(texts.design);
  expect(qa).toContain(texts.plan);
  expect(qa).toContain("departs from the Plan");
});

test("without documents the prompts are those of a small work item", () => {
  expect(devBrief(issue(), [])).not.toContain("Plan");
  expect(qaBrief(issue(), [], "d", "c")).not.toContain("完整流程");
  expect(devBrief(issue(), [], texts)).toContain("PLAN-BODY");
});
