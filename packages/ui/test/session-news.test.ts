import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { ToolItem } from "../src/model/index.ts";
import { applyUpdate, blocksOf, emptyConversation } from "../src/model/index.ts";

const reduce = (...updates: object[]) =>
  (updates as SessionUpdate[]).reduce((c, u) => applyUpdate(c, u), emptyConversation());
const call = (id: string, name: string, kind: string, status: string) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  name,
  kind,
  status,
});
const news = (state: object | undefined, meta: object) => ({
  sessionUpdate: "subagent_update",
  sessionId: "task-1",
  ...(state !== undefined ? { state } : {}),
  _meta: { "cycle/subagent": { toolCallId: "a", ...meta } },
});

test("a sub-agent's news goes onto the call that started it; what an update leaves out stays", () => {
  const c = reduce(
    call("a", "Agent", "other", "in_progress"),
    news({ state: "running" }, { background: true }),
    news(undefined, { lastTool: "Read" }),
    call("a", "Agent", "other", "completed"),
    news(
      { state: "idle", stopReason: "end_turn" },
      { usage: { tokens: 9, toolUses: 4, durationMs: 63000 } },
    ),
  );
  const tool = c.items[0] as ToolItem;
  expect(tool.subagent).toEqual({
    id: "task-1",
    state: "done",
    background: true,
    lastTool: "Read",
    usage: { tokens: 9, toolUses: 4, durationMs: 63000 },
  });
  // News that comes before its call waits for it; a count left out stays.
  const early = reduce(
    news({ state: "running" }, { background: true, usage: { toolUses: 7, durationMs: 42000 } }),
    news(undefined, { usage: { tokens: 5000 } }),
    call("a", "Agent", "other", "in_progress"),
  );
  expect((early.items[0] as ToolItem).subagent).toEqual({
    id: "task-1",
    state: "running",
    background: true,
    usage: { tokens: 5000, toolUses: 7, durationMs: 42000 },
  });
  expect(early.waiting).toEqual({});
  // A sub-agent's own sub-agent: its call is never seen here, so its news is not kept.
  const nested = reduce(news({ state: "running" }, { parentId: "task-0" }));
  expect(nested.waiting).toEqual({});
  // News whose call never comes does not pile up.
  const many = reduce(
    ...Array.from({ length: 40 }, (_, n) => ({
      ...news({ state: "running" }, {}),
      _meta: { "cycle/subagent": { toolCallId: `x${n}` } },
    })),
  );
  expect(Object.keys(many.waiting).length).toBeLessThanOrEqual(16);
});

test("a compaction is one line where it began, and changes in place", () => {
  const c = reduce(
    { sessionUpdate: "compaction_update", compactionId: "k", status: "in_progress" },
    {
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "k",
      content: { type: "text", text: "notes" },
    },
    { sessionUpdate: "compaction_update", compactionId: "k", status: "completed" },
  );
  expect(c.items).toEqual([{ kind: "compaction", id: "k", turn: 0, status: "completed" }]);
  expect(blocksOf(c).map((b) => b.kind)).toEqual(["compaction"]);
});

test("changing the plan is not a row, even while it goes; one that failed is, and neither cuts a stretch of work", () => {
  const c = reduce(
    call("r", "Read", "read", "completed"),
    call("t", "TaskCreate", "think", "completed"),
    call("g", "TaskCreate", "think", "in_progress"),
    call("e", "Edit", "edit", "completed"),
    call("u", "TaskUpdate", "think", "failed"),
  );
  const [work] = blocksOf(c);
  expect(work?.kind === "work" ? work.tools.map((t) => t.id) : []).toEqual(["r", "e", "u"]);
});

const child = (childId: string, update: object) => ({
  sessionUpdate: "_cycle/child_update",
  childId,
  update,
});

test("a sub-agent's conversation goes onto its call, apart from the main agent's, and ends with it", () => {
  const c = reduce(
    call("a", "Agent", "other", "in_progress"),
    news({ state: "running" }, {}),
    child("task-1", {
      sessionUpdate: "agent_message_chunk",
      messageId: "s1",
      content: { type: "text", text: "Looking" },
    }),
    child("task-1", call("r", "Read", "read", "in_progress")),
    child("task-1", call("r", "Read", "read", "completed")),
    child("task-1", call("g", "Grep", "search", "in_progress")),
    // What is not a conversation's, and a sub-agent nobody announced, are not drawn.
    child("task-1", {
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "p", entries: [] },
    }),
    child("task-9", call("z", "Read", "read", "in_progress")),
  );
  // The main conversation has only the Agent call: nothing of the sub-agent reads as the main agent's.
  expect(c.items.map((item) => item.id)).toEqual(["a"]);
  expect(c.ignored).toBe(2);
  const sub = (c.items[0] as ToolItem).subagent;
  expect(sub?.conversation?.items.map((item) => [item.kind, item.id])).toEqual([
    ["agent", "s1"],
    ["tool", "r"],
    ["tool", "g"],
  ]);
  // It ended with a call still going: that call did not finish.
  const over = applyUpdate(
    c,
    news({ state: "idle", stopReason: "end_turn" }, {}) as unknown as SessionUpdate,
  );
  const items = (over.items[0] as ToolItem).subagent?.conversation?.items as ToolItem[];
  expect(items.map((item) => (item.kind === "tool" ? item.status : "agent"))).toEqual([
    "agent",
    "completed",
    "cancelled",
  ]);
  // The main turn's end leaves a background sub-agent's calls as they are.
  const background = applyUpdate(c, {
    sessionUpdate: "state_update",
    state: "idle",
    stopReason: "end_turn",
  } as unknown as SessionUpdate);
  const still = (background.items[0] as ToolItem).subagent?.conversation?.items[2] as ToolItem;
  expect(still.status).toBe("in_progress");
});

test("a sub-agent's own sub-agent is put on the call that started it, in its parent's conversation", () => {
  const c = reduce(
    call("a", "Agent", "other", "in_progress"),
    news({ state: "running" }, {}),
    child("task-1", call("a2", "Agent", "other", "in_progress")),
    {
      sessionUpdate: "subagent_update",
      sessionId: "task-2",
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "a2", parentId: "task-1" } },
    },
    child("task-2", call("r2", "Read", "read", "in_progress")),
  );
  const inner = (c.items[0] as ToolItem).subagent?.conversation?.items[0] as ToolItem;
  expect(inner.subagent?.id).toBe("task-2");
  expect(inner.subagent?.conversation?.items.map((item) => item.id)).toEqual(["r2"]);
  // Its parent ended and its own end never came: it stopped with it, and nothing of it is left going.
  const over = applyUpdate(
    c,
    news({ state: "idle", stopReason: "cancelled" }, {}) as unknown as SessionUpdate,
  );
  const stopped = (over.items[0] as ToolItem).subagent?.conversation?.items[0] as ToolItem;
  expect(stopped.status).toBe("cancelled");
  expect(stopped.subagent?.state).toBe("stopped");
  expect((stopped.subagent?.conversation?.items[0] as ToolItem | undefined)?.status).toBe(
    "cancelled",
  );
});

test("a sub-agent is stoppable once its agent says so, until it takes that back (CYCL-143)", () => {
  const stoppable = (...updates: object[]) =>
    (reduce(call("a", "Agent", "other", "in_progress"), ...updates).items[0] as ToolItem).subagent
      ?.stoppable;
  const said = { ...news({ state: "running" }, {}), capabilities: { cancel: {} } };
  expect(stoppable(news({ state: "running" }, {}))).toBeUndefined();
  expect(stoppable(said)).toBe(true);
  // Left out: it stays.
  expect(stoppable(said, news(undefined, { lastTool: "Read" }))).toBe(true);
  // Taken back, whole or the one capability.
  expect(stoppable(said, { ...news(undefined, {}), capabilities: null })).toBeUndefined();
  expect(
    stoppable(said, { ...news(undefined, {}), capabilities: { cancel: null } }),
  ).toBeUndefined();
});
