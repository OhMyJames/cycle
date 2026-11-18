import { expect, test } from "bun:test";
import type { Ask, EventFrame, Question, Session, SessionEvent, Settings } from "@cycle/protocol";
import {
  Git,
  JsonStore,
  type MetaFile,
  SessionHub,
  type UsageFile,
  UsageLedger,
} from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

const SECRET = "hunter2-correct-horse";
/** An ask for a secret, which is what every question of these tests asks. */
const KEY: Ask = {
  id: "a",
  header: "Key",
  question: "Your key?",
  options: [],
  allowOther: true,
  secret: true,
};

async function setup() {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const frames: EventFrame[] = [];
  const infos: Session[] = [];
  const logs: string[] = [];
  /** Everything the hub asked to be stored. */
  const written: string[] = [];
  const memory = () => ({
    read: async () => null,
    write: async (text: string) => void written.push(text),
  });
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
    log: (line) => logs.push(line),
    viewers: () => 0,
    publish: {
      frame: (frame) => frames.push(frame),
      sessions: (list) => infos.push(...list),
      removed: () => {},
      usage: () => {},
    },
  });
  const info = await hub.create({ cwd: "/project" });
  const events = (): SessionEvent[] => frames.flatMap((frame) => frame.events);
  const types = (since: number) =>
    events()
      .slice(since)
      .map((event) => event.type);
  const activity = () => infos.findLast((each) => each.id === info.id)?.activity;
  const running = () =>
    harness.emit({ type: "turn.started", sessionId: info.id, turnId: "t1", startedAt: null });
  const ask = (id: string, turnId: string | null = "t1") =>
    harness.emit({
      type: "question.requested",
      sessionId: info.id,
      turnId,
      question: { id, itemId: "i", kind: "choice", asks: [KEY] },
    });
  const approve = (id: string) =>
    harness.emit({
      type: "approval.requested",
      sessionId: info.id,
      turnId: "t1",
      approval: { id, kind: "fileChange", itemId: "i", reason: null },
    });
  return {
    harness,
    hub,
    info,
    frames,
    logs,
    written,
    events,
    types,
    activity,
    running,
    ask,
    approve,
  };
}

test("a question is sent in one frame, as itself and as the approval the page draws", async () => {
  const { frames, info, harness, running } = await setup();
  running();
  const before = frames.length;
  const question: Question = {
    id: "q1",
    itemId: "i",
    kind: "choice",
    asks: [{ id: "a", header: "H", question: "Q?", options: [], allowOther: true, secret: false }],
  };
  harness.emit({ type: "question.requested", sessionId: info.id, turnId: "t1", question });
  expect(frames).toHaveLength(before + 1);
  expect(frames.at(-1)?.events).toEqual([
    { type: "question.requested", sessionId: info.id, turnId: "t1", question },
    {
      type: "approval.requested",
      sessionId: info.id,
      turnId: "t1",
      approval: {
        id: "q1",
        kind: "question",
        itemId: "i",
        questions: question.kind === "choice" ? question.asks : [],
      },
    },
  ]);
});

test("a session waiting on a question requires action, and runs again once it is resolved", async () => {
  const { harness, info, frames, activity, running, ask } = await setup();
  running();
  expect(activity()).toBe("running");
  ask("q1");
  expect(activity()).toBe("requires_action");
  const before = frames.length;
  harness.emit({ type: "question.resolved", sessionId: info.id, questionId: "q1" });
  expect(frames).toHaveLength(before + 1);
  expect(frames.at(-1)?.events.map((event) => event.type)).toEqual([
    "question.resolved",
    "approval.resolved",
  ]);
  expect(activity()).toBe("running");
});

test("a question counts on its own, whether or not the approval it is shown as is still open", async () => {
  const { harness, info, activity, running, ask } = await setup();
  running();
  ask("q1");
  harness.emit({ type: "approval.resolved", sessionId: info.id, approvalId: "q1" });
  expect(activity()).toBe("requires_action");
});

test("the page's answer to the approval it was shown reaches the question as an answer", async () => {
  const { harness, hub, running, ask } = await setup();
  running();
  ask("q1");
  hub.respondApproval("q1", { answers: { a: ["x", "y"] } });
  hub.respondApproval("q1", { decision: "accept", content: { name: "Ada" } });
  hub.respondApproval("q1", { decision: "acceptForSession" });
  hub.respondApproval("q1", { decision: "decline", content: { name: "Ada" } });
  hub.respondApproval("q1", { decision: "cancel" });
  expect(harness.answers.map((each) => each.answer)).toEqual([
    { answers: { a: ["x", "y"] } },
    { action: "accept", content: { name: "Ada" } },
    { action: "accept" },
    { action: "decline", content: { name: "Ada" } },
    { action: "cancel" },
  ]);
  expect(harness.calls.filter((call) => call.startsWith("approve"))).toEqual([]);
});

test("an approval's id still goes to respondApproval, whatever else is asked", async () => {
  const { harness, hub, running, ask, approve } = await setup();
  running();
  ask("q1");
  approve("a1");
  hub.respondApproval("a1", { decision: "accept" });
  expect(harness.calls.filter((call) => /^(approve|answer)/.test(call))).toEqual(["approve a1"]);
  hub.respondApproval("unknown", { decision: "accept" });
  expect(harness.calls.at(-1)).toBe("approve unknown");
});

test("an answer sent as an answer reaches the agent as it is", async () => {
  const { harness, hub, running, ask } = await setup();
  running();
  ask("q1");
  const answer = { action: "accept", content: { name: "Ada" } } as const;
  hub.answerQuestion("q1", answer);
  expect(harness.answers).toEqual([{ questionId: "q1", answer }]);
});

test("an id stops being routed to answerQuestion when its turn ends", async () => {
  const { harness, hub, info, running, ask } = await setup();
  running();
  ask("q1");
  harness.emit({
    type: "turn.completed",
    sessionId: info.id,
    turnId: "t1",
    status: "interrupted",
    error: null,
    durationMs: 1,
  });
  hub.respondApproval("q1", { decision: "decline" });
  expect(harness.calls.filter((call) => /^(approve|answer)/.test(call))).toEqual(["approve q1"]);
});

test("an id stops being routed when its agent exits, with or without a turn to fail", async () => {
  const { harness, hub, types, events, running, ask } = await setup();
  running();
  ask("q1");
  const before = events().length;
  harness.emit({ type: "agent.exited", harness: "fake", message: "gone" });
  // Both of its forms are resolved for the page, then the turn is failed.
  expect(types(before)).toEqual(["question.resolved", "approval.resolved", "turn.completed"]);
  hub.respondApproval("q1", { decision: "decline" });
  expect(harness.calls.filter((call) => /^(approve|answer)/.test(call))).toEqual(["approve q1"]);

  // A question asked outside any turn is left open by no turn's end: the exit resolves it.
  ask("q2", null);
  const idle = events().length;
  harness.emit({ type: "agent.exited", harness: "fake", message: "gone" });
  expect(types(idle)).toEqual(["question.resolved", "approval.resolved"]);
  hub.respondApproval("q2", { decision: "decline" });
  expect(harness.calls.at(-1)).toBe("approve q2");
});

test("another agent's exit leaves the question open", async () => {
  const { harness, hub, running, ask } = await setup();
  running();
  ask("q1");
  harness.emit({ type: "agent.exited", harness: "other", message: "gone" });
  hub.respondApproval("q1", { decision: "decline" });
  expect(harness.calls.at(-1)).toBe("answer q1");
});

test("an id stops being routed when its session is dropped", async () => {
  const { harness, hub, info, ask } = await setup();
  // Idle, so the session may be archived, which lets the hub go of it.
  ask("q1", null);
  await hub.update({ sessionId: info.id, archived: true });
  hub.respondApproval("q1", { decision: "decline" });
  expect(harness.calls.filter((call) => /^(approve|answer)/.test(call))).toEqual(["approve q1"]);
});

test("an answer travels to the agent once, and is in no frame, no replay, no log and no file", async () => {
  const { harness, hub, info, frames, logs, written, running, ask } = await setup();
  running();
  ask("q1");
  ask("q2");
  // The secret is asked for: the page is told of the question, and of nothing else yet.
  const asked = await hub.open(info.id, undefined);
  expect("state" in asked ? asked.state.questions.map((each) => each.id) : []).toEqual([
    "q1",
    "q2",
  ]);
  expect(
    frames
      .flatMap((frame) => frame.events)
      .flatMap((event) => (event.type === "question.requested" ? [event.question] : [])),
  ).toMatchObject([
    { id: "q1", asks: [{ question: "Your key?", secret: true }] },
    { id: "q2", asks: [{ question: "Your key?", secret: true }] },
  ]);
  // The same secret by the two ways a client can answer.
  hub.respondApproval("q1", { answers: { a: [SECRET] } });
  hub.answerQuestion("q2", { answers: { a: [SECRET] } });
  expect(harness.answers).toEqual([
    { questionId: "q1", answer: { answers: { a: [SECRET] } } },
    { questionId: "q2", answer: { answers: { a: [SECRET] } } },
  ]);
  // What the agent says back is what the hub tells.
  for (const questionId of ["q1", "q2"]) {
    harness.emit({ type: "question.resolved", sessionId: info.id, questionId });
  }
  const opened = await hub.open(info.id, undefined);
  expect("state" in opened ? opened.state.questions : null).toEqual([]);
  const replay = await hub.open(info.id, {
    seq: 0,
    epoch: "state" in opened ? opened.state.epoch : "",
  });
  for (const where of [frames, opened, replay, logs, written, harness.calls]) {
    expect(JSON.stringify(where)).not.toContain(SECRET);
  }
});
