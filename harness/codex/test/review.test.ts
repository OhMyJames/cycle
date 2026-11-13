import { expect, test } from "bun:test";
import { toReviewTarget, toTurns } from "../src/index.ts";

// What a review reads, and how a history codex keeps is read back.

test("a review names what it reads, and a commit only by its hash", () => {
  expect(toReviewTarget({ kind: "uncommitted" })).toEqual({ type: "uncommittedChanges" });
  expect(toReviewTarget({ kind: "branch", branch: " main " })).toEqual({
    type: "baseBranch",
    branch: "main",
  });
  expect(toReviewTarget({ kind: "commit", sha: "abc123" })).toEqual({
    type: "commit",
    sha: "abc123",
    title: null,
  });
  expect(() => toReviewTarget({ kind: "commit", sha: "--exec=x" })).toThrow("hash");
  expect(() => toReviewTarget({ kind: "custom", instructions: " " })).toThrow("Say what");
});

const wire = (id: string, rootTurnId: string, items: unknown[]) =>
  ({
    id,
    rootTurnId,
    items,
    status: "completed",
    error: null,
    startedAt: 1,
    durationMs: 1,
  }) as Parameters<typeof toTurns>[0][number];

test("a turn kept inside another, as a review's is, joins it", () => {
  const ask = { type: "userMessage", id: "u", content: [{ type: "text", text: "look" }] };
  const found = { type: "exitedReviewMode", id: "x", review: "fine" };
  const turns = toTurns([
    wire("a", "a", []),
    wire("in", "out", [ask]),
    wire("out", "out", [found]),
  ]);
  expect(turns.map((turn) => [turn.id, turn.items.map((item) => item.id)])).toEqual([
    ["a", []],
    ["out", ["u", "x"]],
  ]);
});

test("an item a finished turn's history keeps as running is settled, as it is live", () => {
  const nap = { type: "sleep", id: "z", durationMs: 5 };
  const [done] = toTurns([wire("a", "a", [nap])]);
  expect(done?.items[0]).toMatchObject({ kind: "wait", status: "completed" });
});
