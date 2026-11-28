import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { Pipeline } from "../src/pipeline.ts";
import type { Exec } from "../src/types.ts";
import {
  CHECKED,
  config,
  done,
  FakeSessions,
  FakeTracker,
  greenCi,
  issue,
  makeExec,
  PASS,
  REVIEW_MERGE,
  readyDescription,
  type World,
} from "./helpers.ts";

export type MergeFakes = {
  /** What `gh pr merge --auto` fails with (exit 1). */
  autoError?: string;
  /** What the direct `gh pr merge --match-head-commit` fails with (exit 1). */
  directError?: string;
};

/** The reviewed head: `mergeAt` takes only a full commit id. */
export const REVIEWED_SHA = "0123456789abcdef0123456789abcdef01234567";

export const runReviewCase = async (
  dir: string,
  changedPathsOutput: string | "fail",
  fakes: MergeFakes = {},
) => {
  const w: World = {
    fail: new Set(),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: REVIEWED_SHA,
    ciResponses: [greenCi(REVIEWED_SHA)],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["MERGED", "MERGEABLE"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  const baseExec = makeExec(w);
  const exec: Exec = async (argv, opts) => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "diff") {
      w.calls.push(argv.join(" "));
      if (changedPathsOutput === "fail") {
        return { code: 1, output: "HTTP 500 error reading diff", timedOut: false };
      }
      return { code: 0, output: changedPathsOutput, timedOut: false };
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      const error = argv.includes("--auto") ? fakes.autoError : fakes.directError;
      if (error !== undefined) {
        w.calls.push(argv.join(" "));
        return { code: 1, output: error, timedOut: false };
      }
    }
    return baseExec(argv, opts);
  };
  const tracker = new FakeTracker([issue({ description: readyDescription })]);
  const sessions = new FakeSessions({
    dev: [done()],
    qa: [done(`${CHECKED}${PASS}`)],
    review: [done(`${CHECKED}${REVIEW_MERGE}`)],
  });
  const store = SqliteStore.open(dir, () => new Date("2026-11-27T00:00:00Z"));
  const pipeline = new Pipeline({
    config: config({ stateDir: dir, repoRoot: join(dir, "repo") }),
    tracker,
    sessions,
    exec,
    store,
    clock: { now: () => new Date("2026-11-27T00:00:00Z") },
    log: () => {},
    env: { PATH: "/bin", GH_TOKEN: "gh" },
    sleep: async () => {},
  });
  const result = await pipeline.step();
  const events = await store.events();
  return { result, tracker, world: w, events };
};
