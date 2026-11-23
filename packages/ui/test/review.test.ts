import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { blocksOf, reduce, reviewOf, reviewTally, type ToolItem } from "../src/model/index.ts";

const call = (rawInput: unknown, over: Partial<ToolItem> = {}): ToolItem =>
  ({
    kind: "tool",
    id: "r",
    turn: 0,
    name: "ReportFindings",
    status: "completed",
    rawInput,
    content: [],
    ...over,
  }) as ToolItem;

const finding = (over: object = {}) => ({
  file: "src/a.ts",
  line: 3,
  summary: "It breaks.",
  failure_scenario: "When empty.",
  ...over,
});

test("a review's findings are read from the call's input, the surest first and otherwise in the agent's order", () => {
  const review = reviewOf(
    call({
      level: "high",
      findings: [
        finding({ summary: "none" }),
        finding({ summary: "plausible", verdict: "PLAUSIBLE" }),
        finding({
          summary: "confirmed 1",
          verdict: "CONFIRMED",
          short_summary: "c1",
          category: "correctness",
        }),
        finding({ summary: "confirmed 2", verdict: "CONFIRMED", outcome: "fixed" }),
      ],
    }),
  );
  expect(review?.level).toBe("high");
  expect(review?.findings.map((f) => f.summary)).toEqual([
    "confirmed 1",
    "confirmed 2",
    "plausible",
    "none",
  ]);
  expect(review?.findings[0]).toEqual({
    file: "src/a.ts",
    line: 3,
    summary: "confirmed 1",
    short: "c1",
    scenario: "When empty.",
    category: "correctness",
    verdict: "confirmed",
  });
  expect(review && reviewTally(review)).toEqual({ total: 4, confirmed: 2, plausible: 1, fixed: 1 });
});

test("a review with no findings is a review that found nothing", () => {
  expect(reviewOf(call({ findings: [] }))).toEqual({ findings: [] });
});

test("anything not in the shape of a review is not one, and is drawn as a call", () => {
  expect(reviewOf(call({ findings: [finding()] }, { name: "Bash" }))).toBeUndefined();
  expect(reviewOf(call(undefined))).toBeUndefined();
  expect(reviewOf(call({ findings: "none" }))).toBeUndefined();
  expect(reviewOf(call({ findings: [finding(), { file: "a.ts" }] }))).toBeUndefined();
  expect(reviewOf(call({ findings: [finding({ summary: 3 })] }))).toBeUndefined();
  expect(reviewOf(call({ findings: Array.from({ length: 33 }, () => finding()) }))).toBeUndefined();
  expect(reviewOf(call({ findings: [finding()] }, { status: "failed" }))).toBeUndefined();
});

test("what is odd in a finding is left out rather than shown", () => {
  const review = reviewOf(
    call({
      level: "<b>huge</b>",
      findings: [
        finding({ line: -1, verdict: "SURE", outcome: "deleted", summary: "x".repeat(5000) }),
      ],
    }),
  );
  expect(review?.level).toBeUndefined();
  const [only] = review?.findings ?? [];
  expect(only?.line).toBeUndefined();
  expect(only?.verdict).toBeUndefined();
  expect(only?.outcome).toBeUndefined();
  expect(only?.summary.length).toBe(4000);
});

test("a review is a block of its own, which cuts the stretch of calls around it", () => {
  const u = (update: object) => update as SessionUpdate;
  const tool = (id: string, name: string, rawInput: object = {}) =>
    u({ sessionUpdate: "tool_call_update", toolCallId: id, name, status: "completed", rawInput });
  const c = reduce([
    u({ sessionUpdate: "user_message", messageId: "u", content: [{ type: "text", text: "u" }] }),
    u({ sessionUpdate: "state_update", state: "running" }),
    tool("a", "Bash"),
    tool("r", "ReportFindings", { findings: [finding()] }),
    tool("b", "Bash"),
    // Not a review: a call as any other, in the stretch.
    tool("x", "ReportFindings", { findings: "?" }),
  ]);
  expect(
    blocksOf(c).map((b) =>
      b.kind === "work" ? `work(${b.tools.map((t) => t.id).join(",")})` : b.kind,
    ),
  ).toEqual(["user", "work(a)", "review", "work(b,x)"]);
});
