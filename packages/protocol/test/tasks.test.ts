import { expect, test } from "bun:test";
import {
  type Item,
  type SessionEvent,
  type Session,
  type TurnOrigin,
  initialSessionState,
  reduceSession,
} from "../src/index.ts";

const info = { id: "s", harness: "fake", activity: "idle" } as Session;
const fold = (events: SessionEvent[]) => events.reduce(reduceSession, initialSessionState(info));

type Task = Extract<Item, { kind: "task" }>;
const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({
  id,
  kind: "task",
  taskId: id,
  task: "agent",
  description: "Look",
  agent: null,
  prompt: null,
  status,
  background: true,
  usage: null,
  summary: null,
  error: null,
  ...extra,
});
const command = (id: string, parentId?: string): Item => ({
  id,
  ...(parentId ? { parentId } : {}),
  kind: "command",
  command: "ls",
  cwd: "/p",
  output: "",
  exitCode: null,
  durationMs: null,
  actions: [],
  status: "running",
});
const item = (turnId: string, it: Item): SessionEvent => ({
  type: "item.started",
  sessionId: "s",
  turnId,
  item: it,
});
const started = (turnId: string, origin?: TurnOrigin): SessionEvent => ({
  type: "turn.started",
  sessionId: "s",
  turnId,
  startedAt: 1,
  ...(origin ? { origin } : {}),
});
const done = (turnId: string, status: "completed" | "interrupted"): SessionEvent => ({
  type: "turn.completed",
  sessionId: "s",
  turnId,
  status,
  error: null,
  durationMs: 1,
});
const statuses = (items: Item[] | undefined) =>
  (items ?? []).map((each) => `${each.id} ${"status" in each ? each.status : ""}`);

test("a task and what it does outlive their turn, and end when the task does", () => {
  const before = [
    started("t1"),
    item("t1", task("k", "running")),
    item("t1", command("own")),
    item("t1", command("child", "k")),
    done("t1", "interrupted"),
  ];
  const after = fold(before);
  expect(statuses(after.turns[0]?.items)).toEqual(["k running", "own failed", "child running"]);
  // Its news comes later, while another turn runs: the task's own turn is the one that changes.
  const running = fold([...before, started("t2")]);
  const state = reduceSession(running, item("t1", task("k", "stopped")));
  expect(statuses(state.turns[0]?.items)).toEqual(["k stopped", "own failed", "child failed"]);
  expect(state.turns[1]).toBe(running.turns[1] as never);
  const finished = fold([...before, item("t1", task("k", "completed"))]);
  expect(statuses(finished.turns[0]?.items)).toEqual([
    "k completed",
    "own failed",
    "child completed",
  ]);
});

test("a turn keeps who began it, and the owner's is said by saying nothing", () => {
  const state = fold([
    started("t1", { kind: "owner" }),
    done("t1", "completed"),
    started("t2", { kind: "task", taskId: "k" }),
  ]);
  expect(state.turns[0]?.origin).toBeUndefined();
  expect(state.turns[1]?.origin).toEqual({ kind: "task", taskId: "k" });
});

test("the session's background tasks are whatever was listed last, whichever turn runs", () => {
  const listed: SessionEvent = {
    type: "tasks.updated",
    sessionId: "s",
    tasks: [{ id: "k", task: "agent", description: "Look", agent: null, itemId: "k" }],
  };
  const state = fold([listed, started("t1"), done("t1", "completed")]);
  expect(state.tasks.map((each) => each.id)).toEqual(["k"]);
  expect(fold([listed, { ...listed, tasks: [] }]).tasks).toEqual([]);
});
