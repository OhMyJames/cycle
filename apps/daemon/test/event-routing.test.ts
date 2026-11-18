import { expect, test } from "bun:test";
import type {
  DayUsage,
  EventFrame,
  HarnessEvent,
  Session,
  SessionEvent,
  Settings,
} from "@cycle/protocol";
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
  const published: Session[][] = [];
  const settings: Settings = {
    model: null,
    effort: null,
    modes: {},
    worktree: false,
    projects: [],
  };
  const meta = await JsonStore.open<MetaFile>(memory(), { sessions: {} }, timers.schedule);
  const usageFile = await JsonStore.open<UsageFile>(memory(), { days: {} }, timers.schedule);
  const hub = new SessionHub({
    harness: harness.asAgents(),
    meta,
    settings: () => settings,
    usage: new UsageLedger(usageFile, () => 0),
    git: new Git((argv, options) => harness.exec(argv, options)),
    legacyWorktrees: "/home/worktrees",
    schedule: timers.schedule,
    now: () => 1000,
    log: () => {},
    viewers: () => 0,
    publish: {
      frame: (frame) => frames.push(frame),
      sessions: (list) => published.push(list),
      removed: () => {},
      usage: (_day: DayUsage) => {},
    },
  });
  /** What happened to the hub while `run` ran: frame events, published lists, and the meta. */
  const watch = (run: () => void) => {
    const framesBefore = frames.length;
    const publishedBefore = published.length;
    const metaBefore = JSON.stringify(meta.value);
    run();
    timers.run();
    return {
      frames: frames
        .slice(framesBefore)
        .flatMap((frame) => frame.events.map((event): string => event.type)),
      published: published.length - publishedBefore,
      meta: JSON.stringify(meta.value) !== metaBefore,
    };
  };
  const events = () => frames.flatMap((frame) => frame.events);
  return { harness, hub, timers, frames, published, meta, watch, events };
}

const quiet = { frames: [], published: 0, meta: false };

test("an agent's own news, and a session's commands, reach no frame, list or meta", async () => {
  const { harness, hub, watch } = await setup();
  const info = await hub.create({ cwd: "/project" });
  const news: HarnessEvent[] = [
    { type: "mcp.changed" },
    { type: "account.changed", harness: "fake", error: null },
    { type: "limits.changed", harness: "fake" },
    { type: "commands.changed", sessionId: info.id, commands: [] },
  ];
  for (const event of news) expect(watch(() => harness.emit(event))).toEqual(quiet);
});

test("a session event for a session the hub does not hold is dropped, not thrown", async () => {
  const { harness, watch } = await setup();
  const unknown: HarnessEvent[] = [
    { type: "turn.started", sessionId: "nope", turnId: "t1", startedAt: null },
    { type: "session.changed", sessionId: "nope", patch: { title: "Lost" } },
    { type: "mode.changed", sessionId: "nope", mode: "plan" },
  ];
  for (const event of unknown) expect(watch(() => harness.emit(event))).toEqual(quiet);
});

test("the agent stopping fails its running turn, after emptying its tasks", async () => {
  const { harness, hub, events } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.emit({ type: "turn.started", sessionId: info.id, turnId: "t1", startedAt: null });
  const task = {
    id: "k1",
    task: "command",
    description: "serve",
    agent: null,
    itemId: null,
  } as const;
  harness.emit({ type: "tasks.updated", sessionId: info.id, tasks: [task] });
  const before = events().length;
  harness.emit({ type: "agent.exited", harness: "fake", message: "fake exited" });
  expect(events().slice(before)).toEqual([
    { type: "tasks.updated", sessionId: info.id, tasks: [] },
    {
      type: "turn.completed",
      sessionId: info.id,
      turnId: "t1",
      status: "failed",
      error: "fake exited. It starts again with your next message.",
      durationMs: null,
    },
  ]);
});

test("the agent stopping with nothing running says nothing, and another agent's stopping nothing", async () => {
  const { harness, hub, watch } = await setup();
  const info = await hub.create({ cwd: "/project" });
  expect(
    watch(() => harness.emit({ type: "agent.exited", harness: "fake", message: "x" })),
  ).toMatchObject({ frames: [] });
  harness.emit({ type: "turn.started", sessionId: info.id, turnId: "t1", startedAt: null });
  const other = watch(() => harness.emit({ type: "agent.exited", harness: "other", message: "x" }));
  expect(other).toEqual(quiet);
});

/** Where the hub sends an event today: into frames, into the session's list entry, or nowhere. */
type Route = { frames: string[]; info: boolean };

/** One event of each kind, the session's with its id. A new kind is a type error until it is here. */
const kinds = (
  id: string,
): { [K in HarnessEvent["type"]]: [Extract<HarnessEvent, { type: K }>, Route] } => ({
  "turn.started": [
    { type: "turn.started", sessionId: id, turnId: "t1", startedAt: null },
    viaFrame("turn.started"),
  ],
  "item.started": [
    {
      type: "item.started",
      sessionId: id,
      turnId: "t1",
      item: { id: "m", kind: "agentMessage", text: "" },
    },
    viaFrame("item.started"),
  ],
  "item.delta": [
    { type: "item.delta", sessionId: id, turnId: "t1", itemId: "m", delta: "a" },
    viaFrame("item.delta"),
  ],
  "item.completed": [
    {
      type: "item.completed",
      sessionId: id,
      turnId: "t1",
      item: { id: "m", kind: "agentMessage", text: "a" },
    },
    viaFrame("item.completed"),
  ],
  "plan.updated": [
    { type: "plan.updated", sessionId: id, plan: { explanation: null, steps: [] } },
    viaFrame("plan.updated"),
  ],
  "diff.updated": [
    { type: "diff.updated", sessionId: id, turnId: "t1", diff: "" },
    viaFrame("diff.updated"),
  ],
  "usage.updated": [
    {
      type: "usage.updated",
      sessionId: id,
      usage: {
        total: { total: 1, input: 1, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        last: { total: 1, input: 1, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        contextWindow: null,
        costUsd: null,
      },
    },
    viaFrame("usage.updated"),
  ],
  "approval.requested": [
    {
      type: "approval.requested",
      sessionId: id,
      turnId: "t1",
      approval: { id: "a1", kind: "fileChange", itemId: "i", reason: null },
    },
    viaFrame("approval.requested"),
  ],
  "approval.resolved": [
    { type: "approval.resolved", sessionId: id, approvalId: "a1" },
    viaFrame("approval.resolved"),
  ],
  // The page still draws approvals, so each question goes with the approval it also is.
  "question.requested": [
    {
      type: "question.requested",
      sessionId: id,
      turnId: "t1",
      question: { id: "q1", itemId: "i", kind: "choice", asks: [] },
    },
    { frames: ["question.requested", "approval.requested"], info: false },
  ],
  "question.resolved": [
    { type: "question.resolved", sessionId: id, questionId: "q1" },
    { frames: ["question.resolved", "approval.resolved"], info: false },
  ],
  "queue.updated": [{ type: "queue.updated", sessionId: id, queue: [] }, viaFrame("queue.updated")],
  "turn.completed": [
    {
      type: "turn.completed",
      sessionId: id,
      turnId: "t1",
      status: "completed",
      error: null,
      durationMs: 1,
    },
    viaFrame("turn.completed"),
  ],
  "tasks.updated": [{ type: "tasks.updated", sessionId: id, tasks: [] }, viaFrame("tasks.updated")],
  "turns.rewound": [
    { type: "turns.rewound", sessionId: id, turnId: "t1" },
    viaFrame("turns.rewound"),
  ],
  notice: [{ type: "notice", sessionId: id, level: "info", message: "hi" }, viaFrame("notice")],
  "session.changed": [
    { type: "session.changed", sessionId: id, patch: { title: "Agent's" } },
    viaInfo(),
  ],
  "mode.changed": [
    { type: "mode.changed", sessionId: id, mode: "plan" },
    { frames: ["notice"], info: true },
  ],
  "commands.changed": [{ type: "commands.changed", sessionId: id, commands: [] }, viaNone()],
  "suggestion.changed": [
    { type: "suggestion.changed", sessionId: id, suggestion: "Go" },
    viaNone(),
  ],
  "mcp.changed": [{ type: "mcp.changed" }, viaNone()],
  "account.changed": [{ type: "account.changed", harness: "fake", error: null }, viaNone()],
  "limits.changed": [{ type: "limits.changed", harness: "fake" }, viaNone()],
  "agent.exited": [{ type: "agent.exited", harness: "fake", message: "x" }, viaNone()],
});
const viaFrame = (type: SessionEvent["type"]): Route => ({ frames: [type], info: false });
const viaInfo = (): Route => ({ frames: [], info: true });
const viaNone = (): Route => ({ frames: [], info: false });

test("every kind of event goes where it went: a frame, the session's entry, or nowhere", async () => {
  const names = Object.keys(kinds("x")) as HarnessEvent["type"][];
  for (const name of names) {
    const { harness, hub, watch } = await setup();
    const created = await hub.create({ cwd: "/project" });
    const [event, route] = kinds(created.id)[name];
    const seen = watch(() => harness.emit(event));
    expect([name, seen.frames]).toEqual([name, route.frames]);
    // What a turn or an approval does to the session's own state is its status, not its routing.
    if (route.frames.length === 0 || route.info) {
      expect([name, seen.published > 0]).toEqual([name, route.info]);
    }
  }
});
