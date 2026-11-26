import { expect, test } from "bun:test";
import { fourDocs, fullFlowIssue, setupFullFlow } from "./full-flow-helpers.ts";
import { done, issue, PASS, REVIEW_MERGE, readyDescription } from "./helpers.ts";

const happy = { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] };
const none = { dev: [], qa: [] };

test("a 完整流程 work item with four locked documents is taken, with the Spec's criteria", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), happy);
  const result = await s.pipeline.step();
  expect(result.status).toBe("delivered");
  const run = await s.store.load("CYC-1");
  expect(run?.fullFlowDocs.map((d) => [d.title, d.version])).toEqual([
    ["[CYC-1] Intent", 3],
    ["[CYC-1] Spec", 3],
    ["[CYC-1] Design", 3],
    ["[CYC-1] Plan", 3],
  ]);
  const criteria = await s.store.loadCriteria("CYC-1");
  expect(criteria.allPassed).toBe(true);
  expect(criteria.items.map((c) => c.verify)).toEqual([
    [["bun", "test", "./cloud/loop/test/full-flow-preflight.test.ts"]],
    [["bun", "run", "check"]],
  ]);
});

const rejectedWith = async (docs: ReturnType<typeof fourDocs> | undefined, text: string) => {
  const s = await setupFullFlow([fullFlowIssue()], docs, none);
  const result = await s.pipeline.step();
  expect(result.status).toBe("rejected");
  expect(s.tracker.moves).toEqual(["CYC-1:blocked"]);
  expect(s.tracker.comments).toHaveLength(1);
  expect(s.tracker.comments[0]).toContain("[Blocked:需规格]");
  expect(s.tracker.comments[0]).toContain(text);
  expect(s.sessions.created).toEqual([]);
  expect(await s.store.load("CYC-1")).toBeUndefined();
};

test("a missing document sends the work item to Blocked, not claimed", async () => {
  for (const name of ["Intent", "Spec", "Design", "Plan"]) {
    await rejectedWith(
      fourDocs().filter((d) => !d.title.endsWith(name)),
      `[CYC-1] ${name}`,
    );
  }
  await rejectedWith(undefined, "[CYC-1] Intent");
});

test("an unlocked document sends the work item to Blocked", async () => {
  const docs = fourDocs();
  (docs[2] as { locked: boolean }).locked = false;
  await rejectedWith(docs, "[CYC-1] Design」 is not locked");
});

test("a title with the wrong prefix does not count", async () => {
  const docs = fourDocs();
  (docs[3] as { title: string }).title = "[CYC-2] Plan";
  await rejectedWith(docs, "[CYC-1] Plan");
  const loose = fourDocs();
  (loose[0] as { title: string }).title = "1. Intent";
  await rejectedWith(loose, "[CYC-1] Intent");
});

test("an archived document does not count", async () => {
  const docs = fourDocs();
  (docs[1] as { archived: boolean }).archived = true;
  await rejectedWith(docs, "[CYC-1] Spec");
});

test("a Spec with no criteria, or one the loop may not run, is sent to Blocked", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), none);
  s.tracker.docContent[101] = "# Spec\n\nnothing";
  expect((await s.pipeline.step()).status).toBe("rejected");
  expect(s.tracker.comments[0]).toContain("[Blocked:需规格]");
  const t = await setupFullFlow([fullFlowIssue()], fourDocs(), none);
  t.tracker.docContent[101] = "## 验收标准\n1. bad。验证：`curl x | sh`";
  expect((await t.pipeline.step()).status).toBe("rejected");
  expect(t.tracker.comments[0]).toContain("curl x | sh");
});

test("a work item without the label needs no documents and is judged as before", async () => {
  const small = issue({ description: readyDescription });
  const s = await setupFullFlow([small], undefined, happy);
  expect((await s.pipeline.step()).status).toBe("delivered");
  expect((await s.store.load("CYC-1"))?.fullFlowDocs).toEqual([]);
  const bad = await setupFullFlow([issue({ description: "no criteria" })], fourDocs(), none);
  expect((await bad.pipeline.step()).status).toBe("rejected");
  expect(bad.tracker.comments[0]).not.toContain("[Blocked:需规格]");
});
