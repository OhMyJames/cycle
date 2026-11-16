import { expect, test } from "bun:test";
import type { Item, SessionEvent } from "@cycle/protocol";
import { StreamReader, toTurns } from "../src/index.ts";
import { readNotification, turnOrigin } from "../src/tasks.ts";
import { entryBefore, lastEntryOf, turnPlace } from "../src/translate.ts";
import type { WireHistoryMessage, WireMessage } from "../src/wire.ts";
import { assistant, user } from "./fake-sdk.ts";

const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const said = (uuid: string, content: unknown[], parent: string | null = null): WireMessage => ({
  type: "assistant",
  uuid,
  message: { id: uuid, content: content as never },
  parent_tool_use_id: parent,
});
const answered = (id: string, text: string, parent: string | null = null): WireMessage => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  parent_tool_use_id: parent,
});
const system = (subtype: string, extra: Partial<WireMessage>): WireMessage => ({
  type: "system",
  subtype,
  ...extra,
});

/** Each event as `type turn item kind status`, or its type alone. */
const brief = (events: SessionEvent[]) =>
  events.map((event) => {
    if (!("item" in event)) return event.type;
    const item = event.item as Item & { status?: string; parentId?: string };
    const parent = item.parentId ? ` in ${item.parentId}` : "";
    return `${event.type} ${event.turnId} ${item.id} ${item.kind}${parent} ${item.status ?? ""}`.trim();
  });

test("a helper agent is a task, and what it does is shown inside it, nested", () => {
  const reader = new StreamReader("s", "/project");
  const events = [
    said("a1", [call("toolu_1", "Agent", { description: "Look", prompt: "look around" })]),
    system("task_started", {
      task_id: "t1",
      tool_use_id: "toolu_1",
      task_type: "local_agent",
      subagent_type: "general-purpose",
      is_backgrounded: false,
    }),
    said("h1", [call("toolu_2", "Bash", { command: "ls" })], "toolu_1"),
    answered("toolu_2", "a.txt", "toolu_1"),
    // The helper's own helper, nested one further.
    said("h2", [call("toolu_3", "Agent", { description: "Deeper" })], "toolu_1"),
    said("h3", [{ type: "text", text: "found it" }], "toolu_3"),
    answered("toolu_3", "deep report", "toolu_1"),
    said("h4", [{ type: "text", text: "all done" }], "toolu_1"),
    answered("toolu_1", "report"),
  ].flatMap((message) => reader.read("t", message));
  expect(brief(events)).toEqual([
    "item.started t toolu_1 task running",
    "item.started t toolu_1 task running",
    "item.started t toolu_2 command in toolu_1 running",
    "item.completed t toolu_2 command in toolu_1 completed",
    "item.started t toolu_3 task in toolu_1 running",
    "item.completed t h3:0 agentMessage in toolu_3",
    "item.completed t toolu_3 task in toolu_1 completed",
    "item.completed t h4:0 agentMessage in toolu_1",
    "item.completed t toolu_1 task completed",
  ]);
  expect(events[1]).toMatchObject({
    item: { taskId: "t1", agent: "general-purpose", description: "Look", prompt: "look around" },
  });
});

test("a task in the background goes on after its turn, in that turn, until its news", () => {
  const reader = new StreamReader("s", "/project");
  const read = (turnId: string | null, message: WireMessage) => reader.read(turnId, message);
  read("t", said("a1", [call("toolu_1", "Agent", { description: "Slow" })]));
  expect(
    brief([
      ...read(
        "t",
        system("task_started", { task_id: "t1", tool_use_id: "toolu_1", is_backgrounded: true }),
      ),
      ...read(
        "t",
        system("background_tasks_changed", {
          tasks: [
            {
              task_id: "t1",
              task_type: "local_agent",
              description: "Slow",
              subagent_type: "explore",
            },
            { task_id: "w", task_type: "monitor", description: "watch", ambient: true },
          ],
        }),
      ),
      ...read("t", answered("toolu_1", "Async agent launched successfully.")),
    ]),
  ).toEqual([
    "item.started t toolu_1 task running",
    "tasks.updated",
    "item.started t toolu_1 task running",
  ]);
  // The turn has ended: what follows is the task's, in the turn that began it.
  const later = [
    read(null, said("h1", [call("toolu_2", "Bash", { command: "sleep 9" })], "toolu_1")),
    read(null, { type: "tool_progress", tool_use_id: "toolu_2", elapsed_time_seconds: 2.5 }),
    read(
      null,
      system("task_progress", {
        task_id: "t1",
        description: "Running sleep",
        usage: { total_tokens: 900, tool_uses: 1, duration_ms: 2500 },
      }),
    ),
    read(
      null,
      system("task_notification", {
        task_id: "t1",
        status: "completed",
        summary: "Slow finished",
      }),
    ),
    read(null, system("background_tasks_changed", { tasks: [] })),
  ];
  expect(later.map(brief)).toEqual([
    ["item.started t toolu_2 command in toolu_1 running"],
    ["item.started t toolu_2 command in toolu_1 running"],
    ["item.started t toolu_1 task running"],
    ["item.completed t toolu_1 task completed"],
    ["tasks.updated"],
  ]);
  expect(later[1]?.[0]).toMatchObject({ item: { durationMs: 2500 } });
  expect(later[2]?.[0]).toMatchObject({
    item: { summary: "Running sleep", usage: { tokens: 900, toolUses: 1, durationMs: 2500 } },
  });
  expect(later[3]?.[0]).toMatchObject({ item: { summary: "Slow finished", background: true } });
});

test("a command in the background is the task its call began, and the list names its item", () => {
  const reader = new StreamReader("s", "/project");
  reader.read(
    "t",
    said("a1", [call("toolu_1", "Bash", { command: "make", run_in_background: true })]),
  );
  const events = [
    // Claude Code lists a task in the background before it tells of it.
    ...reader.read(
      "t",
      system("background_tasks_changed", {
        tasks: [{ task_id: "b1", task_type: "local_bash", description: "make" }],
      }),
    ),
    ...reader.read(
      "t",
      system("task_started", {
        task_id: "b1",
        tool_use_id: "toolu_1",
        task_type: "local_bash",
        description: "make",
        is_backgrounded: true,
      }),
    ),
    // A stop the owner asked for, which arrives after the turn.
    ...reader.read(null, system("task_updated", { task_id: "b1", patch: { status: "killed" } })),
  ];
  expect(brief(events)).toEqual([
    "tasks.updated",
    "item.started t toolu_1 task running",
    "tasks.updated",
    "item.completed t toolu_1 task stopped",
  ]);
  expect(events[0]).toMatchObject({ tasks: [{ id: "b1", itemId: null }] });
  expect(events[1]).toMatchObject({ item: { task: "command", taskId: "b1", background: true } });
  expect(events[2]).toMatchObject({
    tasks: [{ id: "b1", task: "command", description: "make", agent: null, itemId: "toolu_1" }],
  });
  // The call's own result says only that it started: it is no "Ran" command that is done.
  const again = new StreamReader("s", "/project");
  again.read(
    "t",
    said("a1", [call("toolu_1", "Bash", { command: "make", run_in_background: true })]),
  );
  const [started] = again.read("t", {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "Command running in background" },
      ],
    },
  });
  expect(started).toMatchObject({
    type: "item.started",
    item: { kind: "task", status: "running" },
  });
});

test("a task that ends is not left with a line of how it was going", () => {
  const reader = new StreamReader("s", "/project");
  reader.read("t", said("a1", [call("toolu_1", "Agent", { description: "Look" })]));
  reader.read("t", system("task_started", { task_id: "t1", tool_use_id: "toolu_1" }));
  reader.read("t", system("task_progress", { task_id: "t1", summary: "Reading README.md" }));
  const [ended] = reader.read(
    "t",
    system("task_updated", { task_id: "t1", patch: { status: "completed" } }),
  );
  expect(ended).toMatchObject({
    type: "item.completed",
    item: { status: "completed", summary: null },
  });
});

test("news of a task never seen, and a helper of no known task, change nothing", () => {
  const reader = new StreamReader("s", "/project");
  expect(
    reader.read(null, system("task_notification", { task_id: "x", status: "completed" })),
  ).toEqual([]);
  expect(reader.read(null, said("h1", [{ type: "text", text: "hi" }], "toolu_9"))).toEqual([]);
  expect(reader.read(null, said("a1", [{ type: "text", text: "hi" }]))).toEqual([]);
});

test("a process that goes away stops what it was running, and empties the list", () => {
  const reader = new StreamReader("s", "/project");
  reader.read("t", said("a1", [call("toolu_1", "Agent", {}), call("toolu_2", "Agent", {})]));
  reader.read("t", system("task_notification", { tool_use_id: "toolu_2", status: "failed" }));
  reader.read(
    "t",
    system("background_tasks_changed", {
      tasks: [{ task_id: "t1", task_type: "local_agent", description: "" }],
    }),
  );
  expect(brief(reader.abandon())).toEqual([
    "item.completed t toolu_1 task stopped",
    "tasks.updated",
  ]);
  expect(reader.abandon()).toEqual([]);
});

test("a turn the agent begins by itself says what it was for", () => {
  expect(turnOrigin({ kind: "task-notification" }, "t1")).toEqual({ kind: "task", taskId: "t1" });
  expect(turnOrigin(undefined, "t1")).toEqual({ kind: "task", taskId: "t1" });
  expect(turnOrigin(undefined, null)).toEqual({ kind: "agent" });
  expect(turnOrigin({ kind: "peer", fromSession: "local_1" }, null)).toEqual({
    kind: "peer",
    from: "local_1",
  });
  expect(readNotification("hello")).toBeNull();
});

const notice = (uuid: string, task: string, tool: string, status: string, summary: string) =>
  user(
    uuid,
    `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${tool}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  );
const ended = (message: WireHistoryMessage, stop: string): WireHistoryMessage => ({
  ...message,
  message: { ...(message.message as object), stop_reason: stop },
});
const nested = (items: Item[]) =>
  items.map((item) => `${item.id}${item.parentId ? ` in ${item.parentId}` : ""}`);
const helper = (uuid: string, parent: string, content: unknown[]): WireHistoryMessage => ({
  ...assistant(uuid, content),
  parent_tool_use_id: parent,
});

const history: WireHistoryMessage[] = [
  user("p1", "look around"),
  ended(
    assistant("a1", [
      call("toolu_1", "Agent", { description: "Look" }),
      call("toolu_2", "Bash", { command: "make" }),
    ]),
    "tool_use",
  ),
  user("r1", [
    { type: "tool_result", tool_use_id: "toolu_1", content: "Async agent launched successfully." },
    { type: "tool_result", tool_use_id: "toolu_2", content: "Command running in background" },
  ]),
  ended(assistant("a2", [{ type: "text", text: "started" }]), "end_turn"),
  notice("n1", "t1", "toolu_1", "completed", "Look finished"),
  ended(assistant("a3", [call("toolu_4", "Bash", { command: "ls" })]), "tool_use"),
  // News that came while that turn ran joined it.
  notice("n2", "b1", "toolu_2", "killed", "make stopped"),
  user("r2", [{ type: "tool_result", tool_use_id: "toolu_4", content: "x" }]),
  ended(assistant("a4", [{ type: "text", text: "noted" }]), "end_turn"),
];

test("a stored conversation keeps its tasks, their helpers' work and the turns their news began", () => {
  const helpers = [
    // A helper's helper, read before the helper that started it.
    [helper("d1", "toolu_3", [{ type: "text", text: "deep" }])],
    [
      user("h0", "look around"),
      helper("h1", "toolu_1", [call("toolu_3", "Agent", { description: "Deeper" })]),
      {
        ...user("h2", [{ type: "tool_result", tool_use_id: "toolu_3", content: "deep report" }]),
        parent_tool_use_id: "toolu_1",
      },
    ],
  ];
  const turns = toTurns(history, "/project", null, helpers);
  expect(turns.map((turn) => [turn.id, turn.origin ?? null])).toEqual([
    ["p1", null],
    // Known by the agent's first message after the news, as it was while it ran.
    ["a3", { kind: "task", taskId: "t1" }],
  ]);
  expect(nested(turns[0]?.items ?? [])).toEqual([
    "p1",
    "toolu_1",
    "toolu_2",
    "a2:0",
    "task:b1",
    "toolu_3 in toolu_1",
    "d1:0 in toolu_3",
  ]);
  expect(turns[0]?.items[1]).toMatchObject({
    kind: "task",
    taskId: "t1",
    status: "completed",
    background: true,
    summary: "Look finished",
  });
  expect(turns[0]?.items[4]).toMatchObject({ task: "command", status: "stopped" });
  expect(turns[0]?.items[5]).toMatchObject({ kind: "task", status: "completed" });
  expect(turnPlace(history, "a3")).toBe("later");
  // Going back to it cuts before the news that began it.
  expect(entryBefore(history, "a3")).toBe("a2");
  expect(turnPlace(history, "n2")).toBe("unknown");
  expect(lastEntryOf(history, "p1")).toBe("a2");
});

test("news after a turn that was stopped or failed begins a turn, as it did while it ran", () => {
  const stopped: WireHistoryMessage[] = [
    user("p1", "go"),
    ended(assistant("a1", [call("toolu_1", "Agent", {})]), "tool_use"),
    user("i1", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
    notice("n1", "t1", "toolu_1", "completed", "done"),
    ended(assistant("a2", [{ type: "text", text: "the helper is done" }]), "end_turn"),
    user("p2", "again"),
    // Claude Code's own error ends a turn, under a stop of its own.
    ended(assistant("a3", [{ type: "text", text: "API Error" }]), "stop_sequence"),
    notice("n2", "t2", "toolu_1", "completed", "done"),
    ended(assistant("a4", [{ type: "text", text: "noted" }]), "end_turn"),
  ];
  expect(toTurns(stopped, "/project").map((turn) => [turn.id, turn.status])).toEqual([
    ["p1", "interrupted"],
    ["a2", "completed"],
    ["p2", "completed"],
    ["a4", "completed"],
  ]);
});

test("a task that ended by its news stays ended when its call's result comes after", () => {
  const reader = new StreamReader("s", "/project");
  reader.read("t", said("a1", [call("toolu_1", "Agent", { run_in_background: false })]));
  reader.read("t", system("task_started", { task_id: "t1", tool_use_id: "toolu_1" }));
  reader.read("t", system("task_updated", { task_id: "t1", patch: { status: "killed" } }));
  expect(brief(reader.read("t", answered("toolu_1", "partial report")))).toEqual([
    "item.completed t toolu_1 task stopped",
  ]);
  // It ended and its call is answered: nothing more comes of it.
  const late = system("task_progress", { task_id: "t1", summary: "late" });
  expect(reader.read(null, late)).toEqual([]);
  expect(reader.read(null, said("h1", [{ type: "text", text: "late" }], "toolu_1"))).toEqual([]);
});
