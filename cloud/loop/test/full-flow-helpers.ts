// Shared by the 完整流程 tests (CYC-328): a pipeline over a tracker whose work item has linked documents.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deps, Pipeline } from "../src/pipeline.ts";
import { RunStore } from "../src/store.ts";
import type { Issue, IssueDocument } from "../src/types.ts";
import { config, FakeSessions, FakeTracker, issue, makeExec, type World } from "./helpers.ts";

export const FULL_FLOW_LABEL = 12;

export const specText = `# Spec

## 验收标准

1. 大档通过预检。验证：\`bun test ./cloud/loop/test/full-flow-preflight.test.ts\`
2. 门禁通过。验证：\`bun run check\`
`;

/** A 大档 work item with the label and a description that says nothing about criteria. */
export const fullFlowIssue = (over: Partial<Issue> = {}): Issue =>
  issue({ description: "see the documents", labelIds: [11, FULL_FLOW_LABEL], ...over });

/** The four documents of CYC-1, all locked, at version 3. */
export const fourDocs = (): IssueDocument[] =>
  ["Intent", "Spec", "Design", "Plan"].map((name, i) => ({
    id: 100 + i,
    title: `[CYC-1] ${name}`,
    version: 3,
    locked: true,
    archived: false,
  }));

export const setupFullFlow = async (
  issues: Issue[],
  docs: IssueDocument[] | undefined,
  script: ConstructorParameters<typeof FakeSessions>[0],
) => {
  const dir = await mkdtemp(join(tmpdir(), "auto-loop-ff-"));
  const cfg = config({ stateDir: dir, fullFlowLabelId: FULL_FLOW_LABEL });
  const tracker = new FakeTracker(issues);
  if (docs !== undefined) tracker.issueDocs["CYC-1"] = docs;
  tracker.docContent[101] = specText;
  const sessions = new FakeSessions(script);
  const world: World = {
    fail: new Set(),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["MERGED", "UNKNOWN"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  const clock = { now: () => new Date("2026-11-25T00:00:00Z") };
  const store = new RunStore(cfg.stateDir, () => clock.now());
  const pipeline = new Pipeline({
    config: cfg,
    tracker,
    sessions,
    exec: makeExec(world),
    store,
    clock,
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "secret", AUTO_LOOP_PLAN_KEY: "k" },
    sleep: async () => {},
    stopped: () => false,
  } as Deps);
  return { pipeline, tracker, sessions, store, world, cfg };
};
