import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import { setup, worktreeAt } from "./worktree-hub.ts";

const FOLDER = "/repo/.agents/worktree/feature-2";
const stored = { repo: "/repo", base: "abc123", branch: "feature-2", path: FOLDER } as const;
const started = (sessionId: string): HarnessEvent => ({
  type: "turn.started",
  sessionId,
  turnId: "t1",
  startedAt: null,
});
const ended = (sessionId: string): HarnessEvent => ({
  type: "turn.completed",
  sessionId,
  turnId: "t1",
  status: "completed",
  error: null,
  durationMs: 1,
});
const prompt = { text: "go", images: [] };
const uses = (name: string) =>
  `Another session uses this worktree: "${name}". Delete without removing the worktree, or delete that one first.`;
const working = (name: string) =>
  `A session is working in this worktree: "${name}". Stop it first, or delete without removing the worktree.`;

test("a worktree a fork shares is not removed with either, until the last one goes", async () => {
  const { harness, hub, meta, removals, gone } = await setup();
  const source = await hub.create(worktreeAt);
  const fork = await hub.fork(source.id, null);
  await expect(hub.remove(source.id, true)).rejects.toThrow(uses(fork.id));
  expect(hub.info(source.id).id).toBe(source.id);
  expect(meta.value.sessions[source.id]?.worktree).toBeDefined();
  expect(hub.info(fork.id).id).toBe(fork.id);
  expect(harness.calls.some((call) => call.startsWith("delete"))).toBe(false);
  expect(removals()).toEqual([]);
  expect(gone).toEqual([]);

  await hub.remove(source.id, false);
  expect(removals()).toEqual([]);
  await hub.remove(fork.id, true);
  expect(removals()).toEqual([`git worktree remove --force ${FOLDER}`]);
});

test("a session is named by its title, else the start of its first prompt, else its id", async () => {
  const { harness, hub } = await setup();
  const source = await hub.create(worktreeAt);
  const fork = await hub.fork(source.id, null);
  await hub.update({ sessionId: fork.id, title: "Fix the build" });
  await expect(hub.remove(source.id, true)).rejects.toThrow(uses("Fix the build"));
  await hub.update({ sessionId: fork.id, title: "" });
  harness.stored = [harness.session(fork.id, { preview: "Please look at the failing test" })];
  await hub.list(false);
  await expect(hub.remove(source.id, true)).rejects.toThrow(
    uses("Please look at the failing test"),
  );
});

test("a sharer that is running is the first reason, and the folder stays", async () => {
  const { harness, hub, removals } = await setup();
  const source = await hub.create(worktreeAt);
  const fork = await hub.fork(source.id, null);
  await hub.send(fork.id, prompt, "auto");
  harness.emit(started(fork.id));
  await expect(hub.remove(source.id, true)).rejects.toThrow(working(fork.id));
  expect(removals()).toEqual([]);
  // Without the box it is only a conversation that goes.
  await hub.remove(source.id, false);
  harness.emit(ended(fork.id));
  await hub.remove(fork.id, true);
  expect(removals()).toEqual([`git worktree remove --force ${FOLDER}`]);
});

test("an archived sharer blocks removal, listed or not", async () => {
  const { harness, hub, removals } = await setup({ sessions: { kept: { worktree: stored } } });
  const source = await hub.create(worktreeAt);
  await expect(hub.remove(source.id, true)).rejects.toThrow(uses("kept"));
  harness.stored = [harness.session("kept", { cwd: "/project", title: "Old work" })];
  await hub.list(true);
  await expect(hub.remove(source.id, true)).rejects.toThrow(uses("Old work"));
  expect(removals()).toEqual([]);
});

test("a session in the folder with no record blocks only while it runs, and a sibling never does", async () => {
  const { harness, hub, removals } = await setup();
  const info = await hub.create(worktreeAt);
  harness.stored = [
    harness.session("inside", { cwd: `${FOLDER}/pkg`, title: "Direct" }),
    harness.session("beside", { cwd: `${FOLDER}-22` }),
  ];
  await hub.list(false);
  // Loaded, a session says the folder it was listed in.
  harness.loadSession = async (id: string) => ({
    session: harness.stored.find((session) => session.id === id) ?? harness.session(id),
    turns: [],
    usage: null,
  });
  await hub.send("inside", prompt, "auto");
  await hub.send("beside", prompt, "auto");
  harness.emit(started("inside"));
  harness.emit(started("beside"));
  await expect(hub.remove(info.id, true)).rejects.toThrow(working("Direct"));
  expect(removals()).toEqual([]);

  harness.emit(ended("inside"));
  await hub.remove(info.id, true);
  expect(removals()).toEqual([`git worktree remove --force ${FOLDER}`]);
});

test("a record from an older daemon, once its folder places it, blocks like any other", async () => {
  const old = { repo: "/repo", base: "abc123", branch: "feat" };
  const { harness, hub, removals } = await setup({
    sessions: {
      old: { worktree: old },
      mine: { worktree: { ...old, path: "/home/worktrees/repo/feat", origin: "owner" } },
    },
  });
  harness.stored = [
    harness.session("old", { cwd: "/home/worktrees/repo/feat" }),
    harness.session("mine", { cwd: "/home/worktrees/repo/feat" }),
  ];
  await hub.list(false);
  await expect(hub.remove("mine", true)).rejects.toThrow(uses("old"));
  expect(removals()).toEqual([]);
});

test("a worktree that cannot be removed after its session is deleted leaves no ghost", async () => {
  const { harness, hub, meta, gone } = await setup();
  const info = await hub.create(worktreeAt);
  harness.execResults[`worktree remove --force ${FOLDER}`] = {
    exitCode: 128,
    stdout: "",
    stderr: "fatal: it is locked\n",
  };
  await expect(hub.remove(info.id, true)).rejects.toThrow(
    "The session is deleted, but its worktree could not be removed: fatal: it is locked",
  );
  expect(harness.calls).toContain(`delete ${info.id}`);
  expect(meta.value.sessions[info.id]).toBeUndefined();
  expect(gone).toEqual([info.id]);
  expect(() => hub.info(info.id)).toThrow("unknown session");
  expect((await hub.list(false)).map((session) => session.id)).toEqual([]);
});

test("two sharers deleted together with the box never leave a removed folder and a survivor", async () => {
  const { hub, meta, removals } = await setup();
  const source = await hub.create(worktreeAt);
  const fork = await hub.fork(source.id, null);
  await Promise.allSettled([hub.remove(source.id, true), hub.remove(fork.id, true)]);
  const survivors = Object.values(meta.value.sessions).filter((s) => s.worktree?.path === FOLDER);
  expect(removals().length === 0 || survivors.length === 0).toBe(true);
});
