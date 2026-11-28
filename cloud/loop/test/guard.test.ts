import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOOR, floorHits } from "../src/guard/floor.ts";
import { type MergeGateInput, mayMerge } from "../src/guard/merge-gate.ts";
import { runReviewCase } from "./review-case.ts";

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

test("a merge verdict touching a floor path disables auto-merge, escalates with comment, and records floor_hit (CYC-481)", async () => {
  const { result, tracker, world, events } = await runReviewCase(
    dir,
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
  const { result, tracker, world, events } = await runReviewCase(dir, "fail");
  expect(result).toMatchObject({ status: "delivered", autoMerge: false });
  expect(world.calls.some((c) => c.includes("gh pr merge"))).toBe(false);
  expect(tracker.moves).toContain("CYC-1:inReview");
  expect(tracker.comments.some((c) => c.includes("无法读取 PR 改动路径列表"))).toBe(true);
  expect(events.find((e) => e.kind === "floor_hit")).toMatchObject({ unreadable: true });
});

test("a merge verdict touching no floor path still enables auto-merge (CYC-481)", async () => {
  const { result, world, events } = await runReviewCase(dir, "packages/client/src/a.ts\n");
  expect(result).toMatchObject({ status: "delivered", autoMerge: true });
  expect(world.calls.some((c) => c.includes("gh pr merge") && c.includes("--auto"))).toBe(true);
  expect(events.find((e) => e.kind === "floor_hit")).toBeUndefined();
});

const okGate: MergeGateInput = {
  verdict: "merge",
  reviewedSha: "a1",
  headNow: "a1",
  ciAtHead: "passed",
  changedPaths: ["cloud/loop/src/x.ts"],
};

test("mayMerge allows only when every condition holds", () => {
  expect(mayMerge(okGate)).toEqual({ ok: true });
  expect(mayMerge({ ...okGate, author: { permission: "write", crossRepository: false } })).toEqual({
    ok: true,
  });
  for (const permission of ["maintain", "admin"])
    expect(mayMerge({ ...okGate, author: { permission, crossRepository: false } }).ok).toBe(true);
});

test("mayMerge refuses each failing condition", () => {
  const refused = (patch: Partial<MergeGateInput>) => mayMerge({ ...okGate, ...patch }).ok;
  for (const verdict of ["reject", "escalate", "system_error"] as const)
    expect(refused({ verdict })).toBe(false);
  expect(refused({ headNow: "b2" })).toBe(false);
  expect(refused({ reviewedSha: "", headNow: "" })).toBe(false);
  for (const ciAtHead of ["failed", "pending", "unreadable"] as const)
    expect(refused({ ciAtHead })).toBe(false);
  expect(refused({ changedPaths: null })).toBe(false);
  for (const permission of ["read", "triage", "none", ""])
    expect(refused({ author: { permission, crossRepository: false } })).toBe(false);
  expect(refused({ author: { permission: "admin", crossRepository: true } })).toBe(false);
});

test("mayMerge reports floor hits and reasons", () => {
  const r = mayMerge({
    ...okGate,
    changedPaths: ["README.md", "cloud/loop/src/guard/merge-gate.ts"],
  });
  expect(r).toEqual({
    ok: false,
    reasons: [expect.stringContaining("path floor")],
    floorHits: ["cloud/loop/src/guard/merge-gate.ts"],
  });
});
