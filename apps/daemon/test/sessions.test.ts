import { expect, test } from "bun:test";
import type { DayUsage, EventFrame, SessionInfo, Settings } from "@cycle/protocol";
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
  const infos: SessionInfo[] = [];
  const usage: DayUsage[] = [];
  const viewers = new Map<string, number>();
  const settings: Settings = {
    model: null,
    effort: null,
    mode: "auto",
    worktree: false,
    projects: [],
  };
  const meta = await JsonStore.open<MetaFile>(memory(), { sessions: {} }, timers.schedule);
  const usageFile = await JsonStore.open<UsageFile>(memory(), { days: {} }, timers.schedule);
  const hub = new SessionHub({
    harness,
    meta,
    settings: () => settings,
    usage: new UsageLedger(usageFile, () => 0),
    git: new Git((argv, options) => harness.exec(argv, options)),
    worktreeParent: "/home/worktrees",
    schedule: timers.schedule,
    now: () => 1000,
    viewers: (id) => viewers.get(id) ?? 0,
    publish: {
      frame: (frame) => frames.push(frame),
      sessions: (list) => infos.push(...list),
      removed: () => {},
      usage: (day) => usage.push(day),
    },
  });
  const status = (id: string) => infos.findLast((info) => info.id === id)?.status;
  return { harness, hub, timers, frames, infos, usage, viewers, meta, status };
}

const start = (sessionId: string, turnId: string) =>
  ({ type: "turn.started", sessionId, turnId, startedAt: null }) as const;
const end = (
  sessionId: string,
  turnId: string,
  status: "completed" | "interrupted" = "completed",
) => ({ type: "turn.completed", sessionId, turnId, status, error: null, durationMs: 1 }) as const;
const delta = (sessionId: string, text: string) =>
  ({ type: "item.delta", sessionId, turnId: "t1", itemId: "m", delta: text }) as const;

const count = (total: number) => ({
  total: { total, input: total, cachedInput: 0, output: 0, reasoning: 0 },
  last: { total, input: total, cachedInput: 0, output: 0, reasoning: 0 },
  contextWindow: null,
});

test("streamed text is batched into one frame, numbered without gaps", async () => {
  const { harness, hub, timers, frames, status } = await setup();
  const info = await hub.create({ cwd: "/project" });
  expect(info).toMatchObject({ status: "idle", mode: "auto" });
  await hub.send(info.id, { text: "go", images: [] }, "auto");
  expect(status(info.id)).toBe("running");
  harness.emit(start(info.id, "t1"));
  harness.emit({
    type: "item.started",
    sessionId: info.id,
    turnId: "t1",
    item: { id: "m", kind: "agentMessage", text: "" },
  });
  for (const part of ["a", "b", "c"]) harness.emit(delta(info.id, part));
  expect(frames.length).toBe(2);
  timers.run();
  expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
  expect(frames[2]?.events).toEqual([delta(info.id, "abc")]);
  harness.emit(end(info.id, "t1"));
  expect(status(info.id)).toBe("idle");
});

test("a client that was away gets only the frames it missed, or the whole state", async () => {
  const { harness, hub } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.emit(start(info.id, "t1"));
  harness.emit(end(info.id, "t1"));
  const fresh = await hub.open(info.id, undefined);
  const epoch = "state" in fresh ? fresh.state.epoch : "";
  const caughtUp = await hub.open(info.id, { seq: 1, epoch });
  expect("frames" in caughtUp && caughtUp.frames.map((frame) => frame.seq)).toEqual([2]);
  expect("state" in fresh && fresh.state.seq).toBe(2);
  expect("state" in (await hub.open(info.id, { seq: 99, epoch }))).toBe(true);
  // A number from another run of frames, such as before a restart, counts for nothing.
  expect("state" in (await hub.open(info.id, { seq: 1, epoch: "earlier" }))).toBe(true);
});

test("a prompt sent during a turn waits, then runs when the turn completes", async () => {
  const { harness, hub } = await setup();
  const info = await hub.create({ cwd: "/project" });
  await hub.send(info.id, { text: "one", images: [] }, "auto");
  harness.emit(start(info.id, "t1"));
  expect(await hub.send(info.id, { text: "two", images: [] }, "auto")).toEqual({ queued: true });
  expect(await hub.send(info.id, { text: "now", images: [] }, "steer")).toEqual({ queued: false });
  expect(harness.steered).toEqual(["now"]);
  expect(harness.sent.map((sent) => sent.text)).toEqual(["one"]);
  harness.emit(end(info.id, "t1"));
  expect(harness.sent.map((sent) => sent.text)).toEqual(["one", "two"]);
  const state = await hub.open(info.id, undefined);
  expect("state" in state && state.state.queue).toEqual([]);
});

test("a stopped turn sends nothing more, and gives the queue up", async () => {
  const { harness, hub, frames } = await setup();
  const info = await hub.create({ cwd: "/project" });
  await hub.send(info.id, { text: "one", images: [] }, "auto");
  harness.emit(start(info.id, "t1"));
  await hub.send(info.id, { text: "two", images: [] }, "auto");
  harness.emit(end(info.id, "t1", "interrupted"));
  expect(harness.sent.length).toBe(1);
  expect(frames.at(-1)?.events).toEqual([{ type: "queue.updated", sessionId: info.id, queue: [] }]);
});

test("an approval makes a session wait, and nobody watching makes it unread", async () => {
  const { harness, hub, status, infos, viewers } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.emit(start(info.id, "t1"));
  harness.emit({
    type: "approval.requested",
    sessionId: info.id,
    turnId: "t1",
    approval: { id: "a1", kind: "fileChange", itemId: "i", reason: null },
  });
  expect(status(info.id)).toBe("waiting");
  harness.emit({ type: "approval.resolved", sessionId: info.id, approvalId: "a1" });
  expect(status(info.id)).toBe("running");
  harness.emit(end(info.id, "t1"));
  expect(infos.findLast((row) => row.id === info.id)).toMatchObject({
    unread: true,
    updatedAt: 1000,
  });
  hub.markRead(info.id);
  viewers.set(info.id, 1);
  harness.emit(start(info.id, "t2"));
  harness.emit(end(info.id, "t2"));
  expect(infos.findLast((row) => row.id === info.id)?.unread).toBe(false);
});

test("usage counts what a session adds, not what it had before it was opened", async () => {
  const { harness, hub, usage } = await setup();
  await hub.open("old", undefined);
  harness.emit({ type: "usage.updated", sessionId: "old", usage: count(500) });
  expect(usage).toEqual([]);
  harness.emit({ type: "usage.updated", sessionId: "old", usage: count(650) });
  expect(usage.at(-1)?.tokens.total).toBe(150);
  const fresh = await hub.create({ cwd: "/project" });
  harness.emit({ type: "usage.updated", sessionId: fresh.id, usage: count(40) });
  expect(usage.at(-1)?.tokens.total).toBe(190);
});

test("what a session used before it loaded is the mark, and going back sets a new one", async () => {
  const { harness, hub, usage } = await setup();
  harness.loadedUsage = count(500);
  await hub.open("old", undefined);
  harness.emit({ type: "usage.updated", sessionId: "old", usage: count(650) });
  expect(usage.at(-1)?.tokens.total).toBe(150);
  await hub.send("old", { text: "go", images: [] }, "auto");
  harness.emit(start("old", "t1"));
  harness.emit(end("old", "t1"));
  await hub.rewind("old", "t1");
  // The shorter history's count is lower: it is not work done today.
  harness.emit({ type: "usage.updated", sessionId: "old", usage: count(300) });
  expect(usage.at(-1)?.tokens.total).toBe(150);
  harness.emit({ type: "usage.updated", sessionId: "old", usage: count(340) });
  expect(usage.at(-1)?.tokens.total).toBe(190);
});

test("a stored session is loaded once, and a turn its history left running is closed", async () => {
  const { harness, hub } = await setup();
  harness.stored = [harness.session("old", { preview: "earlier" })];
  harness.history = [
    {
      id: "t0",
      status: "running",
      error: null,
      startedAt: null,
      durationMs: null,
      items: [],
      diff: null,
    },
  ];
  expect((await hub.list(false)).map((info) => [info.id, info.status])).toEqual([
    ["old", "stored"],
  ]);
  const [first, second] = await Promise.all([
    hub.open("old", undefined),
    hub.open("old", undefined),
  ]);
  expect(harness.calls.filter((call) => call === "load old").length).toBe(1);
  expect(first).toEqual(second);
  expect("state" in first && first.state.turns[0]?.status).toBe("interrupted");
  expect((await hub.list(false))[0]?.status).toBe("idle");
});

test("a prompt that cannot be sent leaves the session idle and says why", async () => {
  const { harness, hub, status, frames } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.failSend = "no model";
  expect(hub.send(info.id, { text: "go", images: [] }, "auto")).rejects.toThrow("no model");
  await Promise.resolve();
  await Promise.resolve();
  expect(status(info.id)).toBe("idle");
  expect(frames.at(-1)?.events[0]).toMatchObject({ type: "notice", level: "error" });
});

test("the harness stopping fails the turns it was running", async () => {
  const { harness, hub, status } = await setup();
  const info = await hub.create({ cwd: "/project" });
  harness.emit(start(info.id, "t1"));
  harness.emit({ type: "harness.exited", message: "codex app-server exited" });
  expect(status(info.id)).toBe("error");
  const state = await hub.open(info.id, undefined);
  expect("state" in state && state.state.turns[0]?.error).toContain("codex app-server exited");
});

test("the owner's settings for a session outlast the harness's, and a busy one is not archived", async () => {
  const { harness, hub, meta } = await setup();
  const info = await hub.create({ cwd: "/project" });
  const updated = await hub.update({
    sessionId: info.id,
    title: " Mine ",
    pinned: true,
    mode: "readOnly",
  });
  expect(updated).toMatchObject({ title: "Mine", pinned: true, mode: "readOnly" });
  expect(harness.calls).toContain(`rename ${info.id} Mine`);
  harness.emit({ type: "session.changed", sessionId: info.id, patch: { title: "The agent's" } });
  expect(hub.info(info.id).title).toBe("Mine");
  expect(meta.value.sessions[info.id]).toMatchObject({ title: "Mine", pinned: true });
  harness.emit(start(info.id, "t1"));
  expect(hub.update({ sessionId: info.id, archived: true })).rejects.toThrow("Stop the session");
});

test("a worktree session starts in its own checkout and remembers its base", async () => {
  const { harness, hub } = await setup();
  harness.execResults = {
    "rev-parse --show-toplevel": { exitCode: 0, stdout: "/repo\n" },
    "rev-parse --verify HEAD^{commit}": { exitCode: 0, stdout: "abc123\n" },
    "for-each-ref --format=%(refname) --sort=-committerdate refs/heads refs/remotes": {
      exitCode: 0,
      stdout: "refs/heads/main\nrefs/heads/feature\n",
    },
  };
  const info = await hub.create({ cwd: "/repo/packages/app", worktree: { branch: "feature" } });
  expect(info.worktree).toEqual({ repo: "/repo", base: "abc123", branch: "feature-2" });
  expect(info.cwd).toBe("/home/worktrees/repo/feature-2/packages/app");
  expect(harness.calls).toContain(
    "git worktree add --no-track -b feature-2 /home/worktrees/repo/feature-2 abc123",
  );
});

const model = (id: string, provider: { id: string; name: string } | null) => ({
  id,
  name: id,
  description: "",
  efforts: [],
  defaultEffort: null,
  isDefault: false,
  images: false,
  provider,
});

test("a session stays with the kind of model it began on", async () => {
  const { harness, hub } = await setup();
  const mine = { id: "mine", name: "Mine" };
  harness.models = [model("model-a", null), model("model-b", null), model("mine/x", mine)];
  const info = await hub.create({ cwd: "/project" });
  expect((await hub.update({ sessionId: info.id, model: "model-b" })).model).toBe("model-b");
  expect(hub.update({ sessionId: info.id, model: "mine/x" })).rejects.toThrow(
    "Start a new session",
  );
  // A model nobody lists any more is the harness's to refuse, not the daemon's to guess at.
  expect((await hub.update({ sessionId: info.id, model: "gone" })).model).toBe("gone");
});

test("a review starts a turn of its own, and waits for no turn nor makes one wait", async () => {
  const { harness, hub, status } = await setup();
  const info = await hub.create({ cwd: "/project" });
  await hub.review(info.id, { kind: "uncommitted" });
  expect(harness.calls).toContain(`review ${info.id} uncommitted`);
  expect(status(info.id)).toBe("running");
  harness.emit(start(info.id, "review-turn"));
  expect(hub.review(info.id, { kind: "uncommitted" })).rejects.toThrow("before a review");
  harness.emit(end(info.id, "review-turn"));
  expect(status(info.id)).toBe("idle");
});

test("going back drops a turn and the ones after it, and never while one runs", async () => {
  const { harness, hub } = await setup();
  const info = await hub.create({ cwd: "/project" });
  for (const turnId of ["t1", "t2"]) {
    await hub.send(info.id, { text: turnId, images: [] }, "auto");
    harness.emit(start(info.id, turnId));
    harness.emit(end(info.id, turnId));
  }
  await hub.send(info.id, { text: "t3", images: [] }, "auto");
  harness.emit(start(info.id, "t3"));
  expect(hub.rewind(info.id, "t2")).rejects.toThrow("Stop the turn");
  harness.emit(end(info.id, "t3"));
  expect(hub.rewind(info.id, "elsewhere")).rejects.toThrow("not in this conversation");
  await hub.rewind(info.id, "t2");
  expect(harness.calls).toContain(`rewind ${info.id} t2`);
  const state = await hub.open(info.id, undefined);
  expect("state" in state && state.state.turns.map((turn) => turn.id)).toEqual(["t1"]);
});
