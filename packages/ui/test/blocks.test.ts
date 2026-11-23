import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import {
  activityCounts,
  activityOf,
  type BlockCache,
  blocksOf,
  type Conversation,
  earlierAnchor,
  type LaidBlock,
  PAGE,
  reduce,
  shownBlocks,
  stepOf,
  type ToolItem,
  windowStart,
} from "../src/model/index.ts";

const u = (update: object) => update as SessionUpdate;
const you = (id: string) =>
  u({ sessionUpdate: "user_message", messageId: id, content: [{ type: "text", text: id }] });
const say = (id: string) =>
  u({ sessionUpdate: "agent_message", messageId: id, content: [{ type: "text", text: id }] });
const think = (id: string) =>
  u({ sessionUpdate: "agent_thought", messageId: id, content: [{ type: "text", text: id }] });
const chunk = (id: string, text: string) =>
  u({ sessionUpdate: "agent_thought_chunk", messageId: id, content: { type: "text", text } });
const tool = (id: string, name: string, status = "completed") =>
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name, status });
const running = u({ sessionUpdate: "state_update", state: "running" });
const idle = (stopReason: string, extra: object = {}) =>
  u({ sessionUpdate: "state_update", state: "idle", stopReason, ...extra });

const shape = (c: Conversation) =>
  blocksOf(c).map((b) =>
    b.kind === "work" ? `work(${b.tools.map((t) => t.id).join(",")})` : b.kind,
  );

test("the tool calls of one stretch share a block, and a message cuts the stretch", () => {
  const c = reduce([
    you("u"),
    tool("a", "Bash"),
    tool("b", "Read"),
    say("m"),
    tool("c", "Bash"),
    idle("end_turn"),
  ]);
  expect(shape(c)).toEqual(["user", "work(a,b)", "agent", "work(c)"]);
});

test("a sub-agent is a card of its own and cuts the stretch, by its tool's name or by its own updates", () => {
  const c = reduce([
    you("u"),
    tool("a", "Bash"),
    tool("s", "Agent", "in_progress"),
    tool("b", "Read"),
    tool("x", "mcp__review"),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub",
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "x" } },
    }),
    tool("c", "Bash"),
    idle("end_turn"),
  ]);
  expect(shape(c)).toEqual(["user", "work(a)", "subagent", "work(b)", "subagent", "work(c)"]);
});

test("a thought is a row of its own, and never cuts a stretch", () => {
  const c = reduce([you("u"), tool("a", "Bash"), think("t"), tool("b", "Bash"), idle("end_turn")]);
  expect(shape(c)).toEqual(["user", "work(a,b)", "thought"]);
});

test("normal mode leaves thoughts out, detailed keeps those with words, and a turn still begins where it did", () => {
  const c = reduce([
    you("u"),
    idle("end_turn"),
    think("t1"),
    chunk("t0", ""),
    say("m"),
    idle("end_turn"),
  ]);
  const laid = blocksOf(c);
  const kinds = (blocks: LaidBlock[]) => blocks.map((b) => `${b.kind}${b.startsTurn ? "^" : ""}`);
  expect(kinds(laid)).toEqual(["user^", "thought^", "thought", "agent"]);
  expect(kinds(shownBlocks(laid, "detailed"))).toEqual(["user^", "thought^", "agent"]);
  // The turn that began with a thought now begins at its reply.
  expect(kinds(shownBlocks(laid, "normal"))).toEqual(["user^", "agent^"]);
  // What is kept as it was is the same object, so it is not drawn again.
  expect(shownBlocks(laid, "normal")[0]).toBe(laid[0]);
});

test("a plan and a notice are blocks of their own and cut a stretch", () => {
  const c = reduce([
    you("u"),
    tool("a", "Bash"),
    u({ sessionUpdate: "plan_update", plan: { type: "items", planId: "p", entries: [] } }),
    tool("b", "Bash"),
    u({ sessionUpdate: "notice", severity: "info", title: "Compacted" }),
    tool("c", "Bash"),
  ]);
  expect(shape(c)).toEqual(["user", "work(a)", "plan", "work(b)", "notice", "work(c)"]);
});

test("each turn begins a group, and a turn's blocks are the ones that belong to it", () => {
  const c = reduce([
    you("u1"),
    say("a1"),
    idle("end_turn"),
    you("u2"),
    tool("t", "Bash"),
    say("a2"),
    idle("end_turn"),
  ]);
  const blocks = blocksOf(c);
  expect(blocks.map((b) => [b.kind, b.turn, b.startsTurn])).toEqual([
    ["user", 0, true],
    ["agent", 0, false],
    ["user", 1, true],
    ["work", 1, false],
    ["agent", 1, false],
  ]);
});

test("a turn that ends normally says nothing at its end", () => {
  expect(shape(reduce([you("u"), say("a"), idle("end_turn")]))).toEqual(["user", "agent"]);
});

test.each(["cancelled", "error", "max_tokens", "refusal", "max_turn_requests"])(
  "a turn that ends as %s says so, last",
  (reason) => {
    const c = reduce([you("u"), say("a"), idle(reason)]);
    const last = blocksOf(c).at(-1);
    expect(last).toMatchObject({ kind: "end", stop: { stopReason: reason } });
  },
);

test("in a turn that stopped, the failures of its last stretch are pulled out of the card", () => {
  const c = reduce([
    you("u"),
    tool("a", "Bash"),
    tool("b", "Read", "failed"),
    tool("c", "Bash"),
    idle("error", { error: { message: "boom" } }),
  ]);
  expect(shape(c)).toEqual(["user", "work(a,c)", "failed", "end"]);
});

test("if every call of that stretch failed, no card is left", () => {
  const c = reduce([you("u"), tool("a", "Bash", "failed"), idle("cancelled")]);
  expect(shape(c)).toEqual(["user", "failed", "end"]);
});

test("a failure stays in its card when the turn ended well, or when the agent said something after it", () => {
  const ended = reduce([
    you("u"),
    tool("a", "Bash", "failed"),
    tool("b", "Bash"),
    idle("end_turn"),
  ]);
  expect(shape(ended)).toEqual(["user", "work(a,b)"]);
  const answered = reduce([you("u"), tool("a", "Bash", "failed"), say("m"), idle("max_tokens")]);
  expect(shape(answered)).toEqual(["user", "work(a)", "agent", "end"]);
});

test("an earlier stretch's failures stay where they are", () => {
  const c = reduce([
    you("u"),
    tool("a", "Bash", "failed"),
    say("m"),
    tool("b", "Bash"),
    idle("cancelled"),
  ]);
  expect(shape(c)).toEqual(["user", "work(a)", "agent", "work(b)", "end"]);
});

test("a thought after the last stretch does not stop its failures being pulled out", () => {
  const c = reduce([you("u"), tool("a", "Bash", "failed"), think("t"), idle("cancelled")]);
  expect(shape(c)).toEqual(["user", "failed", "thought", "end"]);
});

test("a turn that ended with nothing in it still says how", () => {
  const c = reduce([
    idle("error", { error: { message: "The agent exited" } }),
    you("u2"),
    say("a"),
  ]);
  expect(shape(c)).toEqual(["end", "user", "agent"]);
  expect(blocksOf(c)[0]).toMatchObject({ kind: "end", turn: 0, startsTurn: true });
});

test("a message sent while a turn was going belongs to that turn, so the turn's ending comes after it", () => {
  const c = reduce([you("u1"), tool("a", "Bash"), you("queued"), say("m"), idle("cancelled")]);
  expect(shape(c)).toEqual(["user", "work(a)", "user", "agent", "end"]);
});

test("every block has a key that is its own, across turns", () => {
  const c = reduce([
    you("u1"),
    tool("a", "Bash", "failed"),
    idle("cancelled"),
    you("u2"),
    tool("b", "Bash"),
    say("m"),
    idle("end_turn"),
  ]);
  const keys = blocksOf(c).map((b) => b.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("a turn that has not changed gives back the very same blocks", () => {
  const cache: BlockCache = new Map();
  const first = reduce([you("u1"), tool("a", "Bash"), say("a1"), idle("end_turn"), you("u2")]);
  const before = blocksOf(first, cache);
  const second = reduce([say("a2")], first);
  const after = blocksOf(second, cache);
  // The finished first turn is reused object for object; the turn that is going is laid again.
  expect(after[0]).toBe(before[0]);
  expect(after[1]).toBe(before[1]);
  expect(after[2]).toBe(before[2]);
  expect(after.length).toBe(before.length + 1);
});

test("what a tool does comes from Claude's name, else from the kind ACP gives it", () => {
  const t = (name: string | undefined, toolKind?: string) =>
    ({ kind: "tool", id: "x", turn: 0, content: [], name, toolKind }) as ToolItem;
  expect(activityOf(t("Bash"))).toBe("run");
  expect(activityOf(t("Glob"))).toBe("search");
  expect(activityOf(t("mcp__x__y", "read"))).toBe("read");
  expect(activityOf(t("mcp__x__y", "delete"))).toBe("edit");
  expect(activityOf(t(undefined))).toBe("other");
});

test("a card's counts follow the order the work first happened in", () => {
  const c = reduce([tool("a", "Read"), tool("b", "Bash"), tool("c", "Read"), tool("d", "Edit")]);
  const tools = c.items as ToolItem[];
  expect(activityCounts(tools)).toEqual([
    { activity: "read", count: 2 },
    { activity: "run", count: 1 },
    { activity: "edit", count: 1 },
  ]);
});

test("the step says what is going on, and says nothing when the text itself is arriving", () => {
  const step = (updates: SessionUpdate[]) => stepOf(reduce(updates));
  expect(step([you("u"), idle("end_turn")])).toBeUndefined();
  expect(step([you("u"), running])).toEqual({ kind: "working" });
  // A thought on its way says "Thinking…" here, whether its words are shown or not.
  expect(step([you("u"), running, think("t")])).toEqual({ kind: "thinking" });
  expect(step([you("u"), running, say("m")])).toBeUndefined();
  expect(step([you("u"), running, tool("a", "Bash", "in_progress")])).toMatchObject({
    kind: "tool",
    tool: { id: "a" },
  });
  // The last call is done and nothing has come after it: the agent is working on what it learned.
  expect(step([you("u"), running, tool("a", "Bash")])).toEqual({ kind: "working" });
  expect(step([you("u"), u({ sessionUpdate: "state_update", state: "requires_action" })])).toEqual({
    kind: "approval",
  });
});

const many = (turns: number) =>
  blocksOf(
    reduce(
      Array.from({ length: turns }, (_, n) => [
        you(`u${n}`),
        say(`m${n}`),
        idle("end_turn"),
      ]).flat(),
    ),
  );

test("a long conversation shows its last page, and nothing is hidden in a short one", () => {
  const blocks = many(PAGE); // twice as many blocks as a page
  expect(blocks.length).toBe(PAGE * 2);
  expect(windowStart(blocks, undefined)).toBe(PAGE);
  expect(windowStart(many(10), undefined)).toBe(0);
});

test("the window begins at its anchor, so what arrives at the end does not move the top", () => {
  const blocks = many(PAGE);
  const anchor = blocks[PAGE]?.key;
  expect(windowStart(blocks, anchor)).toBe(PAGE);
  const more = many(PAGE + 5);
  expect(windowStart(more, anchor)).toBe(PAGE);
});

test("an anchor that is gone falls back to the last page, and earlier moves it up by a page", () => {
  const blocks = many(PAGE);
  expect(windowStart(blocks, "nobody")).toBe(PAGE);
  expect(earlierAnchor(blocks, PAGE)).toBe(blocks[0]?.key);
  expect(earlierAnchor(blocks, 10)).toBe(blocks[0]?.key);
});
