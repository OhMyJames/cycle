import { expect, test } from "bun:test";
import type { Item, Turn } from "@cycle/protocol";
import { type ActivityItem, activitySummary, plainCommand } from "../src/lib/activity.ts";
import { type Block, GAP, blocksOf, gapBelow } from "../src/lib/blocks.ts";

type Status = "running" | "completed" | "failed" | "declined";

const user = (id: string): Item => ({ id, kind: "userMessage", text: "go", images: [] });
const say = (id: string, text = "hi"): Item => ({ id, kind: "agentMessage", text });
const think = (id: string, text = "hm"): Item => ({ id, kind: "reasoning", text });
const run = (id: string, status: Status = "completed"): ActivityItem => ({
  id,
  kind: "command",
  command: "/bin/bash -lc 'npm test'",
  cwd: "/p",
  output: "",
  exitCode: status === "failed" ? 1 : 0,
  durationMs: null,
  actions: [],
  status,
});
const read = (id: string, paths = ["/p/a.ts"]): ActivityItem => ({
  ...(run(id) as Extract<ActivityItem, { kind: "command" }>),
  actions: paths.map((path) => ({ type: "read" as const, path })),
});
const lookFor = (id: string): ActivityItem => ({
  ...(run(id) as Extract<ActivityItem, { kind: "command" }>),
  actions: [{ type: "search", query: "x", path: null }],
});
const list = (id: string): ActivityItem => ({
  ...(run(id) as Extract<ActivityItem, { kind: "command" }>),
  actions: [{ type: "list", path: "/p" }],
});
const edit = (id: string, ...changes: ("add" | "update" | "delete")[]): ActivityItem => ({
  id,
  kind: "fileChange",
  status: "completed",
  changes: changes.map((change, index) => ({ path: `f${index}.ts`, change, diff: "" })),
});
const call = (id: string): ActivityItem => ({
  id,
  kind: "toolCall",
  server: "docs",
  tool: "find",
  args: "{}",
  result: null,
  error: null,
  durationMs: null,
  status: "completed",
});
const web = (id: string): ActivityItem => ({ id, kind: "webSearch", query: "bun" });

const turn = (items: Item[], status: Turn["status"] = "completed", error: string | null = null) =>
  ({ id: "t", status, error, startedAt: null, durationMs: null, items, diff: null }) satisfies Turn;

/** A block as a word: its kind, with what it holds. */
const word = (block: Block): string => {
  switch (block.kind) {
    case "activity":
      return `activity(${block.items.map((item) => item.id).join(",")})`;
    case "turnEnd":
      return `turnEnd(${block.status})`;
    case "origin":
      return `origin(${block.origin.kind})`;
    case "text":
      return block.final ? `text!(${block.item.id})` : `text(${block.item.id})`;
    default:
      return `${block.kind}(${block.item.id})`;
  }
};
const layout = (subject: Turn, showThinking = false): string[] =>
  blocksOf(subject, { showThinking }).map(word);

test.each<[string, Turn, string[]]>([
  [
    "words cut a turn into stretches, each stretch of work one card",
    turn([user("u"), read("1"), run("2"), say("m1"), edit("3", "update"), run("4"), say("m2")]),
    ["user(u)", "activity(1,2)", "text(m1)", "activity(3,4)", "text!(m2)"],
  ],
  [
    "a stretch with one piece of work shows it with no card",
    turn([user("u"), run("1"), say("m")]),
    ["user(u)", "single(1)", "text!(m)"],
  ],
  [
    "a reply with no text is not a block, and cuts nothing",
    turn([user("u"), run("1"), say("empty", "  "), run("2"), say("m")]),
    ["user(u)", "activity(1,2)", "text!(m)"],
  ],
  [
    "a running turn has no last reply yet",
    turn([user("u"), say("m")], "running"),
    ["user(u)", "text(m)"],
  ],
  [
    "a failure the agent dealt with stays in its card",
    turn([user("u"), run("1", "failed"), run("2"), say("m")]),
    ["user(u)", "activity(1,2)", "text!(m)"],
  ],
  [
    "a stopped turn pulls its last stretch's failures out under the card",
    turn([user("u"), run("1"), run("2", "failed"), run("3"), run("4", "failed")], "failed", "boom"),
    ["user(u)", "activity(1,3)", "failed(2)", "failed(4)", "turnEnd(failed)"],
  ],
  [
    "only the last stretch's failures are pulled out",
    turn([user("u"), run("1", "failed"), run("2"), say("m"), run("3", "failed")], "interrupted"),
    ["user(u)", "activity(1,2)", "text!(m)", "failed(3)", "turnEnd(interrupted)"],
  ],
  [
    "a declined piece of work is no failure",
    turn([user("u"), run("1", "declined"), run("2")], "interrupted"),
    ["user(u)", "activity(1,2)", "turnEnd(interrupted)"],
  ],
  [
    "a turn that shows nothing still says why it failed",
    turn([], "failed", "no model"),
    ["turnEnd(failed)"],
  ],
  ["a stopped turn that shows nothing and has no error says nothing", turn([], "interrupted"), []],
  [
    "compactions, proposed plans, other agents and reviews are blocks of their own",
    turn([
      user("u"),
      run("1"),
      { id: "c", kind: "compaction" },
      run("2"),
      { id: "p", kind: "plan", text: "1. do it" },
      {
        id: "a",
        kind: "agentCall",
        tool: "wait",
        prompt: null,
        receivers: [],
        status: "completed",
      },
      { id: "r", kind: "review", phase: "exited", text: "fine" },
      { id: "o", kind: "other", type: "x" },
    ]),
    ["user(u)", "single(1)", "compaction(c)", "single(2)", "plan(p)", "agent(a)", "review(r)"],
  ],
  [
    "what a hook added and news of an agent cut a stretch; a wait is work in it",
    turn([
      user("u"),
      run("1"),
      { id: "w", kind: "wait", durationMs: 5000, status: "completed" },
      { id: "h", kind: "hook", text: "remember the tests" },
      run("2"),
      { id: "g", kind: "agentActivity", activity: "started", agent: "/root/x", model: null },
    ]),
    ["user(u)", "activity(1,w)", "note(h)", "single(2)", "note(g)"],
  ],
  [
    "a review's findings said again as the reply show once, as the reply",
    turn([
      user("u"),
      { id: "in", kind: "review", phase: "entered", text: "changes" },
      { id: "out", kind: "review", phase: "exited", text: "Looks fine." },
      say("m", "Looks fine."),
    ]),
    ["user(u)", "review(in)", "text!(m)"],
  ],
])("%s", (_name, subject, expected) => {
  expect(layout(subject)).toEqual(expected);
});

test("thinking shows only when asked for, and never cuts a stretch", () => {
  const subject = turn([user("u"), think("r1"), run("1"), think("r2"), run("2"), say("m")]);
  expect(layout(subject)).toEqual(["user(u)", "activity(1,2)", "text!(m)"]);
  // A thought before a stretch's first work goes above its card, a later one under it.
  expect(layout(subject, true)).toEqual([
    "user(u)",
    "thought(r1)",
    "activity(1,2)",
    "thought(r2)",
    "text!(m)",
  ]);
  expect(layout(turn([user("u"), think("r", " ")]), true)).toEqual(["user(u)"]);
});

test("a prompt that joined a running turn says how much work came before it", () => {
  const blocks = blocksOf(turn([user("u"), run("1"), run("2"), user("u2"), say("m")]), {
    showThinking: false,
  });
  expect(blocks.map((block) => (block.kind === "user" ? block.steeredAfter : null))).toEqual([
    undefined,
    null,
    2,
    null,
  ]);
});

test("a stretch keeps its key when a second piece of work joins it", () => {
  const one = blocksOf(turn([user("u"), run("1")], "running"), { showThinking: false });
  const two = blocksOf(turn([user("u"), run("1"), run("2")], "running"), { showThinking: false });
  expect([one[1]?.kind, two[1]?.kind]).toEqual(["single", "activity"]);
  expect(one[1]?.key).toBe(two[1]?.key ?? "");
});

test("blocks are spaced by their kind", () => {
  const stopped = turn(
    [user("u"), run("1"), run("2", "failed"), run("3"), say("m"), run("4", "failed")],
    "failed",
    "boom",
  );
  expect(blocksOf(stopped, { showThinking: false }).map((block) => block.gap)).toEqual([
    0, // the turn's first block: the turn itself keeps 40 from the one before
    GAP.afterActions, // under the user's bubble, whose actions float below it
    GAP.narrative,
    GAP.afterActions, // a failure under the last reply, whose actions float below it
    GAP.narrative,
  ]);
  const pulled = turn([user("u"), run("1"), run("2", "failed"), run("3", "failed")], "failed");
  expect(blocksOf(pulled, { showThinking: false }).map((block) => block.gap)).toEqual([
    0,
    GAP.afterActions,
    GAP.card, // a failure under its card
    GAP.card,
    GAP.narrative,
  ]);
  const done = turn([user("u"), run("1"), say("m1"), run("2"), say("m2")]);
  expect(blocksOf(done, { showThinking: false }).map((block) => block.gap)).toEqual([
    0,
    GAP.afterActions,
    GAP.narrative,
    GAP.narrative, // only the last reply has actions under it
    GAP.narrative,
  ]);
});

test("what follows a turn clears the actions under its last block", () => {
  const options = { showThinking: false };
  expect(gapBelow(blocksOf(turn([user("u"), say("m")]), options))).toBe(GAP.afterActions);
  expect(gapBelow(blocksOf(turn([user("u")], "running"), options))).toBe(GAP.afterActions);
  expect(gapBelow(blocksOf(turn([user("u"), run("1")], "running"), options))).toBe(GAP.narrative);
});

test("a turn is laid out once for each object it is", () => {
  const subject = turn([user("u"), run("1"), say("m")]);
  const first = blocksOf(subject, { showThinking: false });
  expect(blocksOf(subject, { showThinking: false })).toBe(first);
  expect(blocksOf(subject, { showThinking: true })).not.toBe(first);
});

test.each<[string, ActivityItem[], string]>([
  [
    "one of each, in the order it first happened",
    [run("1"), read("2")],
    "Ran 1 command, read 1 file",
  ],
  [
    "counts add up across a stretch",
    [read("1"), read("2", ["/a", "/b"]), run("3"), run("4"), edit("5", "update", "add")],
    "Read 3 files, ran 2 commands, edited 2 files",
  ],
  ["searches and lists", [lookFor("1"), list("2"), web("3")], "Searched 2 times, listed 1 folder"],
  ["one search", [lookFor("1")], "Searched once"],
  ["deleted files are not edits", [edit("1", "delete", "update")], "Deleted 1 file, edited 1 file"],
  ["tools the harness does not know", [call("1"), call("2")], "Used 2 tools"],
])("a card's summary: %s", (_name, items, summary) => {
  expect(activitySummary(items)).toBe(summary);
});

test.each([
  ["/bin/bash -lc 'echo hi'", "echo hi"],
  ["bash -lc 'it'\\''s'", "it's"],
  ['/bin/zsh -lc "echo \\"q\\" && ls"', 'echo "q" && ls'],
  ["git status", "git status"],
])("the command %p is shown as %p", (wrapped, plain) => {
  expect(plainCommand(wrapped)).toBe(plain);
});

const task = (id: string): Item => ({
  id,
  kind: "task",
  taskId: id,
  task: "agent",
  description: "Look",
  agent: null,
  prompt: "look",
  status: "completed",
  background: false,
  usage: null,
  summary: null,
  error: null,
});
const inside = (item: Item, parentId: string): Item => ({ ...item, parentId });

test("a task is a block of its own, holding what was done inside it, a helper's helper too", () => {
  const subject = turn([
    user("u"),
    task("k"),
    inside(run("1"), "k"),
    inside(task("k2"), "k"),
    inside(say("s2", "deep"), "k2"),
    inside(say("s1", "found it"), "k"),
    say("r", "done"),
  ]);
  expect(layout(subject)).toEqual(["user(u)", "task(k)", "text!(r)"]);
  const block = blocksOf(subject, { showThinking: false })[1];
  if (block?.kind !== "task") throw new Error("expected a task");
  expect(block.nested.get("k")?.map((item) => item.id)).toEqual(["1", "k2", "s1"]);
  expect(block.nested.get("k2")?.map((item) => item.id)).toEqual(["s2"]);
  // A helper's words are never the turn's reply, and work of a task not in the turn stays in view.
  expect(layout(turn([user("u"), task("k"), inside(say("s", "x"), "k")]))).toEqual([
    "user(u)",
    "task(k)",
  ]);
  expect(layout(turn([user("u"), inside(run("1"), "gone")]))).toEqual(["user(u)", "single(1)"]);
});

test("a turn the owner did not begin says who did, first", () => {
  const origin = { kind: "task" as const, taskId: "k" };
  expect(layout({ ...turn([say("r", "the task is done")]), origin })).toEqual([
    "origin(task)",
    "text!(r)",
  ]);
  expect(layout({ ...turn([say("r")]), origin: { kind: "owner" } })).toEqual(["text!(r)"]);
});
