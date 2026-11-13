import { expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { toContext, toResponseEvents } from "../src/responses.ts";

const ORIGIN = { api: "anthropic-messages", provider: "anthropic", model: "m" };

const SEARCH = {
  type: "tool_search",
  execution: "client",
  description: "Searches over deferred tools.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const FOUND = [
  {
    type: "namespace",
    name: "mcp__docs",
    tools: [
      { type: "function", name: "fetch", defer_loading: true, parameters: { type: "object" } },
      { type: "function", name: "search", defer_loading: true, parameters: { type: "object" } },
    ],
  },
];

test("tool search is offered as a function, and what it found joins the tools for good", () => {
  const { context, names } = toContext(
    {
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "read the docs" }] },
        {
          type: "tool_search_call",
          call_id: "s1",
          execution: "client",
          status: "completed",
          arguments: { query: "docs" },
        },
        { type: "tool_search_output", call_id: "s1", status: "completed", tools: FOUND },
      ],
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }, SEARCH],
    },
    0,
    ORIGIN,
  );
  expect(context.tools?.map((tool) => tool.name)).toEqual([
    "exec_command",
    "tool_search",
    "mcp__docs__fetch",
    "mcp__docs__search",
  ]);
  expect(context.tools?.[1]?.parameters).toEqual(SEARCH.parameters);
  expect(names.namespaced.get("mcp__docs__fetch")).toEqual({
    namespace: "mcp__docs",
    name: "fetch",
  });
  // The search is a call and its result like any other, so the model sees what it asked.
  expect(context.messages.slice(1)).toMatchObject([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "s1", name: "tool_search", arguments: { query: "docs" } }],
    },
    {
      role: "toolResult",
      toolCallId: "s1",
      toolName: "tool_search",
      content: [
        {
          type: "text",
          text: "Found these tools, which can be called now: mcp__docs__fetch, mcp__docs__search.",
        },
      ],
    },
  ]);
});

test("a tool offered twice is given once, and a search that found nothing says so", () => {
  const { context } = toContext(
    {
      model: "m",
      input: [
        { type: "tool_search_call", call_id: "s1", arguments: '{"query":"x"}' },
        { type: "tool_search_output", call_id: "s1", tools: [] },
        { type: "tool_search_call", call_id: "s2", arguments: { query: "docs" } },
        { type: "tool_search_output", call_id: "s2", tools: FOUND },
        { type: "tool_search_call", call_id: "s3", arguments: { query: "docs again" } },
        { type: "tool_search_output", call_id: "s3", tools: FOUND },
      ],
      tools: [SEARCH],
    },
    0,
    ORIGIN,
  );
  expect(context.tools?.map((tool) => tool.name)).toEqual([
    "tool_search",
    "mcp__docs__fetch",
    "mcp__docs__search",
  ]);
  expect(context.messages[0]).toMatchObject({ content: [{ arguments: { query: "x" } }] });
  expect(context.messages[1]).toMatchObject({
    content: [{ text: "No tools matched. Try other words." }],
  });
});

async function* play(events: AssistantMessageEvent[]) {
  yield* events;
}

test("the model's search goes back to codex as a tool search call, for codex to run", async () => {
  const call = {
    type: "toolCall",
    id: "s1",
    name: "tool_search",
    arguments: { query: "docs", limit: 4 },
  } as const;
  const partial: AssistantMessage = {
    role: "assistant",
    content: [call],
    api: ORIGIN.api,
    provider: ORIGIN.provider,
    model: ORIGIN.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const event = { type: "toolcall_end", contentIndex: 0, toolCall: call, partial } as const;
  const offered = toContext({ model: "m", input: [], tools: [SEARCH] }, 0, ORIGIN).names;
  const notOffered = toContext({ model: "m", input: [], tools: [] }, 0, ORIGIN).names;
  const items = async (names: typeof offered) => {
    const out = [];
    const origin = { ...ORIGIN, contextWindow: 1000 };
    for await (const each of toResponseEvents(play([event]), "r1", names, origin)) out.push(each);
    return out.at(-1)?.["item"];
  };
  expect(await items(offered)).toEqual({
    type: "tool_search_call",
    id: "fc_r1_0",
    call_id: "s1",
    status: "completed",
    execution: "client",
    arguments: { query: "docs", limit: 4 },
  });
  // Where codex offered no search, a tool of that name is an ordinary function.
  expect(await items(notOffered)).toMatchObject({ type: "function_call", name: "tool_search" });
});
