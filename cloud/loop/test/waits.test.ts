import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";

let clock = new Date("2026-11-28T00:00:00Z");
const open = async () => SqliteStore.open(await mkdtemp(join(tmpdir(), "al-waits-")), () => clock);
const later = (s: number) => new Date(clock.getTime() + s * 1000).toISOString();

test("a review task is one row per repo, PR and commit, and one caller claims it", async () => {
  const s = await open();
  const a = s.reviewTask("o/r", 1, "aaa", "pr");
  const again = s.reviewTask("o/r", 1, "aaa", "dev:x");
  expect(again.id).toBe(a.id);
  expect(again.origin).toBe("pr");
  expect(s.reviewTask("o/r", 1, "bbb", "pr").id).not.toBe(a.id);
  expect(s.claimReviewTask(a.id)).toBe(true);
  expect(s.claimReviewTask(a.id)).toBe(false);
  s.addReviewSession(a.id, "s1");
  s.addReviewSession(a.id, "s2");
  expect(s.markReviewCommented(a.id, "aaa:merge")).toBe(true);
  expect(s.markReviewCommented(a.id, "aaa:merge")).toBe(false);
  s.finishReviewTask(a.id, "merge", { findings: [] });
  const done = s.findReviewTask("o/r", 1, "aaa");
  expect(done?.status).toBe("done");
  expect(done?.decision).toBe("merge");
  expect(done?.sessions).toEqual(["s1", "s2"]);
  expect(done?.verdict).toEqual({ findings: [] });
  expect(s.findReviewTask("o/r", 1, "bbb")?.decision).toBeNull();
  s.close();
});

test("a signal wakes the work waiting on its subject, and a repeat counts once", async () => {
  const s = await open();
  s.wait("pr:o/r#1", "ci:o/r@a", later(600));
  s.wait("pr:o/r#2", "ci:o/r@b", later(600));
  expect(s.dueWaits()).toEqual([]);
  expect(s.signal("ci:o/r@a:1", "ci:o/r@a", "poll")).toBe(true);
  expect(s.dueWaits().map((w) => w.owner)).toEqual(["pr:o/r#1"]);
  // a repeat does not wake a wait registered after the first signal
  s.wait("pr:o/r#1", "ci:o/r@a", later(600));
  expect(s.dueWaits()).toEqual([]);
  expect(s.signal("ci:o/r@a:1", "ci:o/r@a", "poll")).toBe(false);
  expect(s.dueWaits()).toEqual([]);
  s.clearWaits("pr:o/r#1");
  expect(s.waits("pr:o/r#1")).toEqual([]);
  s.close();
});

test("without a signal a wait is due at its recheck time", async () => {
  const s = await open();
  s.wait("pr:o/r#1", "ci:o/r@a", later(60));
  expect(s.dueWaits()).toEqual([]);
  clock = new Date(later(61));
  expect(s.dueWaits().map((w) => w.owner)).toEqual(["pr:o/r#1"]);
  s.close();
});

test("a failed transaction leaves neither the signal nor the wake", async () => {
  const s = await open();
  s.wait("pr:o/r#1", "ci:o/r@a", later(6000));
  expect(() =>
    s.transaction((tx) => {
      tx.signal("d1", "ci:o/r@a", "poll");
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(s.waits("pr:o/r#1")[0]?.wokenAt).toBeNull();
  expect(s.signal("d1", "ci:o/r@a", "poll")).toBe(true);
  s.close();
});

test("PR review counts and the cap is said once", async () => {
  const s = await open();
  expect(s.prReview("o/r", 3)).toMatchObject({ reviews: 0, capped: false, lastSha: null });
  s.countPrReview("o/r", 3, "a");
  expect(s.countPrReview("o/r", 3, "b")).toMatchObject({ reviews: 2, lastSha: "b" });
  expect(s.markPrCapped("o/r", 3)).toBe(true);
  expect(s.markPrCapped("o/r", 3)).toBe(false);
  expect(s.prReview("o/r", 3).capped).toBe(true);
  s.close();
});

test("a running review task whose claimer died is taken over after the lease", async () => {
  const s = await open();
  const a = s.reviewTask("o/r", 1, "sha", "pr");
  expect(s.claimReviewTask(a.id)).toBe(true);
  expect(s.claimReviewTask(a.id, 60_000)).toBe(false);
  clock = new Date(clock.getTime() + 120_000);
  expect(s.claimReviewTask(a.id, 60_000)).toBe(true);
});
