import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFindings, parseProgress, parseVerdict } from "../src/prompts.ts";
import { computeStats } from "../src/stats.ts";
import { acquireLock, type LoopEvent, RunStore } from "../src/store.ts";

const now = () => new Date("2026-11-25T00:00:00Z");

test("progress: the last block wins", () => {
  expect(parseProgress("a <progress>one</progress> b <progress>two</progress>")).toBe("two");
  expect(parseProgress("none")).toBeUndefined();
});

test("verdict: a pass with a non-minor finding is not a pass; junk is unreadable", () => {
  const finding = (severity: string) =>
    `<verdict>{"pass":true,"findings":[{"severity":"${severity}","where":"a","problem":"p","fix":"f"}]}</verdict>`;
  expect(parseVerdict(finding("major"))?.pass).toBe(false);
  expect(parseVerdict(finding("minor"))?.pass).toBe(true);
  expect(parseVerdict("<verdict>{nope</verdict>")).toBeUndefined();
  const major = parseVerdict(finding("major"));
  expect(major === undefined ? "" : formatFindings(major)).toContain("[major] a: p");
});

test("store: events and progress append; unfinished lists runs not done", async () => {
  const store = new RunStore(await mkdtemp(join(tmpdir(), "al-")), now);
  await store.event("CYC-1", "claimed", { n: 1 });
  expect((await store.events()).map((e) => e.kind)).toEqual(["claimed"]);
  await store.appendProgress("CYC-1", 0, "did x");
  expect(await store.readProgress("CYC-1")).toContain("did x");
  expect(await store.unfinished()).toEqual([]);
});

test("lock: a live holder refuses, a dead one is taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "al-"));
  const release = await acquireLock(dir, () => true, 111);
  await expect(acquireLock(dir, () => true, 222)).rejects.toThrow("another loop");
  await release();
  await writeFile(join(dir, "loop.lock"), "999");
  await (await acquireLock(dir, () => false, 222))();
});

test("stats: rates from the event log", () => {
  const e = (run: string, kind: string, extra: Record<string, string> = {}): LoopEvent => ({
    ts: "t",
    run,
    kind,
    ...extra,
  });
  const stats = computeStats([
    e("A", "claimed"),
    e("A", "verify"),
    e("A", "delivered", { prUrl: "u" }),
    e("B", "claimed"),
    e("B", "verify"),
    e("B", "round_failed"),
    e("B", "blocked"),
  ]);
  expect(stats.runs).toBe(2);
  expect(stats.delivered).toBe(1);
  expect(stats.autonomousCompletionRate).toBe(0.5);
  expect(stats.interventionRate).toBe(0.5);
  expect(stats.reworkRate).toBe(0.5);
});
