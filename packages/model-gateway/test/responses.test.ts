import { expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  failure,
  type ResponsesRequest,
  toResponseEvents,
  toContext as translate,
} from "../src/responses.ts";

const ORIGIN = {
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m",
  contextWindow: 200_000,
};
const toContext = (request: ResponsesRequest, now: number, origin = ORIGIN) =>
  translate(request, now, origin);

const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const developer = (text: string) => ({
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text }],
});

const message = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m",
  usage: {
    input: 10,
    output: 4,
    cacheRead: 30,
    cacheWrite: 5,
    reasoning: 2,
    totalTokens: 49,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

async function* play(events: AssistantMessageEvent[]) {
  yield* events;
}

async function collect(
  events: AssistantMessageEvent[],
  names = toContext({ model: "m", input: [] }, 0).names,
) {
  const out = [];
  for await (const event of toResponseEvents(play(events), "r1", names, ORIGIN)) out.push(event);
  return out;
}

test("instructions before the conversation become the system prompt; later ones stay in place", () => {
  const { context } = toContext(
    {
      model: "m",
      instructions: "Base.",
      input: [developer("Rules."), user("hi"), developer("Switched."), user("again")],
    },
    7,
  );
  expect(context.systemPrompt).toBe("Base.\n\nRules.");
  expect(context.messages.map((entry) => entry.role)).toEqual(["user", "system", "user"]);
  expect(context.messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "hi" }],
    timestamp: 7,
  });
});

test("the items of one answer are gathered into one assistant message, and results follow it", () => {
  const { context } = toContext(
    {
      model: "m",
      input: [
        user("do it"),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "On it." }] },
        { type: "function_call", call_id: "c1", name: "exec_command", arguments: '{"cmd":"ls"}' },
        {
          type: "function_call",
          call_id: "c2",
          name: "spawn_agent",
          namespace: "agents",
          arguments: "{",
        },
        { type: "function_call_output", call_id: "c1", output: "a.txt" },
        {
          type: "function_call_output",
          call_id: "c2",
          output: [{ type: "input_text", text: "spawned" }],
        },
      ],
    },
    0,
  );
  expect(context.messages.map((entry) => entry.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "toolResult",
  ]);
  const assistant = context.messages[1];
  if (assistant?.role !== "assistant") throw new Error("expected the assistant");
  expect(assistant.stopReason).toBe("toolUse");
  expect(assistant.content).toEqual([
    { type: "text", text: "On it." },
    { type: "toolCall", id: "c1", name: "exec_command", arguments: { cmd: "ls" } },
    // Arguments that are not JSON are an empty call, not a failed request.
    { type: "toolCall", id: "c2", name: "agents__spawn_agent", arguments: {} },
  ]);
  expect(context.messages[3]).toMatchObject({
    toolCallId: "c2",
    toolName: "agents__spawn_agent",
    content: [{ type: "text", text: "spawned" }],
  });
});

test("tools are flattened out of namespaces, free text tools take one input, others are left out", () => {
  const { context, names } = toContext(
    {
      model: "m",
      input: [],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run",
          parameters: { type: "object" },
        },
        { type: "namespace", name: "agents", tools: [{ type: "function", name: "spawn_agent" }] },
        { type: "custom", name: "apply_patch", description: "Patch" },
        { type: "web_search" },
      ],
    },
    0,
  );
  expect(context.tools?.map((tool) => tool.name)).toEqual([
    "exec_command",
    "agents__spawn_agent",
    "apply_patch",
  ]);
  expect(names.namespaced.get("agents__spawn_agent")).toEqual({
    namespace: "agents",
    name: "spawn_agent",
  });
  expect(names.freeform.has("apply_patch")).toBe(true);
});

test("an image comes through as data, and the effort only when it is one pi-ai knows", () => {
  const request = {
    model: "m",
    prompt_cache_key: "thread-1",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_image", image_url: "https://example.test/a.png" },
        ],
      },
    ],
  };
  const high = toContext({ ...request, reasoning: { effort: "high" } }, 0);
  expect(high.effort).toBe("high");
  expect(toContext({ ...request, reasoning: { effort: "max" } }, 0).effort).toBe("max");
  expect(high.sessionId).toBe("thread-1");
  expect(high.context.messages[0]).toMatchObject({
    content: [
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: "[an image that could not be attached]" },
    ],
  });
  expect(toContext({ ...request, reasoning: { effort: "none" } }, 0).effort).toBeNull();
});

test("an answer becomes the events codex reads, with thinking that returns to its provider intact", async () => {
  const thinking = { type: "thinking", thinking: "hmm", thinkingSignature: "SIG" } as const;
  const text = { type: "text", text: "Hello" } as const;
  const call = {
    type: "toolCall",
    id: "c9",
    name: "agents__spawn_agent",
    arguments: { n: 1 },
  } as const;
  const final = message([thinking, text, call]);
  const { names } = toContext(
    {
      model: "m",
      input: [],
      tools: [
        { type: "namespace", name: "agents", tools: [{ type: "function", name: "spawn_agent" }] },
      ],
    },
    0,
  );
  const events = await collect(
    [
      { type: "start", partial: final },
      { type: "thinking_start", contentIndex: 0, partial: final },
      { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: final },
      { type: "thinking_end", contentIndex: 0, content: "hmm", partial: final },
      { type: "text_start", contentIndex: 1, partial: final },
      { type: "text_delta", contentIndex: 1, delta: "Hello", partial: final },
      { type: "text_end", contentIndex: 1, content: "Hello", partial: final },
      { type: "toolcall_end", contentIndex: 2, toolCall: call, partial: final },
      { type: "done", reason: "toolUse", message: final },
    ],
    names,
  );
  expect(events.map((event) => event.type)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.output_item.done",
    "response.output_item.added",
    "response.output_text.delta",
    "response.output_item.done",
    "response.output_item.done",
    "response.completed",
  ]);
  expect(events.at(-2)?.item).toMatchObject({
    type: "function_call",
    call_id: "c9",
    namespace: "agents",
    name: "spawn_agent",
    arguments: '{"n":1}',
  });
  // What was read from the cache counts as input, as OpenAI counts it.
  expect(events.at(-1)?.response).toMatchObject({
    usage: {
      input_tokens: 45,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 49,
    },
  });

  // Next turn codex sends the reasoning item back: the model gets its own block again, in an
  // answer marked as its own, which is what makes pi-ai send the block on.
  const reasoning = events[4]?.item as Record<string, unknown>;
  const history = [
    reasoning,
    { type: "function_call", call_id: "c9", name: "x", arguments: "{}" },
    { type: "reasoning", encrypted_content: "gAAAA-openai" },
  ];
  const again = toContext({ model: "m", input: history }, 0).context.messages[0];
  if (again?.role !== "assistant") throw new Error("expected the assistant");
  expect(again.content[0]).toEqual(thinking);
  expect(again).toMatchObject({ api: "anthropic-messages", provider: "anthropic", model: "m" });

  // Asked of another model, the thinking stays behind and the answer is a stranger's.
  const other = { ...ORIGIN, provider: "google", api: "google-generative-ai" };
  const moved = toContext({ model: "m", input: history }, 0, other).context.messages[0];
  if (moved?.role !== "assistant") throw new Error("expected the assistant");
  expect(moved.content.map((block) => block.type)).toEqual(["toolCall"]);
  expect(moved.provider).toBe("cycle");
});

test("a free text tool's call goes back as text, not JSON", async () => {
  const call = {
    type: "toolCall",
    id: "c1",
    name: "apply_patch",
    arguments: { input: "*** Begin" },
  } as const;
  const { names } = toContext(
    { model: "m", input: [], tools: [{ type: "custom", name: "apply_patch" }] },
    0,
  );
  const events = await collect(
    [{ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message([call]) }],
    names,
  );
  expect(events.at(-1)?.item).toMatchObject({
    type: "custom_tool_call",
    call_id: "c1",
    name: "apply_patch",
    input: "*** Begin",
  });
});

test("a provider's failure is reported, a stopped request is not, and too long a conversation is named", async () => {
  const failed = { ...message([]), stopReason: "error", errorMessage: "401: bad key" } as const;
  const events = await collect([{ type: "error", reason: "error", error: failed }]);
  expect(events.at(-1)).toMatchObject({
    type: "response.failed",
    response: { error: { code: "server_error", message: "401: bad key" } },
  });
  const stopped = await collect([{ type: "error", reason: "aborted", error: failed }]);
  expect(stopped.map((event) => event.type)).toEqual(["response.created"]);
  // What pi-ai knows as "too long for the model" is named, so codex compacts and asks again.
  const long = { ...failed, errorMessage: "prompt is too long: 250000 tokens > 200000 maximum" };
  const overflow = await collect([{ type: "error", reason: "error", error: long }]);
  expect(overflow.at(-1)).toMatchObject({
    response: { error: { code: "context_length_exceeded" } },
  });
  expect(failure("r", "boom")).toMatchObject({ response: { error: { code: "server_error" } } });
});

test("what a model signed on a tool call returns with the call, to that model only", async () => {
  const call = {
    type: "toolCall",
    id: "c1",
    name: "exec_command",
    arguments: {},
    thoughtSignature: "SIGNED",
  } as const;
  const signatures = new Map();
  const names = toContext({ model: "m", input: [] }, 0).names;
  const answer = toResponseEvents(
    play([{ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message([call]) }]),
    "r1",
    names,
    ORIGIN,
    signatures,
  );
  for await (const _ of answer);
  const input = [{ type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" }];
  const back = translate({ model: "m", input }, 0, ORIGIN, signatures).context.messages[0];
  if (back?.role !== "assistant") throw new Error("expected the assistant");
  expect(back.content[0]).toMatchObject({ thoughtSignature: "SIGNED" });
  expect(back.provider).toBe("anthropic");
  const other = { ...ORIGIN, model: "another" };
  const moved = translate({ model: "m", input }, 0, other, signatures).context.messages[0];
  if (moved?.role !== "assistant") throw new Error("expected the assistant");
  expect(moved.content[0]).not.toHaveProperty("thoughtSignature");
});
