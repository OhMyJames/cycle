import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { FLOOR, floorHits } from "../src/guard/floor.ts";
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

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loop-guard-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("floorHits matches supervisor, guard, REVIEW.md and .github paths only", () => {
  expect(FLOOR).toEqual([
    "cloud/loop/src/supervisor/",
    "cloud/loop/src/guard/",
    "REVIEW.md",
    ".github/",
  ]);
  expect(
    floorHits([
      "packages/ui/src/react/app.tsx",
      "cloud/loop/src/flows/dev/review.ts",
      "REVIEW.md",
      "./.github/workflows/ci.yml",
      "cloud/loop/src/guard/floor.ts",
      "cloud/loop/src/supervisor/main.ts",
      "docs/REVIEW.md",
    ]),
  ).toEqual([
    "REVIEW.md",
    ".github/workflows/ci.yml",
    "cloud/loop/src/guard/floor.ts",
    "cloud/loop/src/supervisor/main.ts",
  ]);
  expect(floorHits(["packages/client/src/a.ts", "cloud/loop/src/engine/engine.ts"])).toEqual([]);
});

const runReviewCase = async (changedPathsOutput: string | "fail") => {
  const w: World = {
    fail: new Set(),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [greenCi("abc")],
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

test("a merge verdict touching a floor path disables auto-merge, escalates with comment, and records floor_hit (CYC-481)", async () => {
  const { result, tracker, world, events } = await runReviewCase(
    "packages/ui/src/a.ts\nREVIEW.md\n.github/workflows/ci.yml\n",
  );
  expect(result).toMatchObject({ status: "delivered", autoMerge: false });
  expect(world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(tracker.moves).toContain("CYC-1:inReview");
  expect(
    tracker.comments.some((c) =>
      c.includes("改动涉及需要人合并的路径：REVIEW.md、.github/workflows/ci.yml"),
    ),
  ).toBe(true);
  expect(events.find((e) => e.kind === "floor_hit")).toMatchObject({
    paths: "REVIEW.md,.github/workflows/ci.yml",
  });
});

test("when changedPaths cannot be read, a merge verdict also escalates and records floor_hit (CYC-481)", async () => {
  const { result, tracker, world, events } = await runReviewCase("fail");
  expect(result).toMatchObject({ status: "delivered", autoMerge: false });
  expect(world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(tracker.moves).toContain("CYC-1:inReview");
  expect(tracker.comments.some((c) => c.includes("无法读取 PR 改动路径列表"))).toBe(true);
  expect(events.find((e) => e.kind === "floor_hit")).toMatchObject({ unreadable: true });
});

test("a merge verdict touching no floor path still enables auto-merge (CYC-481)", async () => {
  const { result, world, events } = await runReviewCase("packages/client/src/a.ts\n");
  expect(result).toMatchObject({ status: "delivered", autoMerge: true });
  expect(world.calls.some((c) => c.includes("gh pr merge") && c.includes("--auto"))).toBe(true);
  expect(events.find((e) => e.kind === "floor_hit")).toBeUndefined();
});
