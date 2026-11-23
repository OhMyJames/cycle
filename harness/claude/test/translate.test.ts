import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { PlanState, stopReasonOf, TurnTranslator, toolKind } from "../src/index.ts";
import { textTurn } from "./fake-query.ts";

const feedAll = (messages: SDKMessage[]) => {
  const translator = new TurnTranslator();
  return messages.flatMap((m) => translator.feed(m));
};

test("streams text as chunks and does not repeat it in the whole message", () => {
  const updates = feedAll(textTurn("s", "msg_1", "Hello there"));
  expect(updates.map((u) => u.sessionUpdate)).toEqual([
    "agent_message_chunk",
    "agent_message_chunk",
  ]);
  const text = updates.map((u) => (u as { content: { text: string } }).content.text).join("");
  expect(text).toBe("Hello there");
  expect(updates.every((u) => (u as { messageId: string }).messageId === "msg_1")).toBe(true);
});

test("sends a whole message that was never streamed", () => {
  const updates = feedAll([
    {
      type: "assistant",
      message: { id: "msg_2", content: [{ type: "text", text: "From a cache" }] },
    } as unknown as SDKMessage,
  ]);
  expect(updates).toEqual([
    {
      sessionUpdate: "agent_message",
      messageId: "msg_2",
      content: [{ type: "text", text: "From a cache" }],
    },
  ]);
});

test("sends the thinking of a whole message that was never streamed, but not an omitted one", () => {
  const updates = feedAll([
    {
      type: "assistant",
      message: {
        id: "msg_3",
        content: [
          { type: "thinking", thinking: "Weighing it", signature: "x" },
          { type: "thinking", thinking: "", signature: "y" },
          { type: "text", text: "Done" },
        ],
      },
    } as unknown as SDKMessage,
  ]);
  expect(updates).toEqual([
    {
      sessionUpdate: "agent_thought",
      messageId: "msg_3",
      content: [{ type: "text", text: "Weighing it" }],
    },
    {
      sessionUpdate: "agent_message",
      messageId: "msg_3",
      content: [{ type: "text", text: "Done" }],
    },
  ]);
});

test("streams thinking as thought chunks", () => {
  const updates = feedAll([
    { type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
    },
  ] as unknown as SDKMessage[]);
  expect(updates.map((u) => u.sessionUpdate)).toEqual(["agent_thought_chunk"]);
});

test("follows a tool call from pending to its result", () => {
  const updates = feedAll([
    { type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Bash" },
      },
    },
    {
      type: "assistant",
      message: {
        id: "m",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
    },
  ] as unknown as SDKMessage[]);
  expect(updates.map((u) => (u as { status?: string }).status)).toEqual([
    "pending",
    "in_progress",
    "completed",
  ]);
  expect(updates[0]).toMatchObject({ toolCallId: "t1", name: "Bash", kind: "execute" });
  expect(updates[1]).toMatchObject({ rawInput: { command: "ls" } });
  expect(updates[2]).toMatchObject({
    content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
  });
});

test("a failed tool result is failed", () => {
  const [update] = feedAll([
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
      },
    } as unknown as SDKMessage,
  ]);
  expect(update).toMatchObject({ status: "failed" });
});

test("maps how a turn ended", () => {
  const result = (extra: object) => ({ type: "result", ...extra }) as unknown as SDKMessage;
  expect(stopReasonOf(result({ subtype: "success", stop_reason: "end_turn" }))).toEqual({
    stopReason: "end_turn",
  });
  expect(stopReasonOf(result({ subtype: "success", stop_reason: "max_tokens" }))).toEqual({
    stopReason: "max_tokens",
  });
  expect(stopReasonOf(result({ subtype: "error_max_turns" }))).toEqual({
    stopReason: "max_turn_requests",
  });
  expect(stopReasonOf(result({ subtype: "error_during_execution" }))).toMatchObject({
    stopReason: "error",
  });
  // A turn that ended on an API error is "success" with is_error: an error, saying what the API said.
  expect(
    stopReasonOf(
      result({
        subtype: "success",
        is_error: true,
        stop_reason: null,
        result: "API Error: 401 invalid key",
      }),
    ),
  ).toEqual({
    stopReason: "error",
    error: { code: -32603, message: "API Error: 401 invalid key" },
  });
  expect(
    stopReasonOf(result({ subtype: "success", is_error: true, result: "", api_error_status: 529 })),
  ).toEqual({ stopReason: "error", error: { code: -32603, message: "API error 529" } });
  // With a status the text is not said again: the turn already shows it as the agent's message.
  expect(
    stopReasonOf(
      result({
        subtype: "success",
        is_error: true,
        result: "API Error: 401 invalid key\nmore",
        api_error_status: 401,
      }),
    ),
  ).toEqual({ stopReason: "error", error: { code: -32603, message: "API error 401" } });
});

test("TodoWrite becomes a plan: the whole list, with the statuses ACP knows", () => {
  const updates = feedAll([
    {
      type: "assistant",
      message: {
        id: "m",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Read it", status: "completed", activeForm: "Reading" },
                { content: "Fix it", status: "in_progress", activeForm: "Fixing" },
                { content: "Test it", status: "something-new", activeForm: "Testing" },
              ],
            },
          },
        ],
      },
    } as unknown as SDKMessage,
  ]);
  const plan = updates.find((u) => u.sessionUpdate === "plan_update") as unknown as {
    plan: { type: string; planId: string; entries: { content: string; status: string }[] };
  };
  expect(plan.plan.type).toBe("items");
  expect(plan.plan.entries.map((e) => [e.content, e.status])).toEqual([
    ["Read it", "completed"],
    ["Fix it", "in_progress"],
    ["Test it", "pending"],
  ]);
});

test("a turn ends with the context used, the window, and the cost; a sub-agent's calls do not count", () => {
  const translator = new TurnTranslator();
  const call = (usage: object, parent: string | null) =>
    ({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { id: "m", content: [], usage },
    }) as unknown as SDKMessage;
  translator.feed(
    call(
      {
        input_tokens: 10,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 5,
        output_tokens: 20,
      },
      null,
    ),
  );
  translator.feed(call({ input_tokens: 99999, output_tokens: 1 }, "toolu_sub"));
  const usage = translator.usageOf({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.0123,
    modelUsage: { "claude-haiku": { contextWindow: 200000 } },
  } as unknown as SDKMessage);
  expect(usage).toEqual({
    sessionUpdate: "usage_update",
    used: 125,
    size: 200000,
    cost: { amount: 0.0123, currency: "USD" },
  } as never);
  // Nothing to say without a window to say it against.
  expect(
    new TurnTranslator().usageOf({ type: "result", subtype: "success" } as unknown as SDKMessage),
  ).toBeUndefined();
});

test("TaskCreate and TaskUpdate keep one plan across turns", () => {
  const plan = new PlanState();
  const use = (id: string, name: string, input: object) =>
    ({
      type: "assistant",
      message: { id: `m${id}`, content: [{ type: "tool_use", id, name, input }] },
    }) as unknown as SDKMessage;
  const result = (id: string, text: string, structured: object) =>
    ({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
      tool_use_result: structured,
    }) as unknown as SDKMessage;
  const entries = (updates: { sessionUpdate: string }[]) =>
    (
      updates.filter((u) => u.sessionUpdate === "plan_update").at(-1) as unknown as
        | { plan: { entries: { content: string; status: string }[] } }
        | undefined
    )?.plan.entries.map((e) => [e.content, e.status]);

  const first = new TurnTranslator(plan);
  expect(
    entries(first.feed(use("a", "TaskCreate", { subject: "first", description: "d" }))),
  ).toBeUndefined(); // the id is only in the result
  expect(
    entries(
      first.feed(
        result("a", "Task #1 created successfully: first", { task: { id: "1", subject: "first" } }),
      ),
    ),
  ).toEqual([["first", "pending"]]);
  first.feed(use("b", "TaskCreate", { subject: "second", description: "d" }));
  expect(
    entries(
      first.feed(
        result("b", "Task #2 created successfully: second", {
          task: { id: "2", subject: "second" },
        }),
      ),
    ),
  ).toEqual([
    ["first", "pending"],
    ["second", "pending"],
  ]);

  // A later turn, a new translator, the same session's plan.
  const later = new TurnTranslator(plan);
  later.feed(use("c", "TaskUpdate", { taskId: "1", status: "completed" }));
  expect(
    entries(later.feed(result("c", "Updated task #1 status", { success: true, taskId: "1" }))),
  ).toEqual([
    ["first", "completed"],
    ["second", "pending"],
  ]);
  later.feed(use("d", "TaskUpdate", { taskId: "2", status: "deleted" }));
  expect(
    entries(later.feed(result("d", "Updated task #2", { success: true, taskId: "2" }))),
  ).toEqual([["first", "completed"]]);
  // A failed update changes nothing.
  later.feed(use("e", "TaskUpdate", { taskId: "1", status: "pending" }));
  const failed = {
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "e", is_error: true, content: "no such task" }],
    },
  } as unknown as SDKMessage;
  expect(entries(later.feed(failed))).toBeUndefined();
});

test("a sub-agent's text, tool calls and tool results are not the session's: nothing is sent for them", () => {
  const translator = new TurnTranslator();
  const sub = "toolu_agent";
  const updates = [
    {
      type: "stream_event",
      parent_tool_use_id: sub,
      event: { type: "message_start", message: { id: "msg_sub" } },
    },
    {
      type: "stream_event",
      parent_tool_use_id: sub,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Now icons, kit/page" },
      },
    },
    {
      type: "stream_event",
      parent_tool_use_id: sub,
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_sub_bash", name: "Bash" },
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: sub,
      message: {
        id: "msg_sub",
        content: [
          { type: "text", text: "Now icons, kit/page" },
          { type: "tool_use", id: "toolu_sub_bash", name: "Bash", input: { command: "sed" } },
          { type: "tool_use", id: "toolu_sub_todo", name: "TodoWrite", input: { todos: [] } },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: sub,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub_bash", content: "x" }] },
    },
  ].flatMap((m) => translator.feed(m as unknown as SDKMessage));
  expect(updates).toEqual([]);
  // Nothing of it is left to end with the turn either.
  expect(translator.unfinished()).toEqual([]);
});

test("a sub-agent's stream does not take over the main thread's message in the middle of it", () => {
  const translator = new TurnTranslator();
  const event = (event: object, parent: string | null = null) =>
    ({ type: "stream_event", parent_tool_use_id: parent, event }) as unknown as SDKMessage;
  translator.feed(event({ type: "message_start", message: { id: "msg_main" } }));
  translator.feed(event({ type: "message_start", message: { id: "msg_sub" } }, "toolu_agent"));
  const updates = translator.feed(
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
  );
  expect(updates).toEqual([
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_main",
      content: { type: "text", text: "hi" },
    },
  ] as never);
});

test("a tool call that started and got no result ends with the turn, as cancelled; one that finished does not", () => {
  const translator = new TurnTranslator();
  const use = (id: string) =>
    ({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: `m_${id}`, content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
    }) as unknown as SDKMessage;
  translator.feed({
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_streamed", name: "Bash" },
    },
  } as unknown as SDKMessage);
  translator.feed(use("toolu_done"));
  translator.feed(use("toolu_left"));
  translator.feed({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "ok" }] },
  } as unknown as SDKMessage);
  expect(translator.unfinished()).toEqual([
    { sessionUpdate: "tool_call_update", toolCallId: "toolu_streamed", status: "cancelled" },
    { sessionUpdate: "tool_call_update", toolCallId: "toolu_left", status: "cancelled" },
  ] as never);
  // Said once.
  expect(translator.unfinished()).toEqual([]);
});

test("keeping the task list is planning (ACP's think), so a client can let the plan say it", () => {
  for (const name of ["TodoWrite", "TaskCreate", "TaskUpdate", "ToolSearch"])
    expect(toolKind(name)).toBe("think");
  // Reading the list changes nothing the plan shows: a call of its own.
  for (const name of ["TaskGet", "TaskList", "TaskStop"]) expect(toolKind(name)).toBe("other");
});
