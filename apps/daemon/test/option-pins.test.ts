import { expect, test } from "bun:test";
import type {
  Agents,
  CreateSessionOptions,
  EventFrame,
  ModelInfo,
  Settings,
} from "@cycle/protocol";
import {
  Git,
  Harnesses,
  JsonStore,
  type MetaFile,
  SessionHub,
  type StoredSchedule,
  type UsageFile,
  UsageLedger,
  checkScheduleInput,
  runAgentProblem,
  scheduleMode,
} from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

/** What a session does with the choices its agent offers today, pinned before they become one list (step 18). */

const memory = () => ({ read: async () => null, write: async () => {} });

async function setup(stored: MetaFile = { sessions: {} }, join?: (main: FakeHarness) => Agents) {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const frames: EventFrame[] = [];
  const settings: Settings = {
    model: null,
    effort: null,
    modes: {},
    worktree: false,
    projects: [],
  };
  const meta = await JsonStore.open<MetaFile>(memory(), stored, timers.schedule);
  const usageFile = await JsonStore.open<UsageFile>(memory(), { days: {} }, timers.schedule);
  const agents = join ? join(harness) : harness.asAgents();
  await agents.start();
  const hub = new SessionHub({
    harness: agents,
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
      sessions: () => {},
      removed: () => {},
      usage: () => {},
    },
  });
  return { harness, hub, meta, settings, frames };
}

const model = (id: string, harness: string, provider: ModelInfo["provider"] = null): ModelInfo => ({
  id,
  harness,
  name: id.toUpperCase(),
  description: "",
  efforts: [],
  defaultEffort: null,
  isDefault: false,
  images: true,
  sandbox: false,
  provider,
});

test("a mode the owner names that the agent does not offer is refused, and nothing changes", async () => {
  const { harness, hub, meta } = await setup();
  const info = await hub.create({ cwd: "/project", mode: "plan" });
  const before = structuredClone(meta.value.sessions[info.id]);
  harness.calls.length = 0;
  expect(hub.update({ sessionId: info.id, mode: "root" })).rejects.toThrow(
    "Fake has no mode named root.",
  );
  expect(hub.create({ cwd: "/project", mode: "root" })).rejects.toThrow(
    "Fake has no mode named root.",
  );
  expect(hub.info(info.id).mode).toBe("plan");
  expect(meta.value.sessions[info.id]).toEqual(before as never);
  expect(harness.calls).toEqual([]);
});

test("a model of another family is refused in the agent's words, a listed one of the same is not", async () => {
  const { harness, hub, meta } = await setup();
  harness.models = [
    model("a", "fake"),
    model("a2", "fake"),
    model("mine/b", "fake", { id: "mine", name: "Mine" }),
  ];
  const own = await hub.create({ cwd: "/project", model: "a" });
  expect(hub.update({ sessionId: own.id, model: "mine/b" })).rejects.toThrow(
    "This session began on one of the agent's own models and stays with that kind. Start a new session to use MINE/B.",
  );
  expect(hub.info(own.id).model).toBe("a");
  expect(meta.value.sessions[own.id]?.model).toBe("a");
  expect((await hub.update({ sessionId: own.id, model: "a2" })).model).toBe("a2");
  // A model nobody listed is not checked: the agent decides what to do with it.
  expect((await hub.update({ sessionId: own.id, model: "unlisted" })).model).toBe("unlisted");

  const mine = await hub.create({ cwd: "/project", model: "mine/b" });
  expect(hub.update({ sessionId: mine.id, model: "a" })).rejects.toThrow(
    "This session began on a model of your own provider and stays with that kind. Start a new session to use A.",
  );
});

test("a model of another agent is refused, and the session stays with the agent it began on", async () => {
  const { harness, hub } = await setup(undefined, (main) => {
    const other = new FakeHarness("claude");
    other.models = [model("sonnet", "claude")];
    return new Harnesses(main, [other]);
  });
  harness.models = [model("a", "fake")];
  const info = await hub.create({ cwd: "/project", model: "a" });
  expect(hub.update({ sessionId: info.id, model: "sonnet" })).rejects.toThrow(
    "This session began on Fake and stays with that kind. Start a new session to use SONNET.",
  );
  // The model picks the agent: a new session on it is the other agent's.
  expect((await hub.create({ cwd: "/project", model: "sonnet" })).harness).toBe("claude");
  // Nothing named, or a model nobody lists, is the main agent's.
  expect(await hub.agentFor(undefined)).toBe("fake");
  expect(await hub.agentFor("gone")).toBe("fake");
});

test("an effort of null is kept as null and shown as null, and an effort is not checked", async () => {
  const { harness, hub, meta } = await setup();
  const info = await hub.create({ cwd: "/project" });
  expect(meta.value.sessions[info.id]).toEqual({ agentMode: "auto" });
  expect((await hub.update({ sessionId: info.id, effort: "unheard-of" })).effort).toBe(
    "unheard-of",
  );
  expect((await hub.update({ sessionId: info.id, effort: null })).effort).toBeNull();
  expect(meta.value.sessions[info.id]).toEqual({ agentMode: "auto", effort: null });
  expect(hub.info(info.id).effort).toBeNull();
  expect(harness.calls.at(-1)).toBe(`configure ${info.id} {"effort":null}`);
});

test("the agent moving itself into a mode that never asks is not followed, and the owner is told", async () => {
  const { harness, hub, meta, frames } = await setup();
  const info = await hub.create({ cwd: "/project", mode: "plan" });
  harness.emit({ type: "mode.changed", sessionId: info.id, mode: "fullAccess" });
  expect(hub.info(info.id).mode).toBe("plan");
  expect(meta.value.sessions[info.id]?.agentMode).toBe("plan");
  expect(frames.at(-1)?.events).toEqual([
    {
      type: "notice",
      sessionId: info.id,
      level: "warning",
      message:
        "Fake moved to fullAccess. The session stays in its mode, and its next turn starts in it.",
    },
  ]);
  // The owner naming it is another thing: it is theirs to choose.
  expect((await hub.update({ sessionId: info.id, mode: "fullAccess" })).mode).toBe("fullAccess");
});

test("a new session is written with its mode always, and its model and effort only when asked", async () => {
  const { harness, hub, meta, settings } = await setup();
  const made: CreateSessionOptions[] = [];
  const create = harness.createSession;
  harness.createSession = async (options) => {
    made.push(options);
    return create(options);
  };
  settings.model = "usual";
  settings.effort = "high";
  settings.modes = { fake: "plan" };
  const usual = await hub.create({ cwd: "/project" });
  // What the owner usually uses reaches the agent, and is not kept as this session's own choice.
  expect(made[0]).toMatchObject({ model: "usual", effort: "high", mode: "plan" });
  expect(meta.value.sessions[usual.id]).toEqual({ agentMode: "plan" });
  const asked = await hub.create({ cwd: "/project", model: "m", effort: "low", mode: "auto" });
  expect(meta.value.sessions[asked.id]).toEqual({ agentMode: "auto", model: "m", effort: "low" });
});

test("a fork keeps the mode, and the model and effort the owner chose, but not an effort of null", async () => {
  const { hub, meta } = await setup();
  const chosen = await hub.create({ cwd: "/project", model: "m", effort: "low", mode: "plan" });
  const copy = await hub.fork(chosen.id, null);
  expect(meta.value.sessions[copy.id]).toEqual({ agentMode: "plan", model: "m", effort: "low" });
  const plain = await hub.create({ cwd: "/project", mode: "auto" });
  await hub.update({ sessionId: plain.id, effort: null });
  const plainCopy = await hub.fork(plain.id, null);
  // A null effort is not copied by a fork, so the copy reads as "ask the agent".
  expect(meta.value.sessions[plainCopy.id]).toEqual({ agentMode: "auto" });
});

const stored = (patch: Record<string, unknown>) => patch as unknown as StoredSchedule;

test("a schedule's mode is read as stored, and is one agent's: a run on another is refused", () => {
  expect(scheduleMode(stored({ mode: "readOnly" }))).toBe("legacy:readOnly");
  expect(scheduleMode(stored({ mode: "plan" }))).toBe("plan");
  expect(scheduleMode(stored({ mode: "auto", agentMode: "dontAsk" }))).toBe("dontAsk");
  expect(scheduleMode(stored({ mode: "auto", agentMode: null }))).toBeNull();
  expect(scheduleMode(stored({ mode: null }))).toBeNull();

  const problem = (patch: Record<string, unknown>, agent: string) =>
    runAgentProblem(stored({ mode: null, ...patch }), agent);
  expect(problem({ agentMode: "auto", modeHarness: "codex" }, "codex")).toBeNull();
  expect(problem({ agentMode: "auto", modeHarness: "codex" }, "claude")).toBe(
    "Its mode is one of Codex's, and this run would start on Claude. Choose its mode again.",
  );
  // Without a mode, or one from before agents were named, any agent will do.
  expect(problem({ agentMode: null, modeHarness: "codex" }, "claude")).toBeNull();
  expect(problem({ mode: "auto" }, "claude")).toBeNull();
});

const input = (patch: Record<string, unknown>) =>
  ({
    name: "n",
    prompt: "p",
    cwd: "/p",
    enabled: false,
    worktree: false,
    model: "",
    effort: "",
    mode: null,
    timing: { kind: "once", at: 5 },
    ...patch,
  }) as never;

test("a schedule input names a mode its agent offers, or one kept from before, or none", () => {
  const modes = new FakeHarness("codex").listModes();
  const checked = checkScheduleInput(input({ mode: "plan", modeHarness: "codex" }), modes);
  expect(checked).toMatchObject({ mode: "plan", modeHarness: "codex", model: null, effort: null });
  expect(
    checkScheduleInput(input({ mode: "legacy:auto", modeHarness: "codex" }), modes),
  ).toMatchObject({ mode: "legacy:auto", modeHarness: null });
  expect(checkScheduleInput(input({}), modes)).toMatchObject({ mode: null, modeHarness: null });
  expect(() => checkScheduleInput(input({ mode: "plan", modeHarness: "claude" }), modes)).toThrow(
    "Unknown mode.",
  );
  expect(() => checkScheduleInput(input({ mode: "plan" }), modes)).toThrow("Unknown mode.");
});
