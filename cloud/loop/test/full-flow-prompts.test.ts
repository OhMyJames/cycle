// CYC-453: a 大档 run's Dev prompt carries the Design and Plan, its QA prompt the Spec, Design and Plan.

import { expect, test } from "bun:test";
import { readFullFlowTexts } from "../src/full-flow.ts";
import { devBrief, fixBrief, handoffBrief, qaBrief } from "../src/prompts/index.ts";
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

test("the QA prompt does not promise the developer's notes, which QA is not given", async () => {
  const qa = (await run()).find((p) => p.role === "qa")?.prompt ?? "";
  expect(qa).not.toContain("progress notes");
  expect(qa).toContain("judge by effect");
});

test("a handoff prompt carries the documents and the rule; fix and continue prompts do not", () => {
  const handoff = handoffBrief(issue(), [], "did x", "", null, texts);
  expect(handoff).toContain("PLAN-BODY");
  expect(handoff).toContain("depart from the Plan");
  expect(fixBrief(1, "findings")).not.toContain("PLAN-BODY");
});

test("a document with a code fence inside is fenced by a longer one", () => {
  const brief = devBrief(issue(), [], { design: "```ts\nx\n```", plan: "p" });
  expect(brief).toContain("````markdown");
});

test("readFullFlowTexts reads only the names asked, and fails on a missing or changed document", async () => {
  const recorded = [{ id: 102, title: "[CYC-1] Design", version: 3 }];
  const tracker = { getDocumentContent: async (id: number) => `doc ${id}` };
  expect(await readFullFlowTexts(recorded, tracker, ["Design"])).toEqual({ design: "doc 102" });
  expect(await readFullFlowTexts([], tracker, ["Design"])).toBeUndefined();
  await expect(readFullFlowTexts(recorded, tracker, ["Plan"])).rejects.toThrow("no recorded Plan");
  await expect(
    readFullFlowTexts(recorded, tracker, ["Design"], async () => "went to version 4"),
  ).rejects.toThrow("version 4");
});

test("a Plan edited after the run began blocks the Dev turn instead of reaching the prompt", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), happy);
  const original = s.tracker.listIssueDocuments.bind(s.tracker);
  let calls = 0;
  s.tracker.listIssueDocuments = async (i) => {
    const docs = structuredClone(await original(i));
    calls += 1;
    if (calls >= 3) (docs[3] as { version: number }).version = 4;
    return docs;
  };
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.sessions.prompts.find((p) => p.role === "dev")).toBeUndefined();
});
