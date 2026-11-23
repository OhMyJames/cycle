import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { agentPathInFolder } from "../src/files-view.ts";
import {
  blocksOf,
  isPendingReview,
  reduce,
  reviewOf,
  reviewTally,
  type ToolItem,
} from "../src/model/index.ts";

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

test("a review's findings are read from the call's input, in the agent's order (the most severe first)", () => {
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
    "none",
    "plausible",
    "confirmed 1",
    "confirmed 2",
  ]);
  expect(review?.findings[2]).toEqual({
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

test("a review call on its way shows nothing until its input is a review; ended and not one, it is a call", () => {
  expect(isPendingReview(call(undefined, { status: "pending" }))).toBe(true);
  expect(isPendingReview(call({}, { status: "in_progress" }))).toBe(true);
  expect(isPendingReview(call({ findings: [] }, { status: "in_progress" }))).toBe(false);
  expect(isPendingReview(call({}, { status: "completed" }))).toBe(false);
  expect(isPendingReview(call({}, { name: "Bash", status: "pending" }))).toBe(false);
  const u = (update: object) => update as SessionUpdate;
  const c = reduce([
    u({ sessionUpdate: "user_message", messageId: "u", content: [{ type: "text", text: "u" }] }),
    u({ sessionUpdate: "state_update", state: "running" }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "r",
      name: "ReportFindings",
      status: "pending",
    }),
  ]);
  expect(blocksOf(c).map((b) => b.kind)).toEqual(["user"]);
});

test("a finding's path is in the folder when it is relative, ./-led, absolute or a file URI under it", () => {
  expect(agentPathInFolder("src/a.ts", "/work")).toBe("src/a.ts");
  expect(agentPathInFolder("./src/a.ts", "/work/")).toBe("src/a.ts");
  expect(agentPathInFolder("/work/src/a.ts", "/work")).toBe("src/a.ts");
  expect(agentPathInFolder("file:///work/src/a.ts", "/work")).toBe("src/a.ts");
  expect(agentPathInFolder("../up.ts", "/work")).toBeUndefined();
  expect(agentPathInFolder("/etc/hosts", "/work")).toBeUndefined();
  expect(agentPathInFolder("C:\\repo\\a.ts", "/work")).toBeUndefined();
  expect(agentPathInFolder("src\\a.ts", "/work")).toBeUndefined();
});

// The code-review skill's result, in the shape every recorded session has it (CYCL-216): the line the skill tool says,
// `Result:`, the agent's words, and the findings as a bare array in a ```json block. The words here are made up.
const skillResult = (body: string, before = "") =>
  `${before}Skill "code-review" completed (forked execution).\n\nResult:\n${body}`;
const fenced = (findings: unknown) => `\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\``;
const skillUpdates = (text: string | undefined, rawInput: object = { skill: "code-review" }) => {
  const u = (update: object) => update as SessionUpdate;
  return [
    u({ sessionUpdate: "user_message", messageId: "u", content: [{ type: "text", text: "u" }] }),
    u({ sessionUpdate: "state_update", state: "running" }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "s", name: "Skill", status: "pending" }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "s",
      name: "Skill",
      kind: "other",
      status: "in_progress",
      rawInput,
    }),
    ...(text === undefined
      ? []
      : [
          u({
            sessionUpdate: "tool_call_update",
            toolCallId: "s",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text } }],
          }),
        ]),
  ];
};
const skillCall = (text: string | undefined, rawInput?: object) => {
  const c = reduce(skillUpdates(text, rawInput));
  return c.items.find((i) => i.kind === "tool") as ToolItem;
};

test("the code-review skill's result is a review: the findings from its JSON block, the words around it kept", () => {
  const tool = skillCall(
    skillResult(
      `Reviewed the branch against main; two things stand out.\n\n${fenced([
        finding({ summary: "First." }),
        finding({ file: "src/b.ts", line: 40, summary: "Second.", verdict: "CONFIRMED" }),
      ])}\n\nThe second is the one to fix first.`,
    ),
    { skill: "code-review", args: "high origin/main...HEAD" },
  );
  const review = reviewOf(tool);
  expect(review?.level).toBe("high");
  expect(review?.findings.map((f) => [f.file, f.line, f.summary, f.verdict])).toEqual([
    ["src/a.ts", 3, "First.", undefined],
    ["src/b.ts", 40, "Second.", "confirmed"],
  ]);
  expect(review?.prose).toBe(
    "Reviewed the branch against main; two things stand out.\n\nThe second is the one to fix first.",
  );
  const blocks = blocksOf(reduce(skillUpdates(skillResult(fenced([finding()])))));
  expect(blocks.map((b) => b.kind)).toEqual(["user", "review"]);
});

test("a skill's review with no words, words only after, a tag before its head, or a plugin's skill name", () => {
  expect(reviewOf(skillCall(skillResult(fenced([finding()]))))?.prose).toBeUndefined();
  const none = reviewOf(skillCall(skillResult(`I found nothing to report.\n\n${fenced([])}`)));
  expect(none).toEqual({ findings: [], prose: "I found nothing to report." });
  const after = reviewOf(skillCall(skillResult(`${fenced([])}\n\nOnly a version bump.`)));
  expect(after?.prose).toBe("Only a version bump.");
  const tagged = skillCall(
    skillResult(
      fenced([finding()]),
      "<tools-used-before-summary>Read</tools-used-before-summary>\n",
    ),
  );
  expect(reviewOf(tagged)?.findings).toHaveLength(1);
  expect(reviewOf(tagged)?.prose).toBeUndefined();
  for (const skill of ["tools:code-review", "/code-review"])
    expect(reviewOf(skillCall(skillResult(fenced([])), { skill }))).toEqual({ findings: [] });
});

test("a skill's result that is not a review in shape is the skill's call, as before", () => {
  const plain = (text: string, rawInput?: object) => {
    const tool = skillCall(text, rawInput);
    expect(reviewOf(tool)).toBeUndefined();
    expect(isPendingReview(tool)).toBe(false);
    expect(blocksOf(reduce(skillUpdates(text, rawInput))).map((b) => b.kind)).toEqual([
      "user",
      "work",
    ]);
  };
  plain(skillResult("(none)"));
  plain(skillResult("```json\n[{ broken\n```"));
  plain(skillResult(fenced({ findings: [finding()] })));
  plain(skillResult(fenced([finding(), { file: "a.ts" }])));
  plain(skillResult(fenced(Array.from({ length: 33 }, () => finding()))));
  plain(skillResult(`${fenced([finding()])}\n\n${fenced([finding()])}`));
  plain(skillResult(fenced([finding()])), { skill: "code-reviewer" });
  plain(skillResult(fenced([finding()])), { skill: "run" });
  plain("Launching skill: code-review");
});

test("a failed or stopped code-review skill is its call; one on its way shows nothing", () => {
  const going = skillCall(undefined);
  expect(isPendingReview(going)).toBe(true);
  expect(blocksOf(reduce(skillUpdates(undefined))).map((b) => b.kind)).toEqual(["user"]);
  for (const status of ["failed", "cancelled"]) {
    const tool = { ...skillCall(skillResult(fenced([finding()]))), status };
    expect(reviewOf(tool)).toBeUndefined();
    expect(isPendingReview(tool)).toBe(false);
  }
  // Another skill on its way is a call like any other.
  expect(isPendingReview(skillCall(undefined, { skill: "run" }))).toBe(false);
});

test("what is odd in a skill's review is cut or left out, as in the tool's", () => {
  const review = reviewOf(
    skillCall(
      skillResult(
        `${"w".repeat(5000)}\n\n${fenced([finding({ summary: "x".repeat(5000), line: 0 })])}`,
      ),
      { skill: "code-review", args: "<b>loud</b> main" },
    ),
  );
  expect(review?.level).toBeUndefined();
  expect(review?.prose?.length).toBe(4000);
  expect(review?.findings[0]?.summary.length).toBe(4000);
  expect(review?.findings[0]?.line).toBeUndefined();
});
