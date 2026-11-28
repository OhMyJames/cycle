import { expect, test } from "bun:test";
import type { LoopTimelineStep } from "../src/api.ts";
import { hasDependencies, layoutDag, NODE_H, NODE_W } from "../src/react/loop-timeline-dag.tsx";

const step = (id: string, dependsOn: string[] = []): LoopTimelineStep => ({
  id,
  label: id,
  role: "dev",
  status: "passed",
  sessionId: null,
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
  dependsOn,
});

test("nodes sit in columns by the longest chain before them, with one edge per dependency", () => {
  const dag = layoutDag([step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"])]);
  const col = (id: string) => dag.nodes.find((n) => n.step.id === id)?.column;
  expect([col("a"), col("b"), col("c"), col("d")]).toEqual([0, 1, 1, 2]);
  expect(dag.edges).toHaveLength(4);
  expect(dag.width).toBeGreaterThan(3 * NODE_W);
  expect(dag.height).toBeGreaterThan(2 * NODE_H);
});

test("a dependency that is not among the steps, or a node waiting for itself, is ignored", () => {
  const dag = layoutDag([step("a", ["a", "ghost"]), step("b", ["a"])]);
  expect(dag.edges).toEqual([{ from: "a", to: "b" }]);
  expect(hasDependencies([step("a", ["ghost"])])).toBe(false);
  expect(hasDependencies([step("a"), step("b", ["a"])])).toBe(true);
});

test("a cycle does not hang the layout", () => {
  expect(layoutDag([step("a", ["b"]), step("b", ["a"])]).nodes).toHaveLength(2);
});

test("steps from an older app without dependsOn lay out in one column", () => {
  const old = { ...step("a"), dependsOn: undefined } as unknown as LoopTimelineStep;
  expect(layoutDag([old]).nodes).toHaveLength(1);
});

test("a dependency listed twice is one edge, and the edge that closes a cycle is dropped", () => {
  expect(layoutDag([step("a"), step("b", ["a", "a"])]).edges).toHaveLength(1);
  const cyclic = layoutDag([step("a", ["b"]), step("b", ["a"])]);
  for (const e of cyclic.edges) {
    const col = (id: string) => cyclic.nodes.find((n) => n.step.id === id)?.column ?? 0;
    expect(col(e.from)).toBeLessThan(col(e.to));
  }
});
