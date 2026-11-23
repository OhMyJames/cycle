import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { applyUpdate, emptyConversation } from "../../../packages/ui/src/model/index.ts";
import { toV2ToolCallUpdate, translateSimpleUpdate } from "../src/translate.ts";
import type { V1SessionUpdate } from "../src/v1.ts";

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
