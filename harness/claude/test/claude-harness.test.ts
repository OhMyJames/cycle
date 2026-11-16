import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import type { WireMessage } from "../src/wire.ts";
import { FakeSdk, assistant, settle, user } from "./fake-sdk.ts";

function setup(tools?: { name: string; url: string; key: string }) {
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
    ...(tools ? { tools } : {}),
  });
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  /** The events since the last look, as their types. */
  const seen = () => events.splice(0).map((event) => event.type);
  return { sdk, harness, events, seen, later };
}

const options = { mode: "default", model: "claude-sonnet-5-5" };
const prompt = (text: string) => ({ text, images: [] });
const result = (extra: Partial<WireMessage> = {}): WireMessage => ({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 7,
  modelUsage: { m: { inputTokens: 100, outputTokens: 10, contextWindow: 200_000 } },
  ...extra,
});

async function begun() {
  const all = setup();
  const session = await all.harness.createSession({ cwd: "/project", model: options.model });
  const { turnId } = await all.harness.send(session.id, prompt("hello"), options);
  await settle();
  return { ...all, session, turnId, query: all.sdk.last };
}

test("a session begins under its own id, with the mode's reach and the owner's settings", async () => {
  const { sdk, session, turnId, query, seen } = await begun();
  expect(session).toMatchObject({ id: "id1", harness: "claude", cwd: "/project" });
  // The first process only answered which models there are.
  expect(sdk.queries).toHaveLength(2);
  expect(query.options).toMatchObject({
    cwd: "/project",
    sessionId: "id1",
    model: "claude-sonnet-5-5",
    effort: "high",
    permissionMode: "default",
    settingSources: ["user", "project", "local"],
    includePartialMessages: true,
  });
  expect(query.options.resume).toBeUndefined();
  expect(query.options.allowDangerouslySkipPermissions).toBeUndefined();
  expect(query.prompts).toMatchObject([
    { uuid: turnId, message: { content: [{ text: "hello" }] } },
  ]);
  expect(seen()).toEqual(["turn.started", "item.completed"]);
});

test("a turn ends with what it used, and the next continues the stored session", async () => {
  const { sdk, harness, session, turnId, query, events, later } = await begun();
  events.length = 0;
  query.say({
    type: "assistant",
    uuid: "a1",
    message: { content: [{ type: "text", text: "hi" }] },
  });
  query.say(result());
  await settle();
  expect(events).toMatchObject([
    { type: "item.completed", turnId, item: { kind: "agentMessage", text: "hi" } },
    { type: "usage.updated", usage: { total: { total: 110 }, contextWindow: 200_000 } },
    { type: "turn.completed", turnId, status: "completed", error: null, durationMs: 7 },
  ]);
  // The same process takes the next prompt while the session runs as it did.
  await harness.send(session.id, prompt("again"), options);
  expect(sdk.queries).toHaveLength(2);
  query.say(result());
  await settle();
  // Another mode is another process, which continues what Claude Code stored.
  await harness.send(session.id, prompt("more"), { ...options, mode: "bypassPermissions" });
  expect(query.closed).toBe(true);
  expect(sdk.last.options).toMatchObject({
    resume: session.id,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
  expect(sdk.last.options.sessionId).toBeUndefined();
  // Idle long enough, a process is closed; one in a turn is not.
  expect(later).toHaveLength(0);
  sdk.last.say(result());
  await settle();
  later[0]?.();
  expect(sdk.last.closed).toBe(true);
});

test("a turn that fails says why, and one the owner stopped is theirs", async () => {
  const { harness, session, query, events } = await begun();
  query.say(result({ subtype: "error_during_execution", is_error: true, errors: ["no credit"] }));
  await settle();
  expect(events.at(-1)).toMatchObject({ status: "failed", error: "no credit" });
  await harness.send(session.id, prompt("again"), options);
  await harness.interrupt(session.id);
  expect(query.interrupts).toBe(1);
  query.say(result({ subtype: "error_during_execution", is_error: true, errors: ["diagnostic"] }));
  await settle();
  expect(events.at(-1)).toMatchObject({ status: "interrupted", error: null });
});

test("a process that goes away ends its turn, and the next prompt starts another", async () => {
  const { sdk, harness, session, turnId, query, events } = await begun();
  query.say(result());
  await settle();
  await harness.send(session.id, prompt("again"), options);
  query.exit(new Error("exited with code 1"));
  await settle();
  expect(events.at(-1)).toMatchObject({
    type: "turn.completed",
    status: "failed",
    error: "Claude Code stopped: exited with code 1. It starts again with your next message.",
  });
  expect(events.at(-1)).not.toMatchObject({ turnId });
  await harness.send(session.id, prompt("back"), options);
  expect(sdk.last).not.toBe(query);
  expect(sdk.last.options.resume).toBe(session.id);
});

test("Claude Code that cannot start is said so, and is not offered", async () => {
  const { sdk, harness } = setup();
  sdk.failStart = "claude: command not found";
  expect(harness.start()).rejects.toThrow("Claude Code could not start: claude: command not found");
  sdk.failStart = null;
  // The next look asks again.
  expect((await harness.listModels()).map((model) => model.id)).toEqual(["claude-sonnet-5-5"]);
  await harness.listModels();
  expect(sdk.queries).toHaveLength(2);
});

test("what Claude Code asks waits for the owner, and their answer goes back", async () => {
  const { harness, query, events, turnId } = await begun();
  const signal = new AbortController().signal;
  const asked = query.options.canUseTool?.(
    "Bash",
    { command: "rm -rf build" },
    { signal, toolUseID: "toolu_1", suggestions: [] },
  );
  expect(events.at(-1)).toMatchObject({
    type: "approval.requested",
    turnId,
    approval: { id: "toolu_1", kind: "command", command: "rm -rf build", cwd: "/project" },
  });
  harness.respondApproval("toolu_1", { decision: "decline" });
  expect(await asked).toMatchObject({ behavior: "deny" });
  expect(events.at(-1)).toEqual({
    type: "approval.resolved",
    sessionId: "id1",
    approvalId: "toolu_1",
  });
  // Its result comes back as an error, which is the owner's refusal and no failure.
  const call = {
    type: "tool_use",
    id: "toolu_1",
    name: "Bash",
    input: { command: "rm -rf build" },
  };
  const refused = { type: "tool_result", tool_use_id: "toolu_1", content: "no", is_error: true };
  query.say({ type: "assistant", uuid: "a1", message: { content: [call] } });
  query.say({ type: "user", message: { content: [refused] } });
  await settle();
  expect(events.at(-1)).toMatchObject({ item: { kind: "command", status: "declined" } });
});

test("a question still open when the turn is stopped is settled, and cancelling stops the turn", async () => {
  const { harness, query, events } = await begun();
  const stop = new AbortController();
  const context = { signal: stop.signal, toolUseID: "toolu_1" };
  const first = query.options.canUseTool?.("Write", { file_path: "a" }, context);
  stop.abort();
  expect(await first).toEqual({ behavior: "deny", message: "The turn was stopped." });
  expect(events.at(-1)).toMatchObject({ type: "approval.resolved" });
  // An answer that comes too late goes nowhere.
  harness.respondApproval("toolu_1", { decision: "accept" });

  const signal = new AbortController().signal;
  const second = query.options.canUseTool?.("Write", {}, { signal, toolUseID: "toolu_2" });
  harness.respondApproval("toolu_2", { decision: "cancel" });
  expect(await second).toMatchObject({ behavior: "deny", interrupt: true });
  query.say(result({ subtype: "error_during_execution", is_error: true }));
  await settle();
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" });
});

test("Cycle's own tools reach the process by its pipe alone, and are not asked about", async () => {
  const tools = { name: "cycle", url: "http://127.0.0.1:1/mcp", key: "the-tools-key" };
  const { sdk, harness, events } = setup(tools);
  const session = await harness.createSession({ cwd: "/project", model: options.model });
  await harness.send(session.id, prompt("hello"), options);
  const query = sdk.last;
  expect(query.servers).toEqual({
    cycle: { type: "http", url: tools.url, headers: { Authorization: "Bearer the-tools-key" } },
  });
  // Neither its arguments nor its environment hold the key: both are what its commands can read.
  expect(JSON.stringify(query.options)).not.toContain("the-tools-key");
  events.length = 0;
  const signal = new AbortController().signal;
  const context = { signal, toolUseID: "toolu_1" };
  expect(await query.options.canUseTool?.("mcp__cycle__list_sessions", {}, context)).toEqual({
    behavior: "allow",
    updatedInput: {},
  });
  expect(events).toEqual([]);
});

test("a prompt sent into a turn joins it, or begins the next when the turn took none", async () => {
  const { harness, session, turnId, query, events } = await begun();
  expect(harness.steer("nobody's", prompt("x"))).rejects.toThrow("No turn is running.");
  await harness.steer(session.id, prompt("also this"));
  await settle();
  expect(events.at(-1)).toMatchObject({ turnId, item: { id: "id3", kind: "userMessage" } });
  expect(query.prompts.at(-1)).toMatchObject({ uuid: "id3", priority: "next" });
  // The turn says which prompts it took: this one it took.
  query.say(result({ user_message_uuids: [turnId, "id3"] }));
  await settle();
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", turnId });

  await harness.send(session.id, prompt("second"), options);
  await harness.steer(session.id, prompt("too late"));
  events.length = 0;
  query.say(result({ user_message_uuids: ["id4"] }));
  await settle();
  // Claude Code runs it next by itself, so the conversation shows the turn it begins.
  expect(events.map((event) => event.type)).toEqual([
    "usage.updated",
    "turn.completed",
    "turn.started",
    "item.completed",
  ]);
  expect(events.at(-2)).toMatchObject({ turnId: "id5" });
});

const stored = [
  user("p1", "first"),
  assistant("a1", [{ type: "text", text: "one" }]),
  user("p2", "second"),
  assistant("a2", [{ type: "text", text: "two" }]),
];

function kept() {
  const all = setup();
  all.sdk.stored = [
    { sessionId: "s1", summary: "", lastModified: 5, cwd: "/project", firstPrompt: "first" },
    { sessionId: "s2", summary: "", lastModified: 6, cwd: "/other", archived: true },
    { sessionId: "s3", summary: "", lastModified: 7 },
  ];
  all.sdk.messages = { s1: stored };
  return all;
}

test("sessions Claude Code keeps are listed, the archived apart, and read back as turns", async () => {
  const { harness } = kept();
  // One with no folder cannot be continued, so it is not offered.
  expect((await harness.listSessions({ archived: false })).map((info) => info.id)).toEqual(["s1"]);
  expect((await harness.listSessions({ archived: true })).map((info) => info.id)).toEqual(["s2"]);
  const loaded = await harness.loadSession("s1", { mode: "acceptEdits" });
  expect(loaded.session).toMatchObject({ id: "s1", model: "claude-sonnet-5-5", preview: "first" });
  expect(loaded.turns.map((turn) => turn.id)).toEqual(["p1", "p2"]);
  // What it used is Claude Code's to say, with its next turn.
  expect(loaded.usage).toBeNull();
  expect(harness.loadSession("gone", {})).rejects.toThrow("not in Claude Code's history");
});

test("going back cuts the conversation as the next prompt is taken, and until then here", async () => {
  const { sdk, harness } = kept();
  expect(await harness.rewindSession("s1", "p2")).toEqual({ from: "p2" });
  expect((await harness.loadSession("s1", {})).turns.map((turn) => turn.id)).toEqual(["p1"]);
  // A copy of all of it is a copy of what is left.
  await harness.forkSession("s1", null);
  expect(sdk.calls).toEqual(["fork s1 a1"]);
  await harness.send("s1", prompt("another way"), options);
  expect(sdk.last.options).toMatchObject({ resume: "s1", resumeSessionAt: "a1" });
  expect(harness.rewindSession("s1", "a1")).rejects.toThrow("no longer keeps that turn");
});

test("back before its first turn, a conversation begins again under its id", async () => {
  const { sdk, harness } = kept();
  await harness.rewindSession("s1", "p1");
  expect((await harness.loadSession("s1", {})).turns).toEqual([]);
  expect(harness.forkSession("s1", null)).rejects.toThrow("nothing in this session to copy");
  await harness.send("s1", prompt("from the top"), options);
  expect(sdk.calls).toEqual(["delete s1"]);
  expect(sdk.last.options).toMatchObject({ sessionId: "s1" });
  expect(sdk.last.options.resume).toBeUndefined();
});

test("a copy ends with the turn it was asked up to, and the rest is Claude Code's to do", async () => {
  const { sdk, harness } = kept();
  const fork = await harness.forkSession("s1", "p1");
  expect(fork).toMatchObject({ id: "s1-fork", forkedFrom: "s1", harness: "claude" });
  await harness.forkSession("s1", "p2");
  await harness.renameSession("s1", "A name");
  await harness.archiveSession("s1", true);
  await harness.archiveSession("s1", false);
  await harness.deleteSession("s1");
  expect(sdk.calls).toEqual([
    "fork s1 a1",
    "fork s1 all",
    "rename s1 A name",
    "archive s1",
    "unarchive s1",
    "delete s1",
  ]);
  // A session with no turn yet is ours alone: there is nothing of Claude Code's to change.
  const fresh = await harness.createSession({ cwd: "/project" });
  await harness.renameSession(fresh.id, "New");
  await harness.deleteSession(fresh.id);
  expect(sdk.calls).toHaveLength(6);
});

test("a review is a prompt, and compacting is a turn with no prompt of the owner's", async () => {
  const { harness, session, query, events } = await begun();
  query.say(result());
  await settle();
  await harness.review(session.id, { kind: "branch", branch: "main" }, options);
  await settle();
  expect(query.prompts.at(-1)?.message.content[0]?.text).toContain("since it left `main`");
  expect(harness.compactSession(session.id)).rejects.toThrow("Wait for the turn to finish");
  query.say(result());
  await settle();
  events.length = 0;
  await harness.compactSession(session.id);
  await settle();
  expect(query.prompts.at(-1)?.message.content).toEqual([{ type: "text", text: "/compact" }]);
  query.say({ type: "system", subtype: "compact_boundary", uuid: "c1" });
  query.say(result());
  await settle();
  expect(events.map((event) => event.type)).toEqual([
    "turn.started",
    "item.completed",
    "usage.updated",
    "turn.completed",
  ]);
  expect(events[1]).toMatchObject({ item: { id: "c1", kind: "compaction" } });
});
