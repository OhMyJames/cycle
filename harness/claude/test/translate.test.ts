import { expect, test } from "bun:test";
import type { SessionEvent } from "@cycle/protocol";
import {
  StreamReader,
  finishTool,
  CLAUDE_MODES,
  modeOptions,
  processSpec,
  toModels,
  toSession,
  toTurns,
  toUserMessage,
  toolItem,
} from "../src/index.ts";
import { entryBefore, historyModel, lastEntryOf, turnPlace } from "../src/translate.ts";
import type { WireMessage, WireStreamEvent } from "../src/wire.ts";
import { assistant, user } from "./fake-sdk.ts";

const stream = (event: WireStreamEvent): WireMessage => ({ type: "stream_event", event });
const said = (uuid: string, content: unknown[], extra: Partial<WireMessage> = {}): WireMessage => ({
  type: "assistant",
  uuid,
  message: { id: "msg_1", content: content as never },
  ...extra,
});

function read(messages: WireMessage[], reader = new StreamReader("s", "/project")): SessionEvent[] {
  return messages.flatMap((message) => reader.read("t", message));
}

const brief = (events: SessionEvent[]) =>
  events.map((event) =>
    event.type === "item.delta"
      ? `delta ${event.itemId} ${event.delta}`
      : "item" in event
        ? `${event.type} ${event.item.id} ${event.item.kind}`
        : event.type,
  );

test("text arrives in pieces and then whole, as one item", () => {
  const events = read([
    stream({ type: "message_start", message: { id: "msg_1" } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    stream({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } }),
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } }),
    // Reasoning the model kept to itself: an empty block that never streamed.
    said("a1", [{ type: "thinking", thinking: "" }]),
    said("a2", [{ type: "text", text: "Hello" }]),
  ]);
  expect(brief(events)).toEqual([
    "item.started msg_1:1 agentMessage",
    "delta msg_1:1 Hel",
    "delta msg_1:1 lo",
    "item.completed msg_1:1 agentMessage",
  ]);
  expect(events.at(-1)).toMatchObject({ item: { text: "Hello" } });
});

test("text that never streamed is still said, and a helper's of no known task is left out", () => {
  const events = read([
    said("a1", [{ type: "text", text: "whole" }]),
    said("a2", [{ type: "text", text: "from a helper" }], { parent_tool_use_id: "toolu_9" }),
  ]);
  expect(brief(events)).toEqual(["item.completed a1:0 agentMessage"]);
});

test("a tool call starts as it is asked for and completes with its result", () => {
  const reader = new StreamReader("s", "/project");
  const call = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } };
  const [started] = read([said("a1", [call])], reader);
  expect(started).toMatchObject({
    type: "item.started",
    item: { kind: "command", command: "ls", cwd: "/project", status: "running" },
  });
  const [done] = read(
    [
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" }] },
        tool_use_result: { stdout: "a\nb", stderr: "warn" },
      },
    ],
    reader,
  );
  expect(done).toMatchObject({
    type: "item.completed",
    item: { id: "toolu_1", output: "a\nb\nwarn", exitCode: 0, status: "completed" },
  });
});

test("a command's own description is kept beside it, and none is not made up", () => {
  const input = { command: "ls -la", description: " List the files " };
  expect(toolItem("i", "Bash", input, "/p")).toMatchObject({
    command: "ls -la",
    description: "List the files",
  });
  expect(toolItem("i", "Bash", { command: "ls" }, "/p")).not.toHaveProperty("description");
  expect(toolItem("i", "Bash", { command: "ls", description: "  " }, "/p")).not.toHaveProperty(
    "description",
  );
});

test("a call the owner refused is declined, not failed", () => {
  const reader = new StreamReader("s", "/project");
  read([said("a1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }])], reader);
  reader.declined.add("toolu_1");
  const refused = { type: "tool_result", tool_use_id: "toolu_1", content: "no", is_error: true };
  const [done] = read([{ type: "user", message: { content: [refused] } }], reader);
  expect(done).toMatchObject({ item: { status: "declined", exitCode: null } });
});

test("each of Claude Code's tools is the item the conversation has for it", () => {
  expect(toolItem("i", "Read", { file_path: "/p/a.ts" }, "/p")).toMatchObject({
    kind: "command",
    actions: [{ type: "read", path: "/p/a.ts" }],
  });
  expect(toolItem("i", "Grep", { pattern: "x", path: "src" }, "/p")).toMatchObject({
    actions: [{ type: "search", query: "x", path: "src" }],
  });
  expect(
    toolItem("i", "Edit", { file_path: "a.ts", old_string: "a\n", new_string: "b\nc" }, "/p"),
  ).toMatchObject({
    kind: "fileChange",
    changes: [{ path: "a.ts", change: "update", diff: "-a\n+b\n+c" }],
  });
  // A sandbox's path for the folder is this machine's path for it, so a file it touched opens here.
  expect(
    toolItem(
      "i",
      "Read",
      { file_path: "/home/agent/workspace/app/a.ts" },
      "/Users/me/app",
      "/home/agent/workspace/app",
    ),
  ).toMatchObject({
    actions: [{ type: "read", path: "/Users/me/app/a.ts" }],
  });
  expect(toolItem("i", "mcp__cycle__list_sessions", { n: 1 }, "/p")).toMatchObject({
    kind: "toolCall",
    server: "cycle",
    tool: "list_sessions",
    args: '{"n":1}',
  });
  expect(toolItem("i", "TaskCreate", {}, "/p")).toMatchObject({ server: null, tool: "TaskCreate" });
  expect(toolItem("i", "WebSearch", { query: "bun" }, "/p")).toEqual({
    id: "i",
    kind: "webSearch",
    query: "bun",
  });
  expect(toolItem("i", "Agent", { prompt: "look", description: "Look" }, "/p")).toMatchObject({
    kind: "task",
    task: "agent",
    description: "Look",
    prompt: "look",
    status: "running",
  });
});

test("a result fills in what the call could not know", () => {
  const write = toolItem("i", "Write", { file_path: "new.txt", content: "a\n" }, "/p");
  const ok = { type: "tool_result", tool_use_id: "i", content: "File created" };
  expect(finishTool(write, ok, { type: "create", structuredPatch: [] }, false)).toMatchObject({
    status: "completed",
    changes: [{ change: "add", diff: "+a" }],
  });
  const edit = toolItem("i", "Edit", { file_path: "a", old_string: "x", new_string: "y" }, "/p");
  const hunk = { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-x", "+y"] };
  expect(finishTool(edit, ok, { structuredPatch: [hunk] }, false)).toMatchObject({
    changes: [{ diff: "@@ -3,1 +3,1 @@\n-x\n+y" }],
  });
  const bash = toolItem("i", "Bash", { command: "false" }, "/p");
  const failed = { type: "tool_result", content: "Exit code 2\nboom", is_error: true };
  expect(finishTool(bash, failed, "Error: Exit code 2", false)).toMatchObject({
    status: "failed",
    exitCode: 2,
    output: "Exit code 2\nboom",
  });
  // What a file held is on disk: a read says nothing unless it failed.
  const readFile = toolItem("i", "Read", { file_path: "a" }, "/p");
  expect(finishTool(readFile, { type: "tool_result", content: "1\ta" }, {}, false)).toMatchObject({
    output: "",
  });
  const tool = toolItem("i", "mcp__a__b", {}, "/p");
  expect(
    finishTool(tool, { type: "tool_result", content: "no", is_error: true }, 0, false),
  ).toMatchObject({ status: "failed", result: null, error: "no" });
});

const history = [
  user("p1", "first"),
  assistant("a1", [{ type: "text", text: "one" }]),
  user("p2", [{ type: "text", text: "second" }]),
  assistant("a2", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
  user("r1", [{ type: "tool_result", tool_use_id: "toolu_1", content: "a" }]),
  user("n1", "<local-command-stdout>ignored</local-command-stdout>"),
  assistant("a3", [{ type: "tool_use", id: "toolu_2", name: "Bash", input: {} }]),
  user("i1", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
  user("p3", "third"),
];

test("a stored conversation is a turn for each prompt, known by the prompt's id", () => {
  const turns = toTurns(history, "/project");
  expect(turns.map((turn) => [turn.id, turn.status, turn.items.map((item) => item.kind)])).toEqual([
    ["p1", "completed", ["userMessage", "agentMessage"]],
    ["p2", "interrupted", ["userMessage", "command", "command"]],
    ["p3", "completed", ["userMessage"]],
  ]);
  expect(turns[1]?.items[1]).toMatchObject({ output: "a", status: "completed" });
  // A call with no result in a turn that was stopped never ran to its end.
  expect(turns[1]?.items[2]).toMatchObject({ status: "failed" });
  expect(historyModel(history)).toBe("claude-sonnet-5-5");
});

test("what came before a compaction is one mark, and a helper's of no known task is left out", () => {
  const turns = toTurns(
    [
      user("c1", "This session is being continued from a previous conversation that ran out"),
      assistant("a1", [{ type: "text", text: "kept" }]),
      { ...assistant("a2", [{ type: "text", text: "helper" }]), parent_tool_use_id: "toolu_1" },
    ],
    "/project",
  );
  expect(turns.map((turn) => turn.items.map((item) => item.kind))).toEqual([
    ["compaction", "agentMessage"],
  ]);
});

test("a conversation is cut, and copied, at the edges of its turns", () => {
  expect(turnPlace(history, "p1")).toBe("first");
  expect(turnPlace(history, "p2")).toBe("later");
  // A tool's result is no turn, and neither is an id nobody knows.
  expect(turnPlace(history, "r1")).toBe("unknown");
  expect(turnPlace(history, "gone")).toBe("unknown");
  expect(entryBefore(history, "p2")).toBe("a1");
  expect(entryBefore(history, "p1")).toBeNull();
  expect(lastEntryOf(history, "p1")).toBe("a1");
  expect(lastEntryOf(history, "p2")).toBe("i1");
  expect(lastEntryOf(history, "p3")).toBeNull();
});

test("each model is offered once, under its own id and name", () => {
  const sonnet = { resolvedModel: "claude-sonnet-5-5", description: "Sonnet 5.5 · Efficient" };
  const models = toModels([
    { ...sonnet, value: "default", displayName: "Default", supportedEffortLevels: ["low", "high"] },
    { ...sonnet, value: "sonnet", displayName: "Sonnet" },
    { value: "haiku", displayName: "Haiku", description: "Fast" },
  ]);
  expect(models).toMatchObject([
    {
      id: "claude-sonnet-5-5",
      harness: "claude",
      name: "Sonnet 5.5",
      description: "Efficient",
      defaultEffort: "high",
      isDefault: true,
      provider: null,
    },
    { id: "haiku", name: "Haiku", description: "Fast", efforts: [], defaultEffort: null },
  ]);
});

test("the default model is named by what it is now, and the picker marks it", () => {
  const [model] = toModels([
    {
      value: "default",
      resolvedModel: "claude-opus-5-5",
      displayName: "Default (recommended)",
      description: "Use the default model (currently Opus 5.5)",
    },
  ]);
  expect(model).toMatchObject({ id: "claude-opus-5-5", name: "Opus 5.5", isDefault: true });
  // Listed after the alias it points to, it still makes that model the default.
  const [alias] = toModels([
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus",
      description: "Opus 5.5 · Deep",
    },
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default", description: "" },
  ]);
  expect(alias).toMatchObject({ id: "claude-opus-5-5", isDefault: true });
});

test("every mode is given by name, and only bypassing permissions runs with nothing asked", () => {
  expect(modeOptions("default")).toEqual({ permissionMode: "default" });
  expect(modeOptions("readOnly")).toEqual({ permissionMode: "default" });
  for (const mode of ["acceptEdits", "auto"] as const) {
    expect(modeOptions(mode)).toEqual({
      permissionMode: mode,
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    });
  }
  expect(modeOptions("plan")).toEqual({ permissionMode: "plan" });
  expect(modeOptions("dontAsk")).toEqual({ permissionMode: "dontAsk" });
  expect(modeOptions("bypassPermissions")).toEqual({
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
  // A mode that needs nothing of the start another does is the same process.
  expect(processSpec("acceptEdits")).toBe(processSpec("auto"));
  expect(processSpec("default")).toBe(processSpec("plan"));
  expect(processSpec("default")).not.toBe(processSpec("acceptEdits"));
  expect(processSpec("default")).not.toBe(processSpec("bypassPermissions"));
  expect(processSpec("default")).toBe(processSpec("acceptEdits", true));
  const defaults = CLAUDE_MODES.filter((mode) => mode.isDefault);
  expect(defaults.map((mode) => mode.id)).toEqual(["acceptEdits"]);
  expect(CLAUDE_MODES.filter((mode) => mode.dangerous).map((mode) => mode.id)).toEqual([
    "bypassPermissions",
  ]);
});

test("a prompt carries its images, and names one that is a path", () => {
  const prompt = toUserMessage(
    { text: "look", images: ["data:image/png;base64,AAAA", "https://x.test/a.png", "/tmp/a.png"] },
    "u1",
    "s1",
    "next",
  );
  expect(prompt).toMatchObject({ uuid: "u1", session_id: "s1", priority: "next" });
  expect(prompt.message.content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", source: { type: "url", url: "https://x.test/a.png" } },
    { type: "text", text: "look\n\n[Image: /tmp/a.png]" },
  ]);
});

test("a session Claude Code lists is told as it knows it", () => {
  const info = { sessionId: "s1", summary: "x", lastModified: 9, firstPrompt: "hi", cwd: "/p" };
  expect(toSession({ ...info, gitBranch: "HEAD", createdAt: 3 })).toMatchObject({
    id: "s1",
    harness: "claude",
    title: null,
    preview: "hi",
    cwd: "/p",
    branch: null,
    createdAt: 3,
    updatedAt: 9,
  });
  expect(toSession({ ...info, gitBranch: "main", customTitle: " Mine " })).toMatchObject({
    title: "Mine",
    branch: "main",
    createdAt: 9,
  });
});
