import { expect, test } from "bun:test";
import {
  type Item,
  type SessionEvent,
  type Session,
  activeTurn,
  coalesceEvents,
  initialSessionState,
  reduceSession,
} from "../src/index.ts";

const info: Session = {
  id: "s",
  harness: "fake",
  title: null,
  preview: "",
  cwd: "/p",
  model: "m",
  effort: null,
  mode: "auto",
  activity: "idle",
  loaded: true,
  failed: false,
  branch: null,
  worktree: null,
  environment: null,
  sandbox: null,
  sandboxCwd: null,
  directories: [],
  createdAt: 0,
  updatedAt: 0,
  archived: false,
  pinned: false,
  unread: false,
  forkedFrom: null,
  scheduleId: null,
};

const fold = (events: SessionEvent[]) => events.reduce(reduceSession, initialSessionState(info));
const message = (id: string, text = ""): Item => ({ id, kind: "agentMessage", text });
const command = (
  id: string,
  status: "running" | "completed",
): Extract<Item, { kind: "command" }> => ({
  id,
  kind: "command",
  command: "ls",
  cwd: "/p",
  output: "",
  exitCode: null,
  durationMs: null,
  actions: [],
  status,
});
const started: SessionEvent = { type: "turn.started", sessionId: "s", turnId: "t1", startedAt: 5 };
const delta = (itemId: string, text: string): SessionEvent => ({
  type: "item.delta",
  sessionId: "s",
  turnId: "t1",
  itemId,
  delta: text,
});
const done = (status: "completed" | "interrupted" | "failed"): SessionEvent => ({
  type: "turn.completed",
  sessionId: "s",
  turnId: "t1",
  status,
  error: status === "failed" ? "boom" : null,
  durationMs: 9,
});

test("a turn gathers its items, and deltas append to the right one", () => {
  const state = fold([
    started,
    { type: "item.started", sessionId: "s", turnId: "t1", item: command("c", "running") },
    { type: "item.started", sessionId: "s", turnId: "t1", item: message("m") },
    delta("m", "Hel"),
    delta("c", "out"),
    delta("m", "lo"),
  ]);
  expect(activeTurn(state)?.id).toBe("t1");
  expect(state.turns[0]?.items).toEqual([
    { ...command("c", "running"), output: "out" },
    message("m", "Hello"),
  ]);
});

test("ending a turn closes what was still running and clears approvals", () => {
  const events: SessionEvent[] = [
    started,
    { type: "item.started", sessionId: "s", turnId: "t1", item: command("c", "running") },
    {
      type: "approval.requested",
      sessionId: "s",
      turnId: "t1",
      approval: { id: "a", kind: "fileChange", itemId: "c", reason: null },
    },
  ];
  const stopped = fold([...events, done("interrupted")]);
  expect(activeTurn(stopped)).toBeNull();
  expect(stopped.approvals).toEqual([]);
  expect(stopped.turns[0]).toMatchObject({ status: "interrupted", durationMs: 9 });
  expect(stopped.turns[0]?.items[0]).toMatchObject({ status: "failed" });
  expect(fold([...events, done("completed")]).turns[0]?.items[0]).toMatchObject({
    status: "completed",
  });
});

test("only the turn an event concerns gets a new identity", () => {
  const first = fold([started, done("completed")]);
  const second = reduceSession(first, {
    type: "turn.started",
    sessionId: "s",
    turnId: "t2",
    startedAt: null,
  });
  const third = reduceSession(second, {
    type: "item.started",
    sessionId: "s",
    turnId: "t2",
    item: message("m2", "hi"),
  });
  expect(third.turns[0]).toBe(first.turns[0]);
  expect(third.turns[1]).not.toBe(second.turns[1]);
});

test("an item for a turn never announced makes the turn", () => {
  const state = fold([
    { type: "item.completed", sessionId: "s", turnId: "tx", item: message("m", "late") },
  ]);
  expect(state.turns.map((turn) => turn.id)).toEqual(["tx"]);
});

test("coalescing merges runs of deltas and folds to the same state", () => {
  const events: SessionEvent[] = [
    started,
    { type: "item.started", sessionId: "s", turnId: "t1", item: message("m") },
    delta("m", "a"),
    delta("m", "b"),
    { type: "item.started", sessionId: "s", turnId: "t1", item: message("n") },
    delta("n", "c"),
    delta("m", "d"),
    delta("m", "e"),
  ];
  const merged = coalesceEvents(events);
  expect(merged.length).toBe(6);
  expect(fold(merged)).toEqual(fold(events));
});

test("plan, usage, queue and notices are kept as last told", () => {
  const usage = {
    total: { total: 3, input: 2, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 },
    last: { total: 3, input: 2, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 },
    contextWindow: 100,
    costUsd: null,
  };
  const state = fold([
    { type: "plan.updated", sessionId: "s", plan: { explanation: null, steps: [] } },
    { type: "usage.updated", sessionId: "s", usage },
    { type: "queue.updated", sessionId: "s", queue: [{ id: "q", text: "next", images: [] }] },
    { type: "notice", sessionId: "s", level: "warning", message: "careful" },
  ]);
  expect(state.plan).toEqual({ explanation: null, steps: [] });
  expect(state.usage).toEqual(usage);
  expect(state.queue.map((queued) => queued.text)).toEqual(["next"]);
  expect(state.notices).toEqual([{ level: "warning", message: "careful" }]);
});

const turn = (turnId: string): SessionEvent[] => [
  { type: "turn.started", sessionId: "s", turnId, startedAt: null },
  {
    type: "turn.completed",
    sessionId: "s",
    turnId,
    status: "completed",
    error: null,
    durationMs: 1,
  },
];

test("a rewind drops its turn and every later one, and forgets the context it measured", () => {
  const count = { total: 3, input: 2, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 };
  const before = fold([
    ...turn("a"),
    ...turn("b"),
    ...turn("c"),
    {
      type: "usage.updated",
      sessionId: "s",
      usage: { total: count, last: count, contextWindow: 9, costUsd: null },
    },
  ]);
  const after = reduceSession(before, { type: "turns.rewound", sessionId: "s", turnId: "b" });
  expect(after.turns.map((each) => each.id)).toEqual(["a"]);
  expect(after.turns[0]).toBe(before.turns[0]);
  expect(after.usage).toBeNull();
  expect(reduceSession(after, { type: "turns.rewound", sessionId: "s", turnId: "x" })).toBe(after);
});
