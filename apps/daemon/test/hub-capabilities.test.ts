import { expect, test } from "bun:test";
import type { Settings } from "@cycle/protocol";
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
const settings: Settings = {
  model: null,
  effort: null,
  modes: {},
  worktree: false,
  projects: [],
};

async function setup() {
  const harness = new FakeHarness();
  const timers = manualSchedule();
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
    viewers: () => 0,
    publish: { frame: () => {}, sessions: () => {}, removed: () => {}, usage: () => {} },
  });
  return { harness, hub, meta };
}

/** A session with one finished turn, `t1`. */
async function withTurn() {
  const all = await setup();
  const info = await all.hub.create({ cwd: "/project" });
  await all.hub.send(info.id, { text: "go", images: [] }, "auto");
  all.harness.emit({ type: "turn.started", sessionId: info.id, turnId: "t1", startedAt: null });
  all.harness.emit({
    type: "turn.completed",
    sessionId: info.id,
    turnId: "t1",
    status: "completed",
    error: null,
    durationMs: 1,
  });
  return { ...all, info };
}

test("going back with the files puts them back first, and takes nothing back when it cannot", async () => {
  const { harness, hub, info } = await withTurn();
  harness.fileRewind = {
    possible: false,
    error: "No copy was kept.",
    files: [],
    insertions: 0,
    deletions: 0,
  };
  await expect(hub.rewind(info.id, "t1", true)).rejects.toThrow("No copy was kept.");
  expect(harness.calls).toEqual([`rewind files ${info.id} t1`]);
  harness.fileRewind = {
    possible: true,
    error: null,
    files: ["/p/a"],
    insertions: 2,
    deletions: 1,
  };
  expect((await hub.previewRewind(info.id, "t1")).files).toEqual(["/p/a"]);
  await hub.rewind(info.id, "t1", true);
  expect(harness.calls.slice(1)).toEqual([
    `rewind files ${info.id} t1 dry`,
    `rewind files ${info.id} t1`,
    `rewind ${info.id} t1`,
  ]);
});

test("going back leaves the files alone unless asked", async () => {
  const { harness, hub, info } = await withTurn();
  await hub.rewind(info.id, "t1");
  expect(harness.calls).toEqual([`rewind ${info.id} t1`]);
});

test("a document goes only to an agent that reads its kind", async () => {
  const { harness, hub } = await setup();
  const info = await hub.create({ cwd: "/project" });
  const pdf = { kind: "pdf" as const, name: "a.pdf", data: "data:application/pdf;base64,JVBERg==" };
  await expect(
    hub.send(info.id, { text: "read", images: [], documents: [pdf] }, "auto"),
  ).rejects.toThrow("Fake cannot read a PDF attached to a prompt.");
  harness.capabilities = { ...harness.capabilities, attachments: ["image", "pdf"] };
  await hub.send(info.id, { text: "read", images: [], documents: [pdf] }, "auto");
  expect(harness.sent).toEqual([{ sessionId: info.id, text: "read" }]);
});

test("a session's other folders are kept, given with every turn, and readable", async () => {
  const { harness, hub, meta } = await setup();
  const asked: (string[] | undefined)[] = [];
  harness.createSession = async (options) => {
    asked.push(options.directories);
    return harness.session("s1", { cwd: options.cwd });
  };
  harness.send = async (_sessionId, _input, options) => {
    asked.push(options.directories);
    return { turnId: "t1" };
  };
  const info = await hub.create({
    cwd: "/project",
    directories: ["/shared", "/project", "/shared"],
  });
  expect(info.directories).toEqual(["/shared"]);
  expect(meta.value.sessions["s1"]?.directories).toEqual(["/shared"]);
  expect(hub.folders()).toContain("/shared");
  await hub.send("s1", { text: "go", images: [] }, "auto");
  expect(asked).toEqual([["/shared"], ["/shared"]]);
  await expect(
    hub.create({ cwd: "/project", sandbox: "standard", directories: ["/shared"] }),
  ).rejects.toThrow("A session in a sandbox reaches its own folder only.");
});

test("the context is the agent's own account of it, else what the latest request read", async () => {
  const { harness, hub } = await setup();
  const info = await hub.create({ cwd: "/project" });
  expect(await hub.context(info.id)).toBeNull();
  const count = { total: 40, input: 30, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 0 };
  harness.emit({
    type: "usage.updated",
    sessionId: info.id,
    usage: { total: count, last: count, contextWindow: 1000, costUsd: null },
  });
  expect(await hub.context(info.id)).toEqual({ tokens: 40, window: 1000, parts: [] });
  harness.context = {
    tokens: 50,
    window: 1000,
    parts: [{ id: "messages", name: "Messages", tokens: 50, kind: "used" }],
  };
  expect((await hub.context(info.id))?.parts).toHaveLength(1);
});

test("when the files went back but the conversation could not, the owner is told both", async () => {
  const { harness, hub, info } = await withTurn();
  harness.rewindSession = async () => {
    throw new Error("Claude Code no longer keeps that turn");
  };
  await expect(hub.rewind(info.id, "t1", true)).rejects.toThrow(
    "The files were put back as they were before that turn, but the conversation could not go back: Claude Code no longer keeps that turn. Its later turns are still there.",
  );
  // Without the files, the agent's own reason is enough.
  await expect(hub.rewind(info.id, "t1")).rejects.toThrow("Claude Code no longer keeps that turn");
});

test("a queued prompt's documents stay out of the session's state, and go with it when it is sent", async () => {
  const { harness, hub } = await setup();
  harness.capabilities = { ...harness.capabilities, attachments: ["image", "pdf"] };
  const given: unknown[] = [];
  harness.send = async (_sessionId, input) => {
    given.push(input.documents);
    return { turnId: `t${given.length}` };
  };
  const info = await hub.create({ cwd: "/project" });
  await hub.send(info.id, { text: "first", images: [] }, "auto");
  harness.emit({ type: "turn.started", sessionId: info.id, turnId: "t1", startedAt: null });
  const data = "data:application/pdf;base64,JVBERi0xLjQ=";
  const pdf = { kind: "pdf" as const, name: "plan.pdf", data };
  const queued = await hub.send(info.id, { text: "then", images: [], documents: [pdf] }, "auto");
  expect(queued).toEqual({ queued: true, id: expect.any(String) });
  const opened = await hub.open(info.id, undefined);
  if (!("state" in opened)) throw new Error("expected a snapshot");
  expect(opened.state.queue).toEqual([
    {
      id: queued.id ?? "",
      text: "then",
      images: [],
      documents: [{ kind: "pdf", name: "plan.pdf" }],
    },
  ]);
  expect(JSON.stringify(opened.state)).not.toContain(data);
  harness.emit({
    type: "turn.completed",
    sessionId: info.id,
    turnId: "t1",
    status: "completed",
    error: null,
    durationMs: 1,
  });
  expect(given).toEqual([undefined, [pdf]]);
});
