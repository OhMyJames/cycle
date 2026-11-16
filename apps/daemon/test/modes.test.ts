import { expect, test } from "bun:test";
import type { EventFrame, SessionInfo, Settings } from "@cycle/protocol";
import {
  Git,
  Harnesses,
  JsonStore,
  type MetaFile,
  SessionHub,
  type StoredSchedule,
  type UsageFile,
  UsageLedger,
  keptMode,
  scheduleMode,
} from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

const memory = () => ({ read: async () => null, write: async () => {} });

async function setup(stored: MetaFile = { sessions: {} }) {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const frames: EventFrame[] = [];
  const infos: SessionInfo[] = [];
  const settings: Settings = {
    model: null,
    effort: null,
    modes: {},
    worktree: false,
    projects: [],
  };
  const meta = await JsonStore.open<MetaFile>(memory(), stored, timers.schedule);
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
    viewers: () => 0,
    publish: {
      frame: (frame) => frames.push(frame),
      sessions: (list) => infos.push(...list),
      removed: () => {},
      usage: () => {},
    },
  });
  return { harness, hub, meta, settings, frames };
}

test("a mode kept before each agent named its own is read by what it meant then", () => {
  expect(keptMode({ mode: "auto" })).toBe("legacy:auto");
  expect(keptMode({ mode: "auto", agentMode: "plan" })).toBe("plan");
  expect(keptMode({})).toBeUndefined();
  const schedule = { mode: "fullAccess" } as StoredSchedule;
  expect(scheduleMode(schedule)).toBe("legacy:fullAccess");
  expect(scheduleMode({ ...schedule, agentMode: null })).toBeNull();
  expect(scheduleMode({ ...schedule, mode: null })).toBeNull();
});

test("a session's mode is one its agent offers: a kept one by what it replaces, else the default", async () => {
  const { harness, hub, settings } = await setup({
    sessions: { old: { mode: "readOnly" }, odd: { agentMode: "gone" } },
  });
  harness.modes = harness.modes.map((mode) =>
    mode.id === "readOnly" ? { ...mode, id: "ask" } : mode,
  );
  harness.stored = [harness.session("old"), harness.session("odd"), harness.session("new")];
  const listed = await hub.list(false);
  expect(listed.map((info) => [info.id, info.mode])).toEqual([
    ["old", "ask"],
    ["odd", "auto"],
    ["new", "auto"],
  ]);
  settings.modes = { fake: "plan" };
  expect((await hub.create({ cwd: "/project" })).mode).toBe("plan");
  expect((await hub.create({ cwd: "/project", mode: "legacy:fullAccess" })).mode).toBe(
    "fullAccess",
  );
  expect(hub.create({ cwd: "/project", mode: "root" })).rejects.toThrow(
    "Fake has no mode named root",
  );
});

test("a mode the owner changes is kept apart from the old word, and a live agent takes it now", async () => {
  const { harness, hub, meta } = await setup();
  const info = await hub.create({ cwd: "/project", mode: "readOnly" });
  harness.calls.length = 0;
  expect((await hub.update({ sessionId: info.id, mode: "plan" })).mode).toBe("plan");
  expect(meta.value.sessions[info.id]).toEqual({ agentMode: "plan" });
  expect(harness.calls).toEqual([`configure ${info.id} {"mode":"plan"}`]);
  await hub.update({ sessionId: info.id, effort: "low" });
  expect(harness.calls.at(-1)).toBe(`configure ${info.id} {"effort":"low"}`);
  // Back to the model's own effort reaches it too.
  await hub.update({ sessionId: info.id, effort: null });
  expect(harness.calls.at(-1)).toBe(`configure ${info.id} {"effort":null}`);
  expect(hub.update({ sessionId: info.id, mode: "root" })).rejects.toThrow("no mode named root");
});

test("a mode that never asks is the owner's to choose: the agent's word does not keep it", async () => {
  const { harness, hub, meta, frames } = await setup();
  const info = await hub.create({ cwd: "/project", mode: "readOnly" });
  harness.emit({ type: "mode.changed", sessionId: info.id, mode: "fullAccess" });
  expect(hub.info(info.id).mode).toBe("readOnly");
  expect(meta.value.sessions[info.id]?.agentMode).toBe("readOnly");
  expect(frames.at(-1)?.events).toMatchObject([{ type: "notice", level: "warning" }]);
});

test("a session whose agent is known only once loaded is told its mode before anything runs", async () => {
  const { harness, hub } = await setup({ sessions: { s9: { agentMode: "plan" } } });
  await hub.open("s9", undefined);
  expect(harness.calls).toEqual(["load s9", `configure s9 {"mode":"plan"}`]);
});

test("the agent moving itself to another mode is kept and said in the conversation", async () => {
  const { harness, hub, meta, frames } = await setup();
  const info = await hub.create({ cwd: "/project", mode: "auto" });
  harness.emit({ type: "mode.changed", sessionId: info.id, mode: "plan" });
  expect(hub.info(info.id).mode).toBe("plan");
  expect(meta.value.sessions[info.id]?.agentMode).toBe("plan");
  expect(frames.at(-1)?.events).toEqual([
    { type: "notice", sessionId: info.id, level: "info", message: "Fake moved to plan." },
  ]);
  // A mode the agent does not offer is no news.
  harness.emit({ type: "mode.changed", sessionId: info.id, mode: "root" });
  expect(hub.info(info.id).mode).toBe("plan");
});

test("several agents offer their modes together, and a change reaches the session's own", async () => {
  const main = new FakeHarness();
  const other = new FakeHarness("claude");
  other.models = [{ ...main.session("x"), id: "sonnet", harness: "claude" } as never];
  const joined = new Harnesses(main, [other]);
  await joined.start();
  expect(joined.listModes().map((mode) => `${mode.harness}/${mode.id}`)).toEqual([
    "fake/readOnly",
    "fake/auto",
    "fake/plan",
    "fake/fullAccess",
    "claude/readOnly",
    "claude/auto",
    "claude/plan",
    "claude/fullAccess",
  ]);
  const session = await joined.createSession({ cwd: "/project", model: "sonnet" });
  await joined.configure(session.id, { mode: "plan" });
  expect(other.calls).toEqual([`configure ${session.id} {"mode":"plan"}`]);
  expect(main.calls).toEqual([]);
});
