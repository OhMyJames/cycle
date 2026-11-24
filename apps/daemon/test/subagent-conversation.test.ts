// A sub-agent's conversation (docs/protocol.md §9, CYCL-134): the agent speaks for an announced sub-agent under its id,
// and the daemon keeps that as `_cycle/child_update` records of the parent session.
import { expect, test } from "bun:test";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { daemonHarness } from "./support.ts";

let dir: string;
const open = daemonHarness<Daemon>((made) => {
  dir = made;
});

const text = (value: string) => [{ type: "text" as const, text: value }];
const words = (messageId: string, said: string) => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text: said },
});
const kindOf = (update: unknown) => (update as { sessionUpdate: string }).sessionUpdate;

test("a sub-agent's conversation is kept in its parent's history, and a permission it asks for says whose it is", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say, ask }) => {
      // Before it is announced, an id is no sub-agent's: what comes under it is the session's own, as before.
      await say(words("m0", "early"), "task-1");
      await say({
        sessionUpdate: "subagent_update",
        sessionId: "task-1",
        title: "Look",
        state: { state: "running" },
        _meta: { "cycle/subagent": { toolCallId: "agent-1" } },
      });
      await say(words("s1", "Looking"), "task-1");
      await say(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "bash-1",
          name: "Bash",
          status: "in_progress",
          rawInput: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234567890' x" },
          _meta: { "cycle/toolResult": { nonsense: true } },
        },
        "task-1",
      );
      // What is not its conversation is not the session's either: its state is the subagent_update's.
      await say({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }, "task-1");
      await say(
        { sessionUpdate: "plan_update", plan: { type: "items", planId: "p", entries: [] } },
        "task-1",
      );
      // Only the daemon makes these: one the agent sends is dropped.
      await say({
        sessionUpdate: "_cycle/child_update",
        childId: "task-1",
        update: words("x", "x"),
      });
      await ask({ sessionId: "task-1", _meta: { "cycle/subagentId": "forged" } });
      await ask({ _meta: { "cycle/subagentId": "forged" } });
    },
  });
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");

  const updates = c.seen.map((s) => s.update as unknown as Record<string, unknown>);
  const children = updates.filter((u) => u.sessionUpdate === "_cycle/child_update");
  expect(children.map((u) => kindOf(u.update))).toEqual([
    "agent_message_chunk",
    "tool_call_update",
  ]);
  expect(children.every((u) => u.childId === "task-1")).toBe(true);
  const call = children[1]?.update as {
    rawInput: { command: string };
    _meta?: Record<string, unknown>;
  };
  // Filtered as a call of the session's own is: the credential is gone, and a result that is no result.
  expect(call.rawInput.command).not.toContain("abcdefghijklmnop1234567890");
  expect(call._meta?.["cycle/toolResult"]).toBeUndefined();
  // What came before it was announced is the session's own; the sub-agent's state ended no turn of the session's.
  expect(
    updates.some((u) => u.sessionUpdate === "agent_message_chunk" && u.messageId === "m0"),
  ).toBe(true);
  expect(updates.filter((u) => u.sessionUpdate === "plan_update")).toEqual([]);
  expect(c.ended()).toBe(1);

  // The client is asked in the parent session and told which sub-agent asks; the agent's own word for it is not taken.
  const asked = c.permissions as { sessionId: string; _meta: Record<string, unknown> }[];
  expect(asked.map((p) => p.sessionId)).toEqual([sessionId, sessionId]);
  expect(asked.map((p) => p._meta["cycle/subagentId"])).toEqual(["task-1", undefined]);

  // And it is history: a client that opens the session later gets the same, with the parent's seq.
  const later = await connectClient(daemon);
  await later.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  } as never);
  await until(
    () => later.seen.some((s) => kindOf(s.update) === "replay_complete"),
    "the replay to complete",
  );
  const replayed = later.seen.filter((s) => kindOf(s.update) === "_cycle/child_update");
  expect(replayed.map((s) => s.update)).toEqual(children as never);
  expect(replayed.every((s) => typeof s.seq === "number")).toBe(true);
});

const sub = (id: string, extra: object) => ({
  sessionUpdate: "subagent_update",
  sessionId: id,
  _meta: { "cycle/subagent": { toolCallId: `call-${id}` } },
  ...extra,
});

test("one sub-agent is stopped alone, only when its agent said it can be and it is at work (CYCL-143)", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say(sub("task-1", { state: { state: "running" }, capabilities: { cancel: {} } }));
      // Says nothing of being stoppable: it is not.
      await say(sub("task-2", { state: { state: "running" } }));
      // Said it could, then ended.
      await say(sub("task-3", { state: { state: "running" }, capabilities: { cancel: {} } }));
      await say(sub("task-3", { state: { state: "idle", stopReason: "end_turn" } }));
      // Said it could, then took it back.
      await say(sub("task-4", { state: { state: "running" }, capabilities: { cancel: {} } }));
      await say(sub("task-4", { capabilities: null }));
    },
  });
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  const ops = (c.init as { _meta?: Record<string, { sessionOps?: string[] }> })._meta?.[
    "cycle/capabilities"
  ]?.sessionOps;
  expect(ops).toContain("stopSubagent");
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  const stop = (childId: string) =>
    c.agent.request(
      "_cycle/session/stop_subagent" as never,
      { sessionId, childId } as never,
    ) as Promise<{ stopping: boolean }>;
  expect(await stop("task-1")).toEqual({ stopping: true });
  // Nor the session itself: a cancel in its own id would be the turn's.
  for (const id of ["task-2", "task-3", "task-4", "task-9", sessionId])
    expect(await stop(id)).toEqual({ stopping: false });
  await until(() => fake.log.childCancels.length > 0, "the agent to be told");
  // Only that sub-agent's session is cancelled: the session's own turn is not.
  expect(fake.log.childCancels).toEqual(["task-1"]);
  expect(fake.log.cancels).toBe(0);
});
