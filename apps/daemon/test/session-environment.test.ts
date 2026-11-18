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
 * Where a session runs: the environment chosen, which the daemon keeps and gives the harness with
 * every turn, and the container's name an older daemon kept, which is read to recover it.
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
  const meta = await JsonStore.open<MetaFile>(
    memory(),
    { sessions: structuredClone(kept) },
    timers.schedule,
  );
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

test("an older record opened before its folder is known is told its environment once it is, and never a name", async () => {
  const { harness, hub, meta } = await setup(
    { s1: { sandbox: "cycle-project-1a" } },
    { environmentOfSandbox: () => "node" },
  );
  const loaded: unknown[] = [];
  harness.loadSession = async (sessionId, options) => {
    loaded.push(options);
    return { session: harness.session(sessionId, { cwd: "/project" }), turns: [], usage: null };
  };
  await hub.open("s1", undefined);
  // Read first with no place, since the folder is not known to try the name against, and then told
  // where it runs, so that what it is asked later (a compaction, files put back) starts there too.
  expect(loaded).toHaveLength(2);
  expect(loaded[0]).not.toHaveProperty("environment");
  expect(loaded[1]).toMatchObject({ environment: "node" });
  for (const options of loaded) expect(options).not.toHaveProperty("sandbox");
  expect(meta.value.sessions["s1"]).toEqual({ sandbox: "cycle-project-1a", environment: "node" });
});

test("an older record opened before its folder is known, whose environment is gone, is never told a place", async () => {
  const { harness, hub, meta } = await setup(
    { s1: { sandbox: "cycle-project-1a" } },
    { environmentOfSandbox: () => null },
  );
  const loaded: unknown[] = [];
  harness.loadSession = async (sessionId, options) => {
    loaded.push(options);
    return { session: harness.session(sessionId, { cwd: "/project" }), turns: [], usage: null };
  };
  await hub.open("s1", undefined);
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).not.toHaveProperty("environment");
  expect(loaded[0]).not.toHaveProperty("sandbox");
  await expect(hub.send("s1", { text: "go", images: [] }, "auto")).rejects.toThrow(
    "environment is gone",
  );
  expect(meta.value.sessions["s1"]).toEqual({ sandbox: "cycle-project-1a" });
});

test("a session records the environment chosen, and the harness is given it, and no name, every time", async () => {
  const { harness, hub, meta } = await setup();
  const created: unknown[] = [];
  const turns: unknown[] = [];
  harness.createSession = async (options) => {
    created.push(options);
    return harness.session("boxed", { cwd: options.cwd });
  };
  harness.send = async (_sessionId, _input, options) => {
    turns.push(options);
    return { turnId: "t1" };
  };
  const info = await hub.create({ cwd: "/project", environment: "standard" });
  expect(info.environment).toBe("standard");
  // The container's name is the harness's: neither the session nor its record has one.
  expect(info).not.toHaveProperty("sandbox");
  expect(meta.value.sessions["boxed"]).toEqual({ agentMode: "auto", environment: "standard" });
  await hub.send(info.id, { text: "go", images: [] }, "auto");
  expect(created).toEqual([expect.objectContaining({ environment: "standard" })]);
  expect(created[0]).not.toHaveProperty("sandboxed");
  expect(turns).toEqual([expect.objectContaining({ environment: "standard" })]);
  expect(turns[0]).not.toHaveProperty("sandbox");
  const copy = await hub.fork(info.id, null);
  expect(copy.environment).toBe("standard");
  expect(meta.value.sessions[copy.id]).toEqual({ agentMode: "auto", environment: "standard" });
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
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  const info = (await hub.list(false)).find((each) => each.id === "s1");
  expect(info).toMatchObject({ environment: "node" });
  expect(info).not.toHaveProperty("sandbox");
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
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  expect((await hub.list(false))[0]).toMatchObject({ environment: "kept" });
});

/** A record of an older daemon whose container no environment makes: its environment was removed. */
const gone = { s1: { sandbox: "cycle-project-1a" } };

test("a container no environment makes shows none, keeps its name, writes nothing and says so once", async () => {
  const { harness, hub, meta, logged } = await setup(gone, { environmentOfSandbox: () => null });
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  for (let times = 0; times < 2; times++) {
    const info = (await hub.list(false))[0];
    expect(info).toMatchObject({ environment: null });
    expect(info).not.toHaveProperty("sandbox");
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

test("a request from an older page that asks for a container is refused, never run on this machine", async () => {
  const { harness, hub, meta } = await setup();
  const created: unknown[] = [];
  harness.createSession = async (options) => {
    created.push(options);
    return harness.session("boxed", { cwd: options.cwd });
  };
  const old = { cwd: "/project", sandbox: "standard" } as never;
  await expect(hub.create(old)).rejects.toThrow("This page is older than the daemon");
  // Neither the harness nor the record heard of it.
  expect(created).toEqual([]);
  expect(meta.value.sessions).toEqual({});
});

test("a copy of a session in a container whose environment is gone is refused, and nothing is made", async () => {
  const { harness, hub, meta } = await setup(gone, { environmentOfSandbox: () => null });
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  await hub.list(false);
  const forked: string[] = [];
  harness.forkSession = async (sessionId) => {
    forked.push(sessionId);
    return harness.session("copy");
  };
  await expect(hub.fork("s1", null)).rejects.toThrow("environment is gone");
  // Made, it would carry no record of the container, and its next turn would run outside it.
  expect(forked).toEqual([]);
  expect(meta.value.sessions).toEqual({ s1: { sandbox: "cycle-project-1a" } });
});

test("a copy of a session whose environment is recovered only as it is copied carries it", async () => {
  let environment: string | null = null;
  const { harness, hub, meta } = await setup(gone, { environmentOfSandbox: () => environment });
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  // Listed while none makes the name: the session shows none.
  expect((await hub.list(false))[0]).toMatchObject({ environment: null });
  environment = "node";
  const copy = await hub.fork("s1", null);
  expect(copy.environment).toBe("node");
  expect(meta.value.sessions[copy.id]).toEqual({ agentMode: "auto", environment: "node" });
});

test("a copy of an older record's session carries its environment, and not the name", async () => {
  const { harness, hub, meta } = await setup(gone, { environmentOfSandbox: () => "node" });
  harness.stored = [harness.session("s1", { cwd: "/project" })];
  await hub.list(false);
  const copy = await hub.fork("s1", null);
  expect(copy.environment).toBe("node");
  expect(meta.value.sessions[copy.id]).toEqual({ agentMode: "auto", environment: "node" });
});
