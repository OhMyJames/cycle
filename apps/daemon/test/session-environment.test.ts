import { expect, test } from "bun:test";
import type { Settings } from "@cycle/protocol";
import {
  Git,
  type HubOptions,
  JsonStore,
  type MetaFile,
  SessionHub,
  UsageLedger,
} from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

/**
 * Where a session runs: the container's name the harness answered, which the daemon keeps and gives
 * again with every turn.
 */

const memory = () => ({ read: async () => null, write: async () => {} });

async function setup(kept: MetaFile["sessions"] = {}, more: Partial<HubOptions> = {}) {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const settings: Settings = {
    model: null,
    effort: null,
    modes: {},
    worktree: false,
    projects: [],
  };
  const logged: string[] = [];
  const meta = await JsonStore.open<MetaFile>(memory(), { sessions: kept }, timers.schedule);
  const hub = new SessionHub({
    harness: harness.asAgents(),
    meta,
    settings: () => settings,
    usage: new UsageLedger(await JsonStore.open(memory(), { days: {} }, timers.schedule), () => 0),
    git: new Git((argv, execOptions) => harness.exec(argv, execOptions)),
    legacyWorktrees: "/home/worktrees",
    schedule: timers.schedule,
    now: () => 1000,
    log: (line) => logged.push(line),
    viewers: () => 0,
    publish: { frame: () => {}, sessions: () => {}, removed: () => {}, usage: () => {} },
    ...more,
  });
  return { harness, hub, meta, logged };
}

test("a copy of a session in a container is in the container too", async () => {
  const { harness, hub, meta } = await setup();
  harness.createSession = async (options) =>
    harness.session("boxed", { cwd: options.cwd, sandbox: "cycle-project-1" });
  const info = await hub.create({ cwd: "/project", environment: "standard" });
  const copy = await hub.fork(info.id, null);
  expect(meta.value.sessions[copy.id]?.sandbox).toBe("cycle-project-1");
});

test("a session kept with its environment is opened with it, whatever name an older daemon kept", async () => {
  const { harness, hub } = await setup({
    s1: { environment: "standard", sandbox: "cycle-project-1" },
  });
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  await hub.list(false);
  const loaded: unknown[] = [];
  harness.loadSession = async (sessionId, options) => {
    loaded.push(options);
    return { session: harness.session(sessionId, { cwd: "/project" }), turns: [], usage: null };
  };
  await hub.open("s1", undefined);
  expect(loaded).toEqual([expect.objectContaining({ environment: "standard" })]);
  expect(loaded[0]).not.toHaveProperty("sandbox");
});

test("an older record opened before its folder is known is still given the name it kept", async () => {
  const { harness, hub } = await setup({ s1: { sandbox: "cycle-project-1" } });
  const loaded: unknown[] = [];
  harness.loadSession = async (sessionId, options) => {
    loaded.push(options.sandbox);
    return {
      session: harness.session(sessionId, { sandbox: "cycle-project-1" }),
      turns: [],
      usage: null,
    };
  };
  await hub.open("s1", undefined);
  expect(loaded).toEqual(["cycle-project-1"]);
});

test("a session records the environment chosen, and the harness is given it, and no name, every time", async () => {
  const { harness, hub, meta } = await setup();
  const created: unknown[] = [];
  const turns: unknown[] = [];
  harness.createSession = async (options) => {
    created.push(options);
    return harness.session("boxed", { cwd: options.cwd, sandbox: "cycle-project-1" });
  };
  harness.send = async (_sessionId, _input, options) => {
    turns.push(options);
    return { turnId: "t1" };
  };
  const info = await hub.create({ cwd: "/project", environment: "standard" });
  expect(info).toMatchObject({ environment: "standard", sandbox: "cycle-project-1" });
  expect(meta.value.sessions["boxed"]?.environment).toBe("standard");
  await hub.send(info.id, { text: "go", images: [] }, "auto");
  expect(created).toEqual([expect.objectContaining({ environment: "standard" })]);
  expect(created[0]).not.toHaveProperty("sandboxed");
  expect(turns).toEqual([expect.objectContaining({ environment: "standard" })]);
  expect(turns[0]).not.toHaveProperty("sandbox");
  const copy = await hub.fork(info.id, null);
  expect(copy.environment).toBe("standard");
  expect(meta.value.sessions[copy.id]?.environment).toBe("standard");
  // The same refusals, whichever word asked.
  expect(hub.create({ cwd: "/project", environment: "standard", worktree: {} })).rejects.toThrow(
    "not a worktree",
  );
  expect(
    hub.create({ cwd: "/project", environment: "standard", directories: ["/other"] }),
  ).rejects.toThrow("reaches its own folder only");
});

test("a session on this machine has no environment", async () => {
  const { hub, meta } = await setup();
  const info = await hub.create({ cwd: "/project" });
  expect(info.environment).toBeNull();
  expect(meta.value.sessions[info.id]).not.toHaveProperty("environment");
});

test("a record that kept only the container's name has its environment recovered, and kept", async () => {
  const asked: string[][] = [];
  const { harness, hub, meta, logged } = await setup(
    { s1: { sandbox: "cycle-project-1a" } },
    {
      environmentOfSandbox: (name, cwd) => {
        asked.push([name, cwd]);
        return "node";
      },
    },
  );
  harness.stored = [harness.session("s1", { cwd: "/project", sandbox: "cycle-project-1a" })];
  const info = (await hub.list(false)).find((each) => each.id === "s1");
  expect(info).toMatchObject({ environment: "node", sandbox: "cycle-project-1a" });
  expect(meta.value.sessions["s1"]).toEqual({ sandbox: "cycle-project-1a", environment: "node" });
  // Kept once: the environment may be removed, and with it what could say it again.
  await hub.list(false);
  expect(asked).toEqual([["cycle-project-1a", "/project"]]);
  expect(logged).toEqual([]);
  // The agent is told the environment alone: it derives the container's name from it.
  const loaded: unknown[] = [];
  harness.loadSession = async (sessionId, options) => {
    loaded.push(options);
    return { session: harness.session(sessionId, { cwd: "/project" }), turns: [], usage: null };
  };
  await hub.open("s1", undefined);
  expect(loaded).toEqual([expect.objectContaining({ environment: "node" })]);
  expect(loaded[0]).not.toHaveProperty("sandbox");
});

test("a record with both keys keeps its environment, and asks nobody", async () => {
  const { harness, hub } = await setup(
    { s1: { sandbox: "cycle-project-1a", environment: "kept" } },
    {
      environmentOfSandbox: () => {
        throw new Error("nothing to recover");
      },
    },
  );
  harness.stored = [harness.session("s1", { cwd: "/project", sandbox: "cycle-project-1a" })];
  expect((await hub.list(false))[0]).toMatchObject({ environment: "kept" });
});

/** A record of an older daemon whose container no environment makes: its environment was removed. */
const gone = { s1: { sandbox: "cycle-project-1a" } };

test("a container no environment makes shows none, keeps its name, writes nothing and says so once", async () => {
  const { harness, hub, meta, logged } = await setup(gone, { environmentOfSandbox: () => null });
  harness.stored = [harness.session("s1", { cwd: "/project", sandbox: "cycle-project-1a" })];
  for (let times = 0; times < 2; times++) {
    expect((await hub.list(false))[0]).toMatchObject({
      environment: null,
      sandbox: "cycle-project-1a",
    });
  }
  expect(meta.value.sessions["s1"]).toEqual({ sandbox: "cycle-project-1a" });
  expect(logged).toEqual(["session s1 has a sandbox whose environment is unknown"]);
});

test("a session in a container whose environment is gone is never started outside it", async () => {
  const { harness, hub, meta } = await setup(gone, { environmentOfSandbox: () => null });
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  await hub.list(false);
  const loaded: unknown[] = [];
  harness.loadSession = async (sessionId, options) => {
    loaded.push(options);
    return { session: harness.session(sessionId, { cwd: "/project" }), turns: [], usage: null };
  };
  const sent: string[] = [];
  harness.send = async (sessionId) => {
    sent.push(sessionId);
    return { turnId: "t1" };
  };
  harness.compactSession = async () => {
    sent.push("compact");
  };
  const refusal = "Its sandbox's environment is gone. Choose an environment for the session.";
  // It opens, to be read, but its agent is told neither a name nor an environment, so nothing of
  // its conversation is moved into a container either.
  await hub.open("s1", undefined);
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).not.toHaveProperty("sandbox");
  expect(loaded[0]).not.toHaveProperty("environment");
  await expect(hub.send("s1", { text: "go", images: [] }, "auto")).rejects.toThrow(refusal);
  await expect(hub.compact("s1")).rejects.toThrow(refusal);
  expect(sent).toEqual([]);
  // The record is as it was: nothing was chosen for the owner.
  expect(meta.value.sessions["s1"]).toEqual({ sandbox: "cycle-project-1a" });
});

test("putting files back, and previewing it, are refused for a container whose environment is gone", async () => {
  const { harness, hub } = await setup(gone, { environmentOfSandbox: () => null });
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  harness.history = [
    {
      id: "t0",
      status: "completed",
      error: null,
      startedAt: null,
      durationMs: null,
      items: [],
      diff: null,
    },
  ];
  await hub.list(false);
  const refusal = "Its sandbox's environment is gone. Choose an environment for the session.";
  await expect(hub.rewind("s1", "t0", true)).rejects.toThrow(refusal);
  await expect(hub.previewRewind("s1", "t0")).rejects.toThrow(refusal);
  // Nothing reached the agent: not the files, and not the conversation either.
  expect(harness.calls.filter((call) => call.startsWith("rewind"))).toEqual([]);
});

test("a session whose environment comes back is recovered at its next turn", async () => {
  let environment: string | null = null;
  const { harness, hub } = await setup(gone, { environmentOfSandbox: () => environment });
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  await hub.list(false);
  await expect(hub.send("s1", { text: "go", images: [] }, "auto")).rejects.toThrow(
    "environment is gone",
  );
  environment = "node";
  const told: unknown[] = [];
  harness.send = async (_sessionId, _input, options) => {
    told.push(options.environment);
    return { turnId: "t1" };
  };
  await hub.send("s1", { text: "go", images: [] }, "auto");
  expect(told).toEqual(["node"]);
});
