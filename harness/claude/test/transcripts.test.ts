// A sub-agent's conversation (CYCL-134, docs/protocol.md §9): told as updates of its own session, the one
// `subagent_update` announced, and asked for permission in that session.
import { expect, test } from "bun:test";
import { client, methods } from "@agentclientprotocol/sdk/experimental/v2";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgent } from "../src/index.ts";
import { type Call, fakeQuery, textTurn } from "./fake-query.ts";

const ID = "5b0c3a3e-8a52-4d3f-9a0e-1c2d3e4f5a6b";

type Seen = { sessionId: string; update: Record<string, unknown> };

/** An ACP client wired to the adapter that keeps which session each update and permission request was for. */
const connect = async (
  run: ReturnType<typeof fakeQuery>["run"],
  body: (api: {
    prompt: (text: string) => Promise<void>;
    seen: Seen[];
    asked: Record<string, unknown>[];
  }) => Promise<void>,
) => {
  const seen: Seen[] = [];
  const asked: Record<string, unknown>[] = [];
  const waiting: (() => void)[] = [];
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update as unknown as Record<string, unknown>;
      seen.push({ sessionId: params.sessionId, update });
      const state = update.state as string | undefined;
      if (params.sessionId === ID && update.sessionUpdate === "state_update" && state === "idle")
        for (const resolve of waiting.splice(0)) resolve();
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      asked.push(params as never);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
  await app.connectWith(createAgent({ env: {} }, run), async (agent) => {
    await agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test", version: "0" },
    } as never);
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    } as never);
    await body({
      seen,
      asked,
      prompt: async (text) => {
        const idle = new Promise<void>((resolve) => waiting.push(resolve));
        await agent.request(methods.agent.session.prompt, {
          sessionId: ID,
          prompt: [{ type: "text", text }],
        } as never);
        await idle;
      },
    });
  });
};

const system = (subtype: string, fields: Record<string, unknown>) =>
  ({ type: "system", subtype, uuid: "u", session_id: ID, ...fields }) as unknown as SDKMessage;
const said = (from: string | null, id: string, content: unknown[]) =>
  ({
    type: "assistant",
    parent_tool_use_id: from,
    message: { id, content },
    session_id: ID,
  }) as unknown as SDKMessage;
const result = (from: string, callId: string, text: string) =>
  ({
    type: "user",
    parent_tool_use_id: from,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId, content: text }],
    },
    session_id: ID,
  }) as unknown as SDKMessage;

/** The main agent starts sub-agent `t1` with the Agent call `agent_1`. */
const started: SDKMessage[] = [
  said(null, "main_1", [
    { type: "tool_use", id: "agent_1", name: "Agent", input: { description: "Look" } },
  ]),
  system("task_started", {
    task_id: "t1",
    tool_use_id: "agent_1",
    description: "Look",
    subagent_type: "Explore",
  }),
];

const of = (seen: Seen[], sessionId: string) =>
  seen.filter((s) => s.sessionId === sessionId).map((s) => s.update);

test("a sub-agent's words and calls are its own session's, and a call it left ends before it does", async () => {
  const fake = fakeQuery(() => [
    ...started,
    // Its stream is not read: the words come whole, once.
    {
      type: "stream_event",
      parent_tool_use_id: "agent_1",
      event: { type: "message_start", message: { id: "sub_1" } },
    } as unknown as SDKMessage,
    said("agent_1", "sub_1", [{ type: "text", text: "Looking in src" }]),
    said("agent_1", "sub_1", [
      { type: "tool_use", id: "read_1", name: "Read", input: { file_path: "/work/a.ts" } },
    ]),
    result("agent_1", "read_1", "export const a = 1;"),
    said("agent_1", "sub_2", [
      { type: "tool_use", id: "grep_1", name: "Grep", input: { pattern: "a" } },
    ]),
    // Its to-do list is its own: not the session's plan.
    said("agent_1", "sub_3", [
      { type: "tool_use", id: "todo_1", name: "TodoWrite", input: { todos: [{ content: "x" }] } },
    ]),
    system("task_notification", { task_id: "t1", status: "completed", summary: "Found it" }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ prompt, seen }) => {
    await prompt("go");
    const child = of(seen, "t1");
    expect(child.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call_update",
      "tool_call_update",
      "tool_call_update",
      "tool_call_update",
      "tool_call_update",
      "tool_call_update",
    ]);
    expect(child[0]).toMatchObject({ messageId: "sub_1", content: { text: "Looking in src" } });
    expect(child[1]).toMatchObject({ toolCallId: "read_1", name: "Read", status: "in_progress" });
    expect(child[2]).toMatchObject({ toolCallId: "read_1", status: "completed" });
    expect(child[3]).toMatchObject({ toolCallId: "grep_1", status: "in_progress" });
    expect(child[4]).toMatchObject({ toolCallId: "todo_1", status: "in_progress" });
    // What it left running ends as cancelled, and before the client hears that it ended.
    expect(child.slice(5)).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "grep_1", status: "cancelled" },
      { sessionUpdate: "tool_call_update", toolCallId: "todo_1", status: "cancelled" },
    ]);
    const lastChild = seen.findLastIndex((s) => s.sessionId === "t1");
    const end = seen.findIndex(
      (s) =>
        s.update.sessionUpdate === "subagent_update" &&
        (s.update.state as { state?: string } | undefined)?.state === "idle",
    );
    expect(end).toBeGreaterThan(lastChild);
    // Nothing of it reads as the main agent's, and its plan is not the session's.
    const main = of(seen, ID);
    expect(main.some((u) => u.sessionUpdate === "plan_update")).toBe(false);
    const mainCalls = main.filter((u) => u.sessionUpdate === "tool_call_update");
    expect([...new Set(mainCalls.map((u) => u.toolCallId))]).toEqual(["agent_1"]);
    expect(JSON.stringify(main)).not.toContain("Looking in src");
  });
  // Its words are asked for, not only its calls.
  const options = (fake.calls[0]?.options ?? {}) as { forwardSubagentText?: boolean };
  expect(options.forwardSubagentText).toBe(true);
});

test("a sub-agent that was never announced says nothing, and a background one goes on after the turn", async () => {
  const fake = fakeQuery(() => [
    said("agent_x", "sub_0", [{ type: "text", text: "nobody announced me" }]),
    ...started,
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ prompt, seen }) => {
    await prompt("go");
    expect(seen.some((s) => s.sessionId === "agent_x")).toBe(false);
    expect(JSON.stringify(seen)).not.toContain("nobody announced me");
    // The turn is over; the sub-agent still works in the background, and what it says is still its own.
    const before = seen.length;
    fake.state.say([said("agent_1", "sub_9", [{ type: "text", text: "still here" }])]);
    for (let i = 0; i < 100 && seen.length === before; i++) await Bun.sleep(5);
    expect(seen.slice(before)).toEqual([
      {
        sessionId: "t1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "sub_9",
          content: { type: "text", text: "still here" },
        },
      },
    ]);
  });
});

test("what a sub-agent says after its end is still its own, and a call it makes then ends at once", async () => {
  const fake = fakeQuery(() => [
    ...started,
    system("task_notification", { task_id: "t1", status: "completed", summary: "Found it" }),
    // Its last message comes after its end was told (see `Subagents`).
    said("agent_1", "sub_late", [
      { type: "text", text: "one more" },
      { type: "tool_use", id: "late_1", name: "Read", input: { file_path: "/work/b.ts" } },
    ]),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ prompt, seen }) => {
    await prompt("go");
    const child = of(seen, "t1");
    expect(child[0]).toMatchObject({ sessionUpdate: "agent_message_chunk", messageId: "sub_late" });
    expect(child[1]).toMatchObject({ toolCallId: "late_1", status: "in_progress" });
    // Nothing would end it later: no client shows it running for ever.
    expect(child.at(-1)).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "late_1",
      status: "cancelled",
    });
  });
});

test("a sub-agent's permission is asked in its session: by the call it made, or by the SDK's agent id", async () => {
  let turn = 0;
  const fake = fakeQuery(async ({ options }: Call) => {
    turn++;
    if (turn === 1)
      return [
        ...started,
        said("agent_1", "sub_1", [
          { type: "tool_use", id: "bash_1", name: "Bash", input: { command: "ls" } },
        ]),
        ...textTurn(ID, "m1", "ok"),
      ];
    const ask = (toolUseID: string, agentID?: string) =>
      options.canUseTool?.("Bash", { command: "ls" }, {
        signal: new AbortController().signal,
        toolUseID,
        ...(agentID !== undefined ? { agentID } : {}),
      } as never);
    await ask("bash_1"); // made by t1, as its messages said
    await ask("bash_2", "t1"); // not seen yet: the SDK says whose
    await ask("bash_3", "not-a-task"); // an id no client was told of: the main session's
    await ask("bash_4"); // the main agent's own
    return textTurn(ID, "m2", "ok");
  });
  await connect(fake.run, async ({ prompt, asked }) => {
    await prompt("one");
    await prompt("two");
    expect(asked.map((p) => p.sessionId)).toEqual(["t1", "t1", ID, ID]);
  });
});
