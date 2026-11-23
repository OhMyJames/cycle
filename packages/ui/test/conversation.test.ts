import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import {
  applyUpdate,
  type Block,
  type Conversation,
  canPrompt,
  contextOf,
  emptyConversation,
  type Item,
  reduce,
  type ToolItem,
  textOf,
} from "../src/model/index.ts";

const blocksOf = (item: Item | undefined): Block[] => (item as { blocks: Block[] }).blocks;
const u = (update: object) => update as SessionUpdate;
const chunk = (kind: string, messageId: string, text: string) =>
  u({ sessionUpdate: kind, messageId, content: { type: "text", text } });
const idle = (extra: object = {}) => u({ sessionUpdate: "state_update", state: "idle", ...extra });
const tool = (c: Conversation, id: string) =>
  c.items.find((i) => i.kind === "tool" && i.id === id) as ToolItem;

test("joins the chunks of one message into one run of text", () => {
  const c = reduce([
    chunk("agent_message_chunk", "a", "Hel"),
    chunk("agent_message_chunk", "a", "lo"),
  ]);
  expect(c.items).toHaveLength(1);
  expect(c.items[0]).toMatchObject({ kind: "agent", id: "a" });
  expect(textOf(blocksOf(c.items[0]))).toBe("Hello");
  expect(blocksOf(c.items[0])).toHaveLength(1);
});

test("an item keeps the time it began, and a message the time of its last chunk", () => {
  const T = Date.UTC(2026, 10, 18, 4);
  let c = emptyConversation();
  c = applyUpdate(c, chunk("user_message_chunk", "q", "hi"), { at: T });
  c = applyUpdate(c, chunk("agent_thought_chunk", "t", "hmm"), { at: T + 1_000 });
  c = applyUpdate(c, chunk("agent_thought_chunk", "t", "…"), { at: T + 6_000 });
  c = applyUpdate(c, u({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "pending" }), {
    at: T + 7_000,
  });
  c = applyUpdate(
    c,
    u({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed" }),
    {
      at: T + 9_000,
    },
  );
  c = applyUpdate(c, chunk("agent_message_chunk", "a", "Hel"), { at: T + 10_000 });
  c = applyUpdate(c, chunk("agent_message_chunk", "a", "lo"), { at: T + 12_000 });
  c = applyUpdate(c, idle({ stopReason: "end_turn" }), { at: T + 12_500 });
  expect(c.items.map((i) => [i.kind, i.at, "lastAt" in i ? i.lastAt : "-"])).toEqual([
    ["user", T, T],
    ["thought", T + 1_000, T + 6_000],
    ["tool", T + 7_000, "-"],
    ["agent", T + 10_000, T + 12_000],
  ]);
});

test("an update without a time (an older daemon) leaves the time unknown, never now or 0", () => {
  const c = reduce([
    chunk("agent_message_chunk", "a", "Hel"),
    chunk("agent_message_chunk", "a", "lo"),
    u({ sessionUpdate: "tool_call_update", toolCallId: "x" }),
  ]);
  for (const item of c.items) {
    expect(item.at).toBeUndefined();
    expect("at" in item).toBe(false);
    expect("lastAt" in item).toBe(false);
  }
  // A time that is not one is no time.
  const bad = applyUpdate(emptyConversation(), chunk("agent_message_chunk", "a", "x"), { at: 0 });
  expect("at" in (bad.items[0] as object)).toBe(false);
  const nan = applyUpdate(emptyConversation(), chunk("agent_message_chunk", "a", "x"), {
    at: Number.NaN,
  });
  expect("at" in (nan.items[0] as object)).toBe(false);
  // Begun with no time, it does not take a later chunk's time as its beginning; the last chunk's time is still kept.
  const later = applyUpdate(c, chunk("agent_message_chunk", "a", "!"), { at: 5_000 });
  expect(later.items[0]).toMatchObject({ lastAt: 5_000 });
  expect(later.items[0]?.at).toBeUndefined();
  // And a chunk with no time keeps the last one known.
  const kept = applyUpdate(later, chunk("agent_message_chunk", "a", "?"));
  expect(kept.items[0]).toMatchObject({ lastAt: 5_000 });
});

test("a message and a thought with the same id are two items", () => {
  const c = reduce([
    chunk("agent_thought_chunk", "m", "hmm"),
    chunk("agent_message_chunk", "m", "answer"),
  ]);
  expect(c.items.map((i) => i.kind)).toEqual(["thought", "agent"]);
});

test("the whole message that follows the chunks replaces them, it does not repeat them", () => {
  const c = reduce([
    chunk("agent_message_chunk", "a", "Hel"),
    chunk("agent_message_chunk", "a", "lo"),
    u({
      sessionUpdate: "agent_message",
      messageId: "a",
      content: [{ type: "text", text: "Hello" }],
    }),
  ]);
  expect(textOf(blocksOf(c.items[0]))).toBe("Hello");
});

test("a message update with no content leaves the content, and null clears it", () => {
  const base = reduce([chunk("agent_message_chunk", "a", "text")]);
  const kept = applyUpdate(base, u({ sessionUpdate: "agent_message", messageId: "a" }));
  expect(textOf(blocksOf(kept.items[0]))).toBe("text");
  const cleared = applyUpdate(
    base,
    u({ sessionUpdate: "agent_message", messageId: "a", content: null }),
  );
  expect(blocksOf(cleared.items[0])).toEqual([]);
});

test("a user message is added whole, or built from chunks", () => {
  const whole = reduce([
    u({ sessionUpdate: "user_message", messageId: "u", content: [{ type: "text", text: "hi" }] }),
  ]);
  expect(whole.items[0]).toMatchObject({ kind: "user", id: "u" });
  const built = reduce([
    chunk("user_message_chunk", "u", "h"),
    chunk("user_message_chunk", "u", "i"),
  ]);
  expect(textOf(blocksOf(built.items[0]))).toBe("hi");
});

test("a tool call is patched by its id as it goes, and keeps what an update leaves out", () => {
  const c = reduce([
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      name: "Bash",
      kind: "execute",
      status: "pending",
    }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "in_progress",
      rawInput: { command: "ls" },
    }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
    }),
  ]);
  expect(c.items).toHaveLength(1);
  expect(tool(c, "t")).toMatchObject({
    name: "Bash",
    toolKind: "execute",
    status: "completed",
    rawInput: { command: "ls" },
  });
  expect(tool(c, "t").content).toHaveLength(1);
});

test("an update for a tool seen before its first update still makes one", () => {
  const c = reduce([
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" }),
  ]);
  expect(tool(c, "t")).toMatchObject({ status: "completed", content: [] });
});

test("null clears a tool's field", () => {
  const c = reduce([
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", name: "Bash", status: "in_progress" }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", name: null }),
  ]);
  expect(tool(c, "t").name).toBeUndefined();
  expect(tool(c, "t").status).toBe("in_progress");
});

test("tool content can arrive as chunks", () => {
  const c = reduce([
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", name: "Bash" }),
    u({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "t",
      content: { type: "text", text: "a" },
    }),
    u({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "t",
      content: { type: "text", text: "b" },
    }),
  ]);
  expect(tool(c, "t").content).toEqual([{ type: "text", text: "ab" }]);
});

test("the turn has ended only when an idle says why", () => {
  let c = reduce([u({ sessionUpdate: "state_update", state: "running" })]);
  expect(c.status).toBe("running");
  expect(canPrompt(c)).toBe(false);
  // A snapshot of the state is idle with no reason: it is not the end of a turn.
  c = applyUpdate(c, idle());
  expect(c.status).toBe("idle");
  expect(c.turns).toBe(0);
  expect(c.stops).toEqual([]);
  c = applyUpdate(
    applyUpdate(c, u({ sessionUpdate: "state_update", state: "running" })),
    idle({ stopReason: "end_turn" }),
  );
  expect(c.turns).toBe(1);
  expect(c.stops).toEqual([{ stopReason: "end_turn" }]);
  expect(canPrompt(c)).toBe(true);
});

test("a snapshot applied twice changes nothing", () => {
  const once = reduce([idle(), u({ sessionUpdate: "state_update", state: "running" })]);
  const twice = applyUpdate(
    applyUpdate(once, u({ sessionUpdate: "state_update", state: "running" })),
    u({ sessionUpdate: "state_update", state: "running" }),
  );
  expect(twice).toEqual(once);
});

test("a turn that ends, however it ends, ends the tools that were still going", () => {
  const start = reduce([
    u({ sessionUpdate: "tool_call_update", toolCallId: "a", name: "Bash", status: "in_progress" }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "b", name: "Read", status: "completed" }),
  ]);
  const cancelled = applyUpdate(start, idle({ stopReason: "cancelled" }));
  expect(tool(cancelled, "a").status).toBe("cancelled");
  expect(tool(cancelled, "b").status).toBe("completed");
  // A record from before the agent ended what it left: the call is not shown going for ever (CYCL-46).
  const ended = applyUpdate(start, idle({ stopReason: "end_turn" }));
  expect(tool(ended, "a").status).toBe("cancelled");
  expect(tool(ended, "b").status).toBe("completed");
  // A snapshot of the state is not the end of a turn.
  expect(tool(applyUpdate(start, idle({})), "a").status).toBe("in_progress");
  const failed = applyUpdate(
    start,
    idle({ stopReason: "error", error: { code: -32012, message: "The agent exited" } }),
  );
  expect(failed.stops).toEqual([
    { stopReason: "error", error: { code: -32012, message: "The agent exited" } },
  ]);
});

test("an item belongs to the turn it began in, and keeps it when it is updated later", () => {
  const c = reduce([
    chunk("user_message_chunk", "u1", "first"),
    u({ sessionUpdate: "tool_call_update", toolCallId: "a", name: "Bash", status: "in_progress" }),
    idle({ stopReason: "end_turn" }),
    chunk("user_message_chunk", "u2", "second"),
    // The first turn's tool is patched in the second turn (a late result): it stays in the first.
    u({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }),
    chunk("agent_message_chunk", "a2", "done"),
    idle({ stopReason: "cancelled" }),
  ]);
  expect(c.items.map((i) => [i.id, i.turn])).toEqual([
    ["u1", 0],
    ["a", 0],
    ["u2", 1],
    ["a2", 1],
  ]);
  expect(c.stops.map((s) => s.stopReason)).toEqual(["end_turn", "cancelled"]);
});

test("a snapshot's idle, with no reason, does not start a new turn", () => {
  const c = reduce([
    chunk("user_message_chunk", "u1", "first"),
    idle(),
    chunk("agent_message_chunk", "a1", "still the first"),
  ]);
  expect(c.items.map((i) => i.turn)).toEqual([0, 0]);
});

test("a plan is replaced by its id", () => {
  const entries = (s: string) => [{ content: "do it", priority: "high", status: s }];
  const c = reduce([
    u({
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "p", entries: entries("pending") },
    }),
    u({
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "p", entries: entries("completed") },
    }),
  ]);
  expect(c.items).toHaveLength(1);
  expect(c.items[0]).toMatchObject({ kind: "plan", entries: [{ status: "completed" }] });
});

test("replay_complete ends the replay, and usage is kept", () => {
  const c = reduce(
    [
      u({ sessionUpdate: "usage_update", used: 10, size: 100 }),
      u({ sessionUpdate: "replay_complete" }),
    ],
    {
      ...emptyConversation(),
      replaying: true,
    },
  );
  expect(c.replaying).toBe(false);
  expect(c.usage).toEqual({ used: 10, size: 100 });
});

test("an update of a kind it does not know is counted and does no harm", () => {
  const c = reduce([
    u({ sessionUpdate: "_vendor_thing", x: 1 }),
    chunk("agent_message_chunk", "a", "ok"),
  ]);
  expect(c.ignored).toBe(1);
  expect(c.items).toHaveLength(1);
});

test("never changes the conversation it was given", () => {
  const before = reduce([chunk("agent_message_chunk", "a", "x")]);
  const frozen = JSON.stringify(before);
  applyUpdate(before, chunk("agent_message_chunk", "a", "y"));
  applyUpdate(before, idle({ stopReason: "end_turn" }));
  expect(JSON.stringify(before)).toBe(frozen);
});

test("a whole history replayed gives the conversation that was built live", () => {
  const updates = [
    u({ sessionUpdate: "user_message", messageId: "u", content: [{ type: "text", text: "go" }] }),
    u({ sessionUpdate: "state_update", state: "running" }),
    chunk("agent_thought_chunk", "m", "think"),
    chunk("agent_message_chunk", "m", "do"),
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", name: "Bash", status: "pending" }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" }),
    idle({ stopReason: "end_turn" }),
  ];
  const live = updates.reduce((c, u) => applyUpdate(c, u), emptyConversation());
  const replayed = reduce([...updates, u({ sessionUpdate: "replay_complete" })], {
    ...emptyConversation(),
    replaying: true,
  });
  expect({ ...replayed, replaying: live.replaying }).toEqual(live);
});

test("usage keeps its cost until a new one comes, and null clears it", () => {
  const at = (...updates: object[]) =>
    updates.reduce<Conversation>((c, x) => applyUpdate(c, x as never), emptyConversation());
  const cost = { amount: 0.5, currency: "USD" };
  expect(at({ sessionUpdate: "usage_update", used: 1, size: 10, cost }).usage?.cost).toEqual(cost);
  expect(
    at(
      { sessionUpdate: "usage_update", used: 1, size: 10, cost },
      { sessionUpdate: "usage_update", used: 2, size: 10 },
    ).usage,
  ).toEqual({ used: 2, size: 10, cost });
  expect(
    at(
      { sessionUpdate: "usage_update", used: 1, size: 10, cost },
      { sessionUpdate: "usage_update", used: 2, size: 10, cost: null },
    ).usage,
  ).toEqual({ used: 2, size: 10 });
});

test("a usage carries what the window holds when the agent said, and only that usage does", () => {
  const at = (...updates: object[]) =>
    updates.reduce<Conversation>((c, x) => applyUpdate(c, x as never), emptyConversation());
  const counted = {
    sessionUpdate: "usage_update",
    used: 150,
    size: 200,
    _meta: {
      "cycle/context": {
        window: 200,
        autoCompactAt: 170,
        parts: [
          { id: "messages", name: "Messages", tokens: 120, kind: "used" },
          { name: "New", tokens: 30, kind: "used" },
          // What does not read as a part is left out.
          { id: "odd", name: "Odd", tokens: 5, kind: "sideways" },
          { id: "neg", name: "Neg", tokens: -1, kind: "used" },
          { id: "none", name: "None", tokens: 0, kind: "used" },
          { tokens: 3, kind: "used" },
          "no",
        ],
      },
    },
  };
  expect(at(counted).usage).toEqual({
    used: 150,
    size: 200,
    autoCompactAt: 170,
    parts: [
      { id: "messages", name: "Messages", tokens: 120, kind: "used" },
      { name: "New", tokens: 30, kind: "used" },
    ],
  });
  // The next usage without parts has none: an earlier count says nothing of the window now. Where it compacts stays
  // while the window is the same one (the usage told after a compaction does not repeat it), and goes with it.
  expect(at(counted, { sessionUpdate: "usage_update", used: 40, size: 200 }).usage).toEqual({
    used: 40,
    size: 200,
    autoCompactAt: 170,
  });
  expect(at(counted, { sessionUpdate: "usage_update", used: 40, size: 1000 }).usage).toEqual({
    used: 40,
    size: 1000,
  });
  // A count that leaves it out says auto-compaction is off: the old point does not stay.
  expect(
    at(counted, {
      sessionUpdate: "usage_update",
      used: 40,
      size: 200,
      _meta: { "cycle/context": { window: 200, parts: [] } },
    }).usage,
  ).toEqual({ used: 40, size: 200 });
  // A `_meta` that is not one is no parts.
  expect(
    at({ sessionUpdate: "usage_update", used: 1, size: 10, _meta: { "cycle/context": "x" } }).usage,
  ).toEqual({ used: 1, size: 10 });
});

test("a usage measured before a compaction says so until a newer one comes", () => {
  const at = (...updates: object[]) =>
    updates.reduce<Conversation>((c, x) => applyUpdate(c, x as never), emptyConversation());
  const compaction = (status: string, id = "k1") => ({
    sessionUpdate: "compaction_update",
    compactionId: id,
    status,
  });
  const measured = at({ sessionUpdate: "usage_update", used: 150, size: 200 });
  expect(contextOf(measured)).toEqual({
    usage: { used: 150, size: 200 },
    compactions: 0,
    compacting: false,
  });
  const running = at(
    { sessionUpdate: "state_update", state: "running" },
    { sessionUpdate: "usage_update", used: 150, size: 200 },
    compaction("in_progress"),
  );
  expect(contextOf(running).compacting).toBe(true);
  // One never told as over, with nothing running any more (its process went): not "compacting now".
  const orphan = at(
    { sessionUpdate: "state_update", state: "running" },
    compaction("in_progress"),
    { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
  );
  expect(contextOf(orphan).compacting).toBe(false);
  expect(running.usage?.beforeCompaction).toBeUndefined();
  const done = at(
    { sessionUpdate: "usage_update", used: 150, size: 200 },
    compaction("in_progress"),
    compaction("completed"),
  );
  expect(contextOf(done)).toEqual({
    usage: { used: 150, size: 200, beforeCompaction: true },
    compactions: 1,
    compacting: false,
  });
  // The usage after it (the adapter's post_tokens, or the next turn's) is now's.
  const after = at(
    { sessionUpdate: "usage_update", used: 150, size: 200 },
    compaction("in_progress"),
    compaction("completed"),
    { sessionUpdate: "usage_update", used: 40, size: 200 },
  );
  expect(after.usage).toEqual({ used: 40, size: 200 });
  // A compaction that failed or was cut short left the context as it was.
  const failed = at(
    { sessionUpdate: "usage_update", used: 150, size: 200 },
    compaction("in_progress"),
    compaction("failed"),
  );
  expect(failed.usage).toEqual({ used: 150, size: 200 });
  // No usage yet: nothing to mark, and none is made up.
  expect(at(compaction("in_progress"), compaction("completed")).usage).toBeUndefined();
});

const queued = (...texts: string[]) =>
  texts.map((text, i) => ({ queueId: `q${i}`, prompt: [{ type: "text", text }] }));
const queueUpdate = (entries: object[], extra: object = {}) =>
  u({ sessionUpdate: "_cycle/queue_update", entries, ...extra });

test("the queue is the last snapshot, whole", () => {
  const c = reduce([queueUpdate(queued("a", "b")), queueUpdate(queued("b"))]);
  expect(c.queue.map((p) => p.queueId)).toEqual(["q0"]);
  expect(reduce([queueUpdate([])], c).queue).toEqual([]);
});

test("what the daemon hands back, heard live, is set once per hand-back", () => {
  const back = queueUpdate([], { returned: queued("a", "b"), reason: "cancelled" });
  const first = reduce([back]);
  expect(first.returned?.serial).toBe(1);
  expect(first.returned?.reason).toBe("cancelled");
  expect(first.returned?.prompts.map((p) => p.prompt[0]?.text)).toEqual(["a", "b"]);
  expect(first.queue).toEqual([]);
  expect(reduce([back], first).returned?.serial).toBe(2);
  // A snapshot with nothing handed back leaves the last hand-back as it was: it is not heard again.
  expect(reduce([queueUpdate(queued("c"))], first).returned).toBe(first.returned);
});

test("what was handed back before, met again in a replay, is history and goes nowhere", () => {
  const back = queueUpdate([], { returned: queued("a"), reason: "error" });
  const replayed = reduce(
    [queueUpdate(queued("a")), back, u({ sessionUpdate: "replay_complete" })],
    {
      ...emptyConversation(),
      replaying: true,
    },
  );
  expect(replayed.returned).toBeUndefined();
  expect(replayed.queue).toEqual([]);
  // The same hand-back arriving after the replay is live.
  expect(reduce([back], replayed).returned?.serial).toBe(1);
});

test("a malformed queue entry is left out, not trusted", () => {
  const c = reduce([queueUpdate([{ queueId: 1, prompt: [] }, { queueId: "x" }, ...queued("ok")])]);
  expect(c.queue).toHaveLength(1);
  expect(c.queue[0]?.queueId).toBe("q0");
});

test("the agent's commands are kept, with the hint of one that takes input", () => {
  const c = reduce([
    u({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { type: "command", name: "init", description: "Set up" },
        {
          type: "command",
          name: "review",
          description: "Review",
          input: { type: "text", hint: "PR" },
        },
        { type: "other", name: "x", description: "" },
        { type: "command", name: "", description: "" },
      ],
    }),
  ]);
  expect(c.commands).toEqual([
    { name: "init", description: "Set up" },
    { name: "review", description: "Review", hint: "PR" },
  ]);
});

test("a live model list keeps each model's effort levels, and drops a shape that is not a list of words", () => {
  const c = applyUpdate(emptyConversation(), {
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        configId: "model",
        name: "Model",
        currentValue: "opus",
        options: [
          { value: "opus", name: "Opus", _meta: { "cycle/efforts": ["low", "high"] } },
          { value: "haiku", name: "Haiku", _meta: { "cycle/efforts": [] } },
          { value: "odd", name: "Odd", _meta: { "cycle/efforts": "high" } },
        ],
      },
    ],
  } as never);
  expect(c.configOptions[0]?.options.map((o) => [o.value, o.efforts])).toEqual([
    ["opus", ["low", "high"]],
    ["haiku", []],
    ["odd", undefined],
  ]);
});

// ---- background tasks and the goal (CYCL-87) ----

const taskUpdate = (fields: object) => u({ sessionUpdate: "_cycle/task_update", ...fields });

test("a background task's news is merged by its id: later news keeps what earlier news said", () => {
  const c = reduce([
    taskUpdate({ taskId: "b1", kind: "shell", title: "Run the server", state: "running" }),
    taskUpdate({ taskId: "m1", kind: "monitor", state: "running", toolCallId: "call-m" }),
    taskUpdate({ taskId: "b1", toolCallId: "call-b", state: "running" }),
    taskUpdate({ taskId: "b1", state: "failed" }),
    taskUpdate({ taskId: "m1", state: "unknown" }),
  ]);
  expect(c.tasks).toEqual([
    { id: "b1", kind: "shell", title: "Run the server", toolCallId: "call-b", state: "failed" },
    { id: "m1", kind: "monitor", title: undefined, toolCallId: "call-m", state: "unknown" },
  ]);
});

test("news of a task that does not read as one is counted as not drawn, and changes nothing", () => {
  const c = reduce([
    taskUpdate({ taskId: "b1", state: "sleeping" }),
    taskUpdate({ state: "running" }),
    taskUpdate({ taskId: "x", kind: "teleport", state: "running" }),
  ]);
  expect(c.ignored).toBe(2);
  expect(c.tasks).toEqual([
    { id: "x", kind: "other", title: undefined, toolCallId: undefined, state: "running" },
  ]);
});

test("the goal is the last one told: unknown until told, null once cleared", () => {
  const goal = (value: unknown) => u({ sessionUpdate: "_cycle/goal_update", goal: value });
  expect(emptyConversation().goal).toBeUndefined();
  const set = reduce([
    goal({ condition: "tests pass", iterations: 0, setAt: 10 }),
    goal({ condition: "tests pass", iterations: 2, setAt: 10, lastReason: "one fails" }),
  ]);
  expect(set.goal).toEqual({
    condition: "tests pass",
    iterations: 2,
    setAt: 10,
    lastReason: "one fails",
  });
  expect(applyUpdate(set, goal(null)).goal).toBeNull();
  expect(applyUpdate(set, goal({ iterations: 1 })).goal).toBe(set.goal);
});

test("a history from before these updates replays with no tasks and a goal nobody told", () => {
  const c = reduce([chunk("agent_message_chunk", "a", "old"), idle({ stopReason: "end_turn" })]);
  expect(c.tasks).toEqual([]);
  expect(c.goal).toBeUndefined();
});

// ---- what is set to wake the session (CYCL-146) ----

test("the scheduled calls are the last list told, with when it was told; unknown until one is", () => {
  const schedule = (fields: object) => u({ sessionUpdate: "_cycle/schedule_update", ...fields });
  expect(emptyConversation().schedules).toBeUndefined();
  let c = applyUpdate(
    emptyConversation(),
    schedule({
      jobs: [
        {
          id: "c1",
          kind: "cron",
          schedule: "*/30 * * * *",
          humanSchedule: "Every 30 minutes",
          recurring: true,
          durable: false,
          prompt: "Check the deploy",
          nextFireAt: 1_000,
          toolCallId: "t1",
        },
        {
          id: "w",
          kind: "wakeup",
          schedule: "50 2 * * *",
          recurring: false,
          durable: false,
          prompt: "Go on",
        },
        { id: "bad", kind: "alarm", schedule: "* * * * *" },
      ],
    }),
    { at: 500 },
  );
  expect(c.schedules).toEqual({
    jobs: [
      {
        id: "c1",
        kind: "cron",
        schedule: "*/30 * * * *",
        humanSchedule: "Every 30 minutes",
        recurring: true,
        durable: false,
        prompt: "Check the deploy",
        nextFireAt: 1_000,
        toolCallId: "t1",
      },
      {
        id: "w",
        kind: "wakeup",
        schedule: "50 2 * * *",
        humanSchedule: undefined,
        recurring: false,
        durable: false,
        prompt: "Go on",
        nextFireAt: undefined,
        toolCallId: undefined,
      },
    ],
    dormant: false,
  });
  c = applyUpdate(c, schedule({ jobs: [], dormant: true }));
  expect(c.schedules).toEqual({ jobs: [], dormant: true });
  expect(applyUpdate(c, schedule({ jobs: "none" })).ignored).toBe(c.ignored + 1);
});
