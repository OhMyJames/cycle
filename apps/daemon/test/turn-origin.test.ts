import { expect, test } from "bun:test";
import type { EventFrame, SessionEvent, Session, TurnOrigin } from "@cycle/protocol";
import {
  Git,
  JsonStore,
  type MetaFile,
  SessionHub,
  type UsageFile,
  UsageLedger,
} from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

const memory = () => ({ read: async () => null, write: async () => {} });

async function setup() {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const frames: EventFrame[] = [];
  const meta = await JsonStore.open<MetaFile>(memory(), { sessions: {} }, timers.schedule);
  const usageFile = await JsonStore.open<UsageFile>(memory(), { days: {} }, timers.schedule);
  const infos: Session[] = [];
  const hub = new SessionHub({
    harness: harness.asAgents(),
    meta,
    settings: () => ({ model: null, effort: null, modes: {}, worktree: false, projects: [] }),
    usage: new UsageLedger(usageFile, () => 0),
    git: new Git((argv, options) => harness.exec(argv, options)),
    worktreeParent: "/home/worktrees",
    schedule: timers.schedule,
    now: () => 1000,
    log: () => {},
    viewers: () => 1,
    publish: {
      frame: (frame) => frames.push(frame),
      sessions: (list) => infos.push(...list),
      removed: () => {},
      usage: () => {},
    },
  });
  const events = () => frames.flatMap((frame) => frame.events);
  const info = await hub.create({ cwd: "/project" });
  return { harness, hub, info, events, infos };
}

const begun = (sessionId: string, turnId: string, origin?: TurnOrigin): SessionEvent => ({
  type: "turn.started",
  sessionId,
  turnId,
  startedAt: null,
  ...(origin ? { origin } : {}),
});
const ended = (sessionId: string, turnId: string) =>
  ({
    type: "turn.completed",
    sessionId,
    turnId,
    status: "completed",
    error: null,
    durationMs: 1,
  }) as const;

test("a schedule's prompt begins a turn marked as the schedule's, and the owner's is unmarked", async () => {
  const { harness, hub, info, events } = await setup();
  await hub.send(info.id, { text: "nightly", images: [] }, "auto", {
    kind: "schedule",
    scheduleId: "sch1",
  });
  harness.emit(begun(info.id, "t1"));
  harness.emit(ended(info.id, "t1"));
  await hub.send(info.id, { text: "mine", images: [] }, "auto");
  harness.emit(begun(info.id, "t2"));
  const starts = events().filter((event) => event.type === "turn.started");
  expect(starts.map((event) => (event.type === "turn.started" ? event.origin : null))).toEqual([
    { kind: "schedule", scheduleId: "sch1" },
    undefined,
  ]);
});

test("a turn the agent begins by itself makes the owner's prompt wait for it", async () => {
  const { harness, hub, info, events } = await setup();
  harness.emit(begun(info.id, "a1", { kind: "task", taskId: "k" }));
  expect(await hub.send(info.id, { text: "next", images: [] }, "auto")).toMatchObject({
    queued: true,
  });
  expect(harness.sent).toEqual([]);
  harness.emit(ended(info.id, "a1"));
  expect(harness.sent).toEqual([{ sessionId: info.id, text: "next" }]);
  const opened = await hub.open(info.id, undefined);
  expect("state" in opened && opened.state.turns[0]?.origin).toEqual({ kind: "task", taskId: "k" });
  expect(events().some((event) => event.type === "queue.updated")).toBe(true);
});

test("a prompt the agent's own turn got ahead of waits behind it, with whoever asked for it", async () => {
  const { harness, hub, info, events } = await setup();
  const send = harness.send;
  // The agent begins a turn of its own while the schedule's is being asked for, which is refused.
  harness.send = async (sessionId) => {
    harness.emit(begun(sessionId, "a1", { kind: "task", taskId: "k" }));
    throw new Error("A turn is already running in this session.");
  };
  const origin = { kind: "schedule", scheduleId: "sch1" } as const;
  expect(await hub.send(info.id, { text: "nightly", images: [] }, "auto", origin)).toMatchObject({
    queued: true,
  });
  expect(events().some((event) => event.type === "notice")).toBe(false);
  harness.send = send;
  harness.emit(ended(info.id, "a1"));
  expect(harness.sent).toEqual([{ sessionId: info.id, text: "nightly" }]);
  harness.emit(begun(info.id, "t2"));
  const starts = events().flatMap((event) => (event.type === "turn.started" ? [event] : []));
  expect(starts.map((event) => [event.turnId, event.origin])).toEqual([
    ["a1", { kind: "task", taskId: "k" }],
    ["t2", origin],
  ]);
});

test("a prompt refused for a turn of the agent's that already ended is asked for again", async () => {
  const { harness, hub, info } = await setup();
  const send = harness.send;
  harness.send = async (sessionId) => {
    harness.send = send;
    harness.emit(begun(sessionId, "a1", { kind: "task", taskId: "k" }));
    harness.emit(ended(sessionId, "a1"));
    throw new Error("A turn is already running in this session.");
  };
  expect(await hub.send(info.id, { text: "next", images: [] }, "auto")).toEqual({ queued: false });
  expect(harness.sent).toEqual([{ sessionId: info.id, text: "next" }]);
});

test("one task is stopped by itself, and the session's tasks go when its harness does", async () => {
  const { harness, hub, info } = await setup();
  await hub.stopTask(info.id, "k");
  expect(harness.calls).toContain(`stop ${info.id} k`);
  harness.emit({
    type: "tasks.updated",
    sessionId: info.id,
    tasks: [{ id: "k", task: "agent", description: "", agent: null, itemId: null }],
  });
  harness.emit({ type: "agent.exited", harness: info.harness, message: "gone" });
  const opened = await hub.open(info.id, undefined);
  expect("state" in opened && opened.state.tasks).toEqual([]);
});
