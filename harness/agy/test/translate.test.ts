import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { META, ToolResultSchema } from "@cycle/protocol";
import { applyUpdate, emptyConversation } from "../../../packages/ui/src/model/index.ts";
import { StepsPlans, toV2ToolCallUpdate, translateSimpleUpdate } from "../src/translate.ts";
import type { V1SessionUpdate, V1ToolCallPayload } from "../src/v1.ts";

const translate = (update: Record<string, unknown>, messageId = "m1") =>
  translateSimpleUpdate(update as V1SessionUpdate, messageId, "agy-1-plan", () => {
    throw new Error(`unexpected unknown update ${String(update.sessionUpdate)}`);
  });

describe("v1 tool calls to v2", () => {
  test("a tool_call_update carries only what agy sent, so it never resets the title, kind or status", () => {
    const start = translate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      name: "run_command",
      kind: "execute",
      title: "npm test",
    });
    expect(start).toMatchObject({ title: "npm test", kind: "execute", status: "pending" });

    const progress = translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "in_progress",
    });
    expect(progress).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "in_progress",
    } as SessionUpdate);

    const result = translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
    expect(result).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("kind");
    expect(result).not.toHaveProperty("status");

    let conv = emptyConversation();
    for (const update of [start, progress, result]) {
      if (update) conv = applyUpdate(conv, update);
    }
    expect(conv.ignored).toBe(0);
    const tool = conv.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ title: "npm test", status: "in_progress" });
  });

  test("a tool_call without fields gets defaults; a sub-agent update without its role keeps the readable title", () => {
    expect(toV2ToolCallUpdate({ toolCallId: "c2" })).toMatchObject({
      title: "Tool",
      kind: "other",
      status: "pending",
    });
    const sub = toV2ToolCallUpdate(
      {
        toolCallId: "s1",
        name: "invoke_subagent",
        title: "invoke_subagent",
        rawInput: { Role: "Researcher" },
      },
      true,
    );
    expect(sub).toMatchObject({ title: "Sub-agent: Researcher" });
    const later = toV2ToolCallUpdate(
      { toolCallId: "s1", name: "invoke_subagent", title: "invoke_subagent", status: "completed" },
      false,
    );
    expect(later).not.toHaveProperty("title");
  });

  test("an MCP tool call keeps agy's own title and passes its text content block through (no server name to split)", () => {
    const update = toV2ToolCallUpdate({
      toolCallId: "m1",
      name: "mcp_plan_get_issue",
      title: "get_issue",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Issue CYC-1" } }],
    });
    expect(update).toMatchObject({
      name: "mcp_plan_get_issue",
      title: "get_issue",
      content: [{ type: "content", content: { type: "text", text: "Issue CYC-1" } }],
    });
    const bare = toV2ToolCallUpdate({ toolCallId: "m2", name: "mcp_plan_get_issue" });
    expect(bare).toMatchObject({ title: "mcp_plan_get_issue" });
  });

  test("PascalCase tool inputs are normalized to standard ACP rawInput keys without duplication", () => {
    const cmd = toV2ToolCallUpdate({
      toolCallId: "r1",
      name: "run_command",
      kind: "execute",
      title: "git status",
      rawInput: { CommandLine: "git status", Cwd: "/repo", WaitMsBeforeAsync: 5000 },
    }) as { rawInput?: Record<string, unknown> };
    expect(cmd.rawInput).toEqual({ command: "git status", cwd: "/repo", WaitMsBeforeAsync: 5000 });

    const read = toV2ToolCallUpdate({
      toolCallId: "f1",
      name: "read_file",
      kind: "read",
      rawInput: { Path: "/repo/src/index.ts", StartLine: 1 },
    }) as { rawInput?: Record<string, unknown> };
    expect(read.rawInput).toEqual({ file_path: "/repo/src/index.ts", StartLine: 1 });

    const search = toV2ToolCallUpdate({
      toolCallId: "q1",
      name: "search_web",
      kind: "search",
      rawInput: { Query: "bun test", Url: "https://bun.sh", Pattern: "foo" },
    }) as { rawInput?: Record<string, unknown> };
    expect(search.rawInput).toEqual({ query: "bun test", url: "https://bun.sh", pattern: "foo" });
  });
});

describe("v1 plan to v2", () => {
  test("every plan of a session has the same id, so a new plan replaces the one shown", () => {
    const entries = [{ content: "step", status: "pending" }];
    const first = translate({ sessionUpdate: "plan", entries }, "m1");
    const second = translate(
      { sessionUpdate: "plan", entries: [{ content: "step", status: "completed" }] },
      "m2",
    );
    expect((first as { plan: { planId: string } }).plan.planId).toBe("agy-1-plan");
    expect((second as { plan: { planId: string } }).plan.planId).toBe("agy-1-plan");

    let conv = emptyConversation();
    for (const update of [first, second]) if (update) conv = applyUpdate(conv, update);
    expect(conv.ignored).toBe(0);
    expect(conv.items.filter((item) => item.kind === "plan")).toHaveLength(1);
  });
});

test("update_steps is agy's plan: its calls are marked, and the finished one replaces the plan", () => {
  // As a real agy session sends it: the whole list each time, `{ title, status }`.
  const steps = [
    { status: "done", title: "Research" },
    { status: "in_progress", title: "Implement" },
    { status: "pending", title: "Test" },
    { status: "failed", title: "Benchmark" },
    { status: "pending" },
  ];
  const plans = new StepsPlans();
  const start = {
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    name: "update_steps",
    kind: "other",
    status: "in_progress",
    rawInput: { steps },
  } as V1ToolCallPayload;
  // The steps are shown as soon as the call has them, not when it ends (CYC-295).
  const early = plans.see(start, "s-plan");
  expect(early.plan).toBe(true);
  expect(early.update).toBeDefined();
  // An update carries only what changed: no name, no steps, still the plan's call, and nothing new to say.
  expect(plans.see({ toolCallId: "call_1", kind: "other" } as V1ToolCallPayload, "s-plan")).toEqual(
    { plan: true },
  );
  // The call ends with the same steps: the plan is not sent twice.
  expect(
    plans.see({ toolCallId: "call_1", status: "completed" } as V1ToolCallPayload, "s-plan"),
  ).toEqual({ plan: true });
  // A call that carries its steps only when it ends still makes its plan then.
  plans.see({ ...start, toolCallId: "call_4", rawInput: {} }, "s-plan");
  expect(
    plans.see(
      { toolCallId: "call_4", status: "completed", rawInput: { steps } } as V1ToolCallPayload,
      "s-plan",
    ),
  ).toEqual({
    plan: true,
    update: {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "s-plan",
        // A step with no title is left out.
        entries: [
          { content: "Research", priority: "medium", status: "completed" },
          { content: "Implement", priority: "medium", status: "in_progress" },
          { content: "Test", priority: "medium", status: "pending" },
          { content: "Benchmark", priority: "medium", status: "completed" },
        ],
      },
    } as SessionUpdate,
  });
  // A failed call changed nothing; another tool is not the plan's.
  plans.see({ ...start, toolCallId: "call_2", rawInput: {} }, "s-plan");
  expect(
    plans.see({ toolCallId: "call_2", status: "failed" } as V1ToolCallPayload, "s-plan"),
  ).toEqual({ plan: true });
  expect(
    plans.see(
      { ...start, toolCallId: "call_3", name: "manage_task", status: "completed" },
      "s-plan",
    ),
  ).toEqual({ plan: false });
});

describe("read-file result numbers (rawOutput shape unverified)", () => {
  const read = (status: string | undefined, rawOutput: unknown) =>
    toV2ToolCallUpdate(
      { toolCallId: "r1", name: "read_file", kind: "read", status, rawOutput } as V1ToolCallPayload,
      false,
    ) as { _meta?: Record<string, unknown>; rawOutput?: unknown };

  test("a completed read with a range fills read, without content", () => {
    const u = read("completed", { start_line: 5, num_lines: 20, content: "secret" });
    const meta = u._meta?.[META.toolResult];
    expect(meta).toEqual({ read: { startLine: 5, numLines: 20 } });
    expect(() => ToolResultSchema.parse(meta)).not.toThrow();
  });

  test("totalLines is added only when given", () => {
    const u = read("completed", { start_line: 1, num_lines: 10, total_lines: 99 });
    const meta = u._meta?.[META.toolResult];
    expect(meta).toEqual({ read: { startLine: 1, numLines: 10, totalLines: 99 } });
    expect(() => ToolResultSchema.parse(meta)).not.toThrow();
  });

  test("missing or invalid numbers fill nothing and keep the rest", () => {
    for (const raw of [
      undefined,
      "text",
      {},
      { start_line: 1 },
      { start_line: "1", num_lines: 2 },
      { start_line: 1.5, num_lines: 2 },
      { start_line: -1, num_lines: 2 },
    ]) {
      const u = read("completed", raw);
      expect(u._meta).toBeUndefined();
      expect(u.rawOutput).toEqual(raw);
    }
    const bad = read("completed", { start_line: 1, num_lines: 2, total_lines: -3 });
    expect(bad._meta?.[META.toolResult]).toEqual({ read: { startLine: 1, numLines: 2 } });
  });

  test("failed or unfinished reads fill nothing", () => {
    for (const status of ["failed", "in_progress", "pending", undefined]) {
      expect(read(status, { start_line: 1, num_lines: 2 })._meta).toBeUndefined();
    }
  });
});

describe("search result numbers (rawOutput shape unverified)", () => {
  const search = (status: string | undefined, rawOutput: unknown) =>
    toV2ToolCallUpdate(
      {
        toolCallId: "s1",
        name: "grep_search",
        kind: "search",
        status,
        rawOutput,
      } as V1ToolCallPayload,
      false,
    ) as { _meta?: Record<string, unknown>; rawOutput?: unknown };

  test("a completed search with counts fills search, without hit text", () => {
    const u = search("completed", {
      num_files: 3,
      num_matches: 7,
      num_lines: 7,
      truncated: true,
      output: "secret hit",
    });
    const meta = u._meta?.[META.toolResult];
    expect(meta).toEqual({ search: { files: 3, matches: 7, lines: 7, more: true } });
    expect(() => ToolResultSchema.parse(meta)).not.toThrow();
  });

  test("only files is enough", () => {
    const meta = search("completed", { num_files: 0 })._meta?.[META.toolResult];
    expect(meta).toEqual({ search: { files: 0 } });
    expect(() => ToolResultSchema.parse(meta)).not.toThrow();
  });

  test("missing or invalid numbers fill nothing and keep the rest", () => {
    for (const raw of [
      undefined,
      "text",
      {},
      { num_matches: 4 },
      { num_files: "2" },
      { num_files: 1.5 },
      { num_files: -1 },
    ]) {
      const u = search("completed", raw);
      expect(u._meta).toBeUndefined();
      expect(u.rawOutput).toEqual(raw);
    }
    const bad = search("completed", { num_files: 2, num_matches: -1, truncated: "yes" });
    expect(bad._meta?.[META.toolResult]).toEqual({ search: { files: 2 } });
  });

  test("failed or unfinished searches fill nothing", () => {
    for (const status of ["failed", "in_progress", "pending", undefined]) {
      expect(search(status, { num_files: 1 })._meta).toBeUndefined();
    }
  });
});
