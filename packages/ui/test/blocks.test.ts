import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import {
  activityCounts,
  activityOf,
  applyUpdate,
  type BlockCache,
  blocksOf,
  type Conversation,
  commandLabelOf,
  commandOf,
  earlierAnchor,
  type FoldCache,
  foldedBlocks,
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

test("a code review on its way is said on the line, since its call shows nothing until its findings come", () => {
  const skill = (id: string, rawInput?: object) =>
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      name: "Skill",
      status: "in_progress",
      rawInput,
    });
  expect(stepOf(reduce([you("u"), running, skill("s", { skill: "code-review" })]))).toEqual({
    kind: "review",
  });
  // Not yet named: it may be the review, so it shows no row, and the line is not quiet for it.
  expect(stepOf(reduce([you("u"), running, skill("s")]))).toEqual({ kind: "working" });
  // Another skill is a call like any other: its row says it is at work.
  expect(stepOf(reduce([you("u"), running, skill("s", { skill: "run" })]))).toMatchObject({
    kind: "tool",
  });
  // Something done after it, in the same turn, does not hide it: the review is still what is going.
  const review = skill("s", { skill: "code-review" });
  expect(stepOf(reduce([you("u"), running, review, tool("a", "Bash")]))).toEqual({
    kind: "review",
  });
  // A call at work after it says so on its own row.
  expect(
    stepOf(reduce([you("u"), running, review, tool("a", "Bash", "in_progress")])),
  ).toMatchObject({ kind: "tool" });
  // Reporting findings is not reviewing: the agent is at work, and the line is not quiet for a call with no row.
  const report = (findings?: object[]) =>
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "r",
      name: "ReportFindings",
      status: "in_progress",
      rawInput: findings === undefined ? undefined : { findings },
    });
  expect(stepOf(reduce([you("u"), running, report()]))).toEqual({ kind: "working" });
  const found = { file: "a.ts", summary: "It breaks.", failure_scenario: "When empty." };
  expect(stepOf(reduce([you("u"), running, report([found])]))).toEqual({ kind: "working" });
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

const folds = (c: Conversation) =>
  foldedBlocks(blocksOf(c), c.stops).map((b) =>
    b.kind === "fold"
      ? `fold(${b.blocks.map((inner) => (inner.kind === "work" ? "work" : inner.kind)).join(",")})`
      : b.kind,
  );

test("a turn that ended normally folds the work before its last reply, and keeps what was said", () => {
  const c = reduce([
    you("u"),
    say("first"),
    tool("a", "Bash"),
    think("t"),
    tool("b", "Read"),
    say("answer"),
    idle("end_turn"),
  ]);
  expect(folds(c)).toEqual(["user", "fold(agent,work,thought)", "agent"]);
  const fold = foldedBlocks(blocksOf(c), c.stops)[1];
  // It begins after the turn's first block, so it does not take the space a turn begins with.
  expect(fold?.startsTurn).toBe(false);
});

test("a turn still going, one that did not end normally, and one with no reply are not folded", () => {
  const going = reduce([you("u"), tool("a", "Bash"), say("m"), running]);
  expect(folds(going)).toEqual(["user", "work", "agent"]);
  const stopped = reduce([you("u"), tool("a", "Bash"), say("m"), idle("cancelled")]);
  expect(folds(stopped)).toEqual(["user", "work", "agent", "end"]);
  const silent = reduce([you("u"), tool("a", "Bash"), idle("end_turn")]);
  expect(folds(silent)).toEqual(["user", "work"]);
});

test("a turn with only its reply has nothing to fold, and what follows the reply stays", () => {
  expect(folds(reduce([you("u"), say("m"), idle("end_turn")]))).toEqual(["user", "agent"]);
  expect(
    folds(reduce([you("u"), tool("a", "Bash"), say("m"), tool("b", "Bash"), idle("end_turn")])),
  ).toEqual(["user", "fold(work)", "agent", "work"]);
});

test("a message put into the turn while it went is not folded: it splits the work", () => {
  const c = reduce([
    you("u"),
    tool("a", "Bash"),
    you("more"),
    tool("b", "Read"),
    say("m"),
    idle("end_turn"),
  ]);
  expect(folds(c)).toEqual(["user", "fold(work)", "user", "fold(work)", "agent"]);
});

test("a fold says how long the turn worked before its answer, when both times are known", () => {
  const timed: [SessionUpdate, number | undefined][] = [
    [you("u"), 1_000],
    [tool("a", "Bash"), 2_000],
    [say("m"), 49_000],
    [idle("end_turn"), undefined],
  ];
  const c = timed.reduce((c, [update, at]) => applyUpdate(c, update, { at }), reduce([]));
  const fold = foldedBlocks(blocksOf(c), c.stops).find((b) => b.kind === "fold");
  expect(fold).toMatchObject({ kind: "fold", ms: 48_000 });
  const untimed = reduce([you("u"), tool("a", "Bash"), say("m"), idle("end_turn")]);
  expect(
    foldedBlocks(blocksOf(untimed), untimed.stops).find((b) => b.kind === "fold"),
  ).not.toHaveProperty("ms");
});

test("a folded turn that has not changed gives back the very same blocks", () => {
  const cache: FoldCache = new Map();
  const first = reduce([you("u"), tool("a", "Bash"), say("m"), idle("end_turn"), you("v")]);
  const laid = blocksOf(first);
  const before = foldedBlocks(laid, first.stops, cache);
  const after = foldedBlocks(laid, first.stops, cache);
  expect(after[1]).toBe(before[1] as LaidBlock);
});

test("a sub-agent still at work after the turn is not folded: its card is the sign that something runs", () => {
  const c = reduce([
    you("u"),
    tool("a", "Bash"),
    tool("x", "Agent", "completed"),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub",
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "x", background: true } },
    }),
    say("started it in the background"),
    idle("end_turn"),
  ]);
  expect(folds(c)).toEqual(["user", "fold(work)", "subagent", "agent"]);
});

test("a fold keeps its key when the display mode shows or leaves out the thought it begins with", () => {
  const c = reduce([you("u"), think("t"), tool("a", "Bash"), say("m"), idle("end_turn")]);
  const keyIn = (mode: "normal" | "detailed") =>
    foldedBlocks(shownBlocks(blocksOf(c), mode), c.stops).find((b) => b.kind === "fold")?.key;
  expect(keyIn("detailed")).toBe(keyIn("normal"));
});

test("a fold under a second does not say how long", () => {
  const timed: [SessionUpdate, number | undefined][] = [
    [you("u"), 1_000],
    [tool("a", "Bash"), 1_200],
    [say("m"), 1_400],
    [idle("end_turn"), undefined],
  ];
  const c = timed.reduce((c, [update, at]) => applyUpdate(c, update, { at }), reduce([]));
  expect(foldedBlocks(blocksOf(c), c.stops).find((b) => b.kind === "fold")).not.toHaveProperty(
    "ms",
  );
});

test("commandOf and commandLabelOf handle canonical command, legacy CommandLine, shell wrappers, and title-only execute logs", () => {
  const mk = (over: Partial<ToolItem>): ToolItem => ({
    kind: "tool",
    id: "t",
    turn: 0,
    content: [],
    status: "completed",
    toolKind: "execute",
    ...over,
  });

  const codexWrapped = mk({
    name: "exec_command",
    rawInput: { command: '/bin/zsh -lc "rg -n foo src"' },
  });
  expect(commandOf(codexWrapped)).toBe('/bin/zsh -lc "rg -n foo src"');
  expect(commandLabelOf(codexWrapped)).toEqual({
    kind: "search",
    detail: "'foo' in src",
    count: 1,
  });
  expect(activityOf(codexWrapped)).toBe("search");

  const codexLegacy = mk({
    name: "exec_command",
    title: "/bin/zsh -lc 'bun test'",
  });
  expect(commandOf(codexLegacy)).toBe("/bin/zsh -lc 'bun test'");
  expect(activityOf(codexLegacy)).toBe("run");

  const agyLegacy = mk({
    name: "run_command",
    rawInput: { CommandLine: "cat README.md" },
  });
  expect(commandOf(agyLegacy)).toBe("cat README.md");
  expect(commandLabelOf(agyLegacy)).toEqual({ kind: "read", detail: "README.md", count: 1 });
  expect(activityOf(agyLegacy)).toBe("read");

  // Pending call with only a bare tool name does not fabricate a command.
  expect(commandOf(mk({ name: "exec_command", title: "exec_command" }))).toBeUndefined();
});
