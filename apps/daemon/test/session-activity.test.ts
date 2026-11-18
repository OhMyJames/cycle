import { expect, test } from "bun:test";
import type { EventFrame, HarnessEvent, Session, Settings, Turn } from "@cycle/protocol";
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
  const infos: Session[] = [];
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
    now: () => 1000,
    log: () => {},
    viewers: () => 0,
    publish: {
      frame: (frame) => frames.push(frame),
      sessions: (list) => infos.push(...list),
      removed: () => {},
      usage: () => {},
    },
  });
  /** What the owner's page was last told of a session. */
  const told = (id: string) => infos.findLast((info) => info.id === id);
  /** What the session shows now, as `sessions.changed` carries it and as the hub keeps it. */
  const shown = (id: string) => {
    expect(told(id)?.status).toBe(hub.info(id).status);
    return hub.info(id).status;
  };
  return { harness, hub, timers, infos, told, shown };
}

const start = (sessionId: string, turnId: string) =>
  ({ type: "turn.started", sessionId, turnId, startedAt: null }) as const;
const end = (
  sessionId: string,
  turnId: string,
  status: "completed" | "interrupted" | "failed" = "completed",
) =>
  ({
    type: "turn.completed",
    sessionId,
    turnId,
    status,
    error: status === "failed" ? "it broke" : null,
    durationMs: 1,
  }) as const;
const ask = (sessionId: string, kind: "command" | "question", turnId = "t1"): HarnessEvent => ({
  type: "approval.requested",
  sessionId,
  turnId,
  approval:
    kind === "command"
      ? { id: "a1", kind, itemId: "i", command: "ls", cwd: null, reason: null }
      : { id: "a1", kind, itemId: "i", questions: [] },
});
const answered = (sessionId: string) =>
  ({ type: "approval.resolved", sessionId, approvalId: "a1" }) as const;
const turn = (id: string, status: Turn["status"]): Turn => ({
  id,
  status,
  error: status === "failed" ? "it broke" : null,
  startedAt: null,
  durationMs: null,
  items: [],
  diff: null,
});
const prompt = { text: "go", images: [] };

test("a created session is idle, and running from the prompt being sent to the turn's end", async () => {
  const { harness, hub, shown } = await setup();
  const info = await hub.create({ cwd: "/project" });
  expect(info.status).toBe("idle");
  expect(shown(info.id)).toBe("idle");
  await hub.send(info.id, prompt, "auto");
  // Before the agent announces the turn: the session is starting, and counts as running.
  expect(shown(info.id)).toBe("running");
  harness.emit(start(info.id, "t1"));
  expect(shown(info.id)).toBe("running");
  harness.emit(end(info.id, "t1"));
  expect(shown(info.id)).toBe("idle");
});

test("an approval of any kind makes the session wait, and answering it runs it again", async () => {
  const { harness, hub, shown } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.emit(start(info.id, "t1"));
  expect(shown(info.id)).toBe("running");
  for (const kind of ["command", "question"] as const) {
    harness.emit(ask(info.id, kind));
    expect(shown(info.id)).toBe("waiting");
    harness.emit(answered(info.id));
    expect(shown(info.id)).toBe("running");
  }
});

test("a turn that ends, stopped or not, leaves the session idle; a failed one leaves an error", async () => {
  const { harness, hub, shown } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.emit(start(info.id, "t1"));
  harness.emit(end(info.id, "t1", "interrupted"));
  expect(shown(info.id)).toBe("idle");
  harness.emit(start(info.id, "t2"));
  harness.emit(end(info.id, "t2", "failed"));
  expect(shown(info.id)).toBe("error");
  // The next turn starting clears it; another ending well leaves it idle.
  await hub.send(info.id, prompt, "auto");
  expect(shown(info.id)).toBe("running");
  harness.emit(start(info.id, "t3"));
  harness.emit(end(info.id, "t3"));
  expect(shown(info.id)).toBe("idle");
});

test("a prompt the agent refuses leaves the session idle", async () => {
  const { harness, hub, shown } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.failSend = "no model";
  expect(hub.send(info.id, prompt, "auto")).rejects.toThrow("no model");
  await Promise.resolve();
  await Promise.resolve();
  expect(shown(info.id)).toBe("idle");
});

test("its agent exiting fails a running turn, and another agent's exit does not", async () => {
  const { harness, hub, shown } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.emit(start(info.id, "t1"));
  harness.emit({ type: "harness.exited", harness: "other", message: "other exited" });
  expect(shown(info.id)).toBe("running");
  harness.emit({ type: "harness.exited", harness: "fake", message: "fake exited" });
  expect(shown(info.id)).toBe("error");
});

test("a session only in the agent's list is stored; opened it is idle, or an error at once", async () => {
  const { harness, hub, told } = await setup();
  harness.stored = [harness.session("old"), harness.session("broken"), harness.session("cut")];
  expect((await hub.list(false)).map((info) => [info.id, info.status])).toEqual([
    ["old", "stored"],
    ["broken", "stored"],
    ["cut", "stored"],
  ]);
  await hub.open("old", undefined);
  expect(told("old")?.status).toBe("idle");
  harness.history = [turn("t0", "completed"), turn("t1", "failed")];
  await hub.open("broken", undefined);
  expect(told("broken")?.status).toBe("error");
  expect(hub.info("broken").status).toBe("error");
  // A turn the history left running was cut off: closed as stopped, so the session is idle.
  harness.history = [turn("t0", "running")];
  await hub.open("cut", undefined);
  expect(hub.info("cut").status).toBe("idle");
  expect((await hub.list(false)).map((info) => info.status)).toEqual(["idle", "error", "idle"]);
});

test("archiving an idle session stores it; one opened archived and then unarchived reads stored too", async () => {
  const { harness, hub, told } = await setup();
  const info = await hub.create({ cwd: "/project" });
  const archived = await hub.update({ sessionId: info.id, archived: true });
  expect(archived.status).toBe("stored");
  expect(told(info.id)?.status).toBe("stored");
  harness.stored = [harness.session("old")];
  await hub.list(true);
  await hub.open("old", undefined);
  expect(hub.info("old").status).toBe("idle");
  // The session is held, yet reads stored until its next event: kept as it is.
  expect((await hub.update({ sessionId: "old", archived: false })).status).toBe("stored");
  harness.emit(start("old", "t1"));
  expect(hub.info("old").status).toBe("running");
});

test("past the limit the least recently used idle session is let go, never a busy one", async () => {
  const { harness, hub, told } = await setup();
  harness.stored = Array.from({ length: 35 }, (_, index) => harness.session(`o${index + 1}`));
  await hub.open("o1", undefined);
  await hub.open("o2", undefined);
  harness.emit(start("o1", "t1"));
  harness.emit(start("o2", "t2"));
  harness.emit(ask("o2", "command", "t2"));
  for (let index = 3; index <= 35; index++) await hub.open(`o${index}`, undefined);
  expect(told("o1")?.status).toBe("running");
  expect(told("o2")?.status).toBe("waiting");
  // 35 held, 32 allowed: the three oldest idle ones go.
  for (const id of ["o3", "o4", "o5"]) {
    expect(told(id)?.status).toBe("stored");
    expect(hub.info(id).status).toBe("stored");
  }
  expect(told("o6")?.status).toBe("idle");
  expect(told("o35")?.status).toBe("idle");
});

test("a session is working while it is running or waiting, and not when idle, failed or stored", async () => {
  const { harness, hub } = await setup();
  const info = await hub.create({ cwd: "/project" });
  const working = () => [hub.working(info.id), hub.busyIn("/project")];
  expect(working()).toEqual([false, false]);
  await hub.send(info.id, prompt, "auto");
  expect(working()).toEqual([true, true]);
  harness.emit(start(info.id, "t1"));
  harness.emit(ask(info.id, "command"));
  expect(working()).toEqual([true, true]);
  expect(hub.busyIn("/elsewhere")).toBe(false);
  harness.emit(answered(info.id));
  harness.emit(end(info.id, "t1", "failed"));
  expect(hub.info(info.id).status).toBe("error");
  expect(working()).toEqual([false, false]);
  await hub.update({ sessionId: info.id, archived: true });
  expect(hub.info(info.id).status).toBe("stored");
  expect(working()).toEqual([false, false]);
});
