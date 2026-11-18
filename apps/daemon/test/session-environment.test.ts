import { expect, test } from "bun:test";
import type { Settings } from "@cycle/protocol";
import { Git, JsonStore, type MetaFile, SessionHub, UsageLedger } from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

/**
 * Where a session runs: the container's name the harness answered, which the daemon keeps and gives
 * again with every turn.
 */

const memory = () => ({ read: async () => null, write: async () => {} });

async function setup(kept: MetaFile["sessions"] = {}) {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const settings: Settings = {
    model: null,
    effort: null,
    modes: {},
    worktree: false,
    projects: [],
  };
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
    log: () => {},
    viewers: () => 0,
    publish: { frame: () => {}, sessions: () => {}, removed: () => {}, usage: () => {} },
  });
  return { harness, hub, meta };
}

test("a session's sandbox is kept, and given again with every turn", async () => {
  const { harness, hub, meta } = await setup();
  const seen: unknown[] = [];
  harness.createSession = async (options) => {
    seen.push(options.sandboxed);
    return harness.session("boxed", { cwd: options.cwd, sandbox: "cycle-project-1" });
  };
  harness.send = async (_sessionId, _input, options) => {
    seen.push(options.sandbox);
    return { turnId: "t1" };
  };
  const info = await hub.create({ cwd: "/project", sandbox: "standard" });
  expect(info.sandbox).toBe("cycle-project-1");
  expect(meta.value.sessions["boxed"]?.sandbox).toBe("cycle-project-1");
  await hub.send(info.id, { text: "go", images: [] }, "auto");
  expect(seen).toEqual(["standard", "cycle-project-1"]);
  expect((await hub.fork(info.id, null)).sandbox).toBe("cycle-project-1");
  expect(hub.create({ cwd: "/project", sandbox: "standard", worktree: {} })).rejects.toThrow(
    "not a worktree",
  );
});

test("a session in a sandbox takes no extra folders, and a copy of it is in the sandbox too", async () => {
  const { harness, hub, meta } = await setup();
  harness.createSession = async (options) =>
    harness.session("boxed", { cwd: options.cwd, sandbox: "cycle-project-1" });
  expect(
    hub.create({ cwd: "/project", sandbox: "standard", directories: ["/other"] }),
  ).rejects.toThrow("reaches its own folder only");
  const info = await hub.create({ cwd: "/project", sandbox: "standard" });
  const copy = await hub.fork(info.id, null);
  expect(meta.value.sessions[copy.id]?.sandbox).toBe("cycle-project-1");
});

test("a session opened by a daemon that started later is given the sandbox it was kept with", async () => {
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
