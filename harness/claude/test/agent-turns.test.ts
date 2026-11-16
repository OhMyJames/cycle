import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import type { WireMessage } from "../src/wire.ts";
import { FakeSdk, assistant, settle, user } from "./fake-sdk.ts";

const options = { mode: "readOnly" as const, model: "claude-sonnet-5-5" };
const prompt = (text: string) => ({ text, images: [] });
const result = (extra: Partial<WireMessage> = {}): WireMessage => ({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 7,
  ...extra,
});
const said = (uuid: string, content: unknown[], parent: string | null = null): WireMessage => ({
  type: "assistant",
  uuid,
  message: { content: content as never },
  parent_tool_use_id: parent,
});
const stream = (event: Record<string, unknown>): WireMessage => ({
  type: "stream_event",
  event: event as never,
});
const agentCall = {
  type: "tool_use",
  id: "toolu_1",
  name: "Agent",
  input: { description: "Slow" },
};
const listed = (ids: string[]): WireMessage => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((task_id) => ({ task_id, task_type: "local_agent", description: "Slow" })),
});

/** A session whose first turn started a helper agent in the background, and ended. */
async function backgrounded() {
  const sdk = new FakeSdk();
  const later: (() => void)[] = [];
  let ids = 0;
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    schedule: (run) => {
      later.push(run);
      return () => void later.splice(later.indexOf(run), 1);
    },
    now: () => 1000,
    newId: () => `id${++ids}`,
  });
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  const session = await harness.createSession({ cwd: "/project", model: options.model });
  const { turnId } = await harness.send(session.id, prompt("look"), options);
  await settle();
  const query = sdk.last;
  query.say(said("a1", [agentCall]));
  query.say({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_1" });
  query.say(listed(["t1"]));
  query.say(result());
  await settle();
  events.length = 0;
  return { sdk, harness, session, turnId, query, events, later };
}

test("each process shows its helpers' work, and lets the owner stop a task by itself", async () => {
  const { harness, session, query } = await backgrounded();
  expect(query.options).toMatchObject({ forwardSubagentText: true, perTaskStopAffordance: true });
  await harness.stopTask(session.id, "t1");
  expect(query.stopped).toEqual(["t1"]);
  // A stop asks Claude Code; the task's end is its news.
  await harness.interrupt(session.id);
  expect(query.interrupts).toBe(0);
});

test("a task's news after its turn begins a turn of the agent's own, for that task", async () => {
  const { query, events, turnId } = await backgrounded();
  query.say(said("h1", [{ type: "text", text: "found" }], "toolu_1"));
  query.say({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  query.say(listed([]));
  query.say({ type: "system", subtype: "init" });
  query.say(said("a2", [{ type: "text", text: "the helper is done" }]));
  query.say(result({ origin: { kind: "task-notification" } }));
  await settle();
  expect(events.map((event) => [event.type, "turnId" in event ? event.turnId : null])).toEqual([
    ["item.completed", turnId],
    ["item.completed", turnId],
    ["tasks.updated", null],
    ["turn.started", "a2"],
    ["item.completed", "a2"],
    ["usage.updated", null],
    ["turn.completed", "a2"],
  ]);
  expect(events[3]).toMatchObject({ origin: { kind: "task", taskId: "t1" } });
});

test("a turn of the agent's own that ends while the owner's prompt waits is not the prompt's end", async () => {
  const { harness, session, query, events } = await backgrounded();
  const { turnId } = await harness.send(session.id, prompt("next"), options);
  query.say(said("a2", [{ type: "text", text: "about the task" }]));
  query.say(result({ origin: { kind: "task-notification" } }));
  query.say(said("a3", [{ type: "text", text: "about your prompt" }]));
  query.say(result({ user_message_uuids: [turnId] }));
  await settle();
  const ends = events.filter((event) => event.type === "turn.completed");
  expect(ends).toMatchObject([{ turnId }]);
});

test("what the agent streams for a turn of its own waits for the message the turn is known by", async () => {
  const { query, events } = await backgrounded();
  query.say(stream({ type: "message_start", message: { id: "m9" } }));
  query.say(stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
  query.say(
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } }),
  );
  query.say(said("a9", [{ type: "text", text: "Done" }]));
  await settle();
  expect(events.map((event) => [event.type, "turnId" in event ? event.turnId : null])).toEqual([
    ["turn.started", "a9"],
    ["item.started", "a9"],
    ["item.delta", "a9"],
    ["item.completed", "a9"],
  ]);
});

test("a task in the background keeps its process: another mode waits until it is done", async () => {
  const { harness, session, query, sdk } = await backgrounded();
  await expect(
    harness.send(session.id, prompt("next"), { ...options, mode: "fullAccess" }),
  ).rejects.toThrow("still running in the background");
  expect(query.closed).toBe(false);
  query.say(listed([]));
  await settle();
  await harness.send(session.id, prompt("next"), { ...options, mode: "fullAccess" });
  expect(query.closed).toBe(true);
  expect(sdk.last).not.toBe(query);
});

test("a process with a task in the background is not idle, and one with none left is", async () => {
  const { query, later } = await backgrounded();
  expect(later).toHaveLength(0);
  query.say(listed([]));
  await settle();
  later[0]?.();
  expect(query.closed).toBe(true);
});

test("a process that goes away stops its tasks and empties the list", async () => {
  const { query, events } = await backgrounded();
  query.exit(new Error("killed"));
  await settle();
  expect(events).toMatchObject([
    { type: "item.completed", item: { id: "toolu_1", kind: "task", status: "stopped" } },
    { type: "tasks.updated", tasks: [] },
  ]);
});

test("a stored session is read with what its helpers did", async () => {
  const sdk = new FakeSdk();
  sdk.stored = [{ sessionId: "s1", summary: "", lastModified: 1, cwd: "/project" }];
  sdk.messages["s1"] = [user("p1", "look"), assistant("a1", [agentCall])];
  sdk.helpers["s1"] = {
    t1: [{ ...assistant("h1", [{ type: "text", text: "found" }]), parent_tool_use_id: "toolu_1" }],
  };
  const harness = new ClaudeHarness({ sdk, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" } });
  const { turns } = await harness.loadSession("s1", options);
  expect(turns[0]?.items.map((item) => [item.id, item.parentId ?? null])).toEqual([
    ["p1", null],
    ["toolu_1", null],
    ["h1:0", "toolu_1"],
  ]);
});
