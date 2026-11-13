import { expect, test } from "bun:test";
import { toReviewTarget, toTurns } from "../src/index.ts";

// A review: what it reads, and how codex keeps it in a history.

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
