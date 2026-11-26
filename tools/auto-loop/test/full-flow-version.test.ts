import { expect, test } from "bun:test";
import { fourDocs, fullFlowIssue, setupFullFlow } from "./full-flow-helpers.ts";
import { done, PASS, REVIEW_MERGE } from "./helpers.ts";

const happy = { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] };

/** The documents read from the `n`th call on come back as `change` makes them. */
const changeFromCall = (
  s: Awaited<ReturnType<typeof setupFullFlow>>,
  n: number,
  change: (docs: ReturnType<typeof fourDocs>) => void,
) => {
  const original = s.tracker.listIssueDocuments.bind(s.tracker);
  let calls = 0;
  s.tracker.listIssueDocuments = async (i) => {
    calls += 1;
    const docs = structuredClone(await original(i));
    if (calls >= n) change(docs);
    return docs;
  };
};

test("a document whose version changes after the run began sends it to Blocked", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), happy);
  changeFromCall(s, 3, (docs) => {
    (docs[3] as { version: number }).version = 4;
  });
  const result = await s.pipeline.step();
  expect(result.status).toBe("blocked");
  expect(s.tracker.moves.at(-1)).toBe("CYC-1:blocked");
  expect(s.tracker.comments.at(-1)).toContain("[Blocked:需规格]");
  expect(s.tracker.comments.at(-1)).toContain("[CYC-1] Plan");
  expect(s.tracker.comments.at(-1)).toContain("version 3 to 4");
  expect((await s.store.load("CYC-1"))?.phase).toBe("blocked");
});

test("an unlocked or unlinked document during the run also blocks", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), happy);
  changeFromCall(s, 2, (docs) => {
    (docs[0] as { locked: boolean }).locked = false;
  });
  expect((await s.pipeline.step()).status).toBe("blocked");
  expect(s.tracker.comments.at(-1)).toContain("was unlocked");
  const t = await setupFullFlow([fullFlowIssue()], fourDocs(), happy);
  changeFromCall(t, 2, (docs) => {
    docs.pop();
  });
  expect((await t.pipeline.step()).status).toBe("blocked");
  expect(t.tracker.comments.at(-1)).toContain("no longer linked");
});

test("documents that do not change never block", async () => {
  const s = await setupFullFlow([fullFlowIssue()], fourDocs(), happy);
  expect((await s.pipeline.step()).status).toBe("delivered");
});
