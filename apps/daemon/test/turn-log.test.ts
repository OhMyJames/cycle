import { expect, test } from "bun:test";
import type { SessionEvent, Settings } from "@cycle/protocol";
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
  const clock = { now: 1000 };
  const log: string[] = [];
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
    worktreeParent: "/home/worktrees",
    schedule: timers.schedule,
    now: () => clock.now,
    log: (line) => log.push(line),
    viewers: () => 0,
    publish: { frame: () => {}, sessions: () => {}, removed: () => {}, usage: () => {} },
  });
  return { harness, hub, clock, log };
}

const start = (sessionId: string, turnId: string): SessionEvent => ({
  type: "turn.started",
  sessionId,
  turnId,
  startedAt: null,
});
const end = (sessionId: string, turnId: string, status: "completed" | "failed"): SessionEvent => ({
  type: "turn.completed",
  sessionId,
  turnId,
  status,
  error: null,
  durationMs: 1,
});

test("a turn that ends leaves one line saying when each of its steps came, and nothing of what was said", async () => {
  const { harness, hub, clock, log } = await setup();
  const info = await hub.create({ cwd: "/project", model: "m1" });
  await hub.send(info.id, { text: "a secret prompt", images: [] }, "auto");
  clock.now = 1020;
  harness.emit(start(info.id, "t1"));
  clock.now = 1900;
  harness.emit({
    type: "item.started",
    sessionId: info.id,
    turnId: "t1",
    item: { id: "m", kind: "agentMessage", text: "" },
  });
  clock.now = 1950;
  harness.emit({
    type: "item.delta",
    sessionId: info.id,
    turnId: "t1",
    itemId: "m",
    delta: "An answer",
  });
  expect(log).toEqual([]);
  clock.now = 2500;
  harness.emit(end(info.id, "t1", "completed"));
  expect(log).toEqual([
    `turn ${info.id} completed: model=m1 effort=auto accepted=0ms started=20ms item=900ms:agentMessage stream=950ms done=1500ms`,
  ]);
  expect(log.join()).not.toContain("secret");
  expect(log.join()).not.toContain("An answer");
});

test("a turn the agent began by itself, and one that could not start, leave no line", async () => {
  const { harness, hub, log } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.emit(start(info.id, "own"));
  harness.emit(end(info.id, "own", "completed"));
  expect(log).toEqual([]);
  harness.failSend = "no";
  await expect(hub.send(info.id, { text: "x", images: [] }, "auto")).rejects.toThrow();
  expect(log).toEqual([]);
});
