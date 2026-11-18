import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import { setup, worktreeAt } from "./worktree-hub.ts";

const start = (sessionId: string, turnId = "t1"): HarnessEvent => ({
  type: "turn.started",
  sessionId,
  turnId,
  startedAt: null,
});
const ask = (sessionId: string): HarnessEvent => ({
  type: "approval.requested",
  sessionId,
  turnId: "t1",
  approval: { id: "a1", kind: "command", itemId: "i", command: "ls", cwd: null, reason: null },
});
const prompt = { text: "go", images: [] };

test("a running or waiting session is not deleted, nor its worktree removed", async () => {
  const { harness, hub, removals } = await setup();
  const info = await hub.create(worktreeAt);
  await hub.send(info.id, prompt, "auto");
  harness.emit(start(info.id));
  await expect(hub.remove(info.id, true)).rejects.toThrow("Stop the session before deleting it.");
  harness.emit(ask(info.id));
  await expect(hub.remove(info.id, true)).rejects.toThrow("Stop the session before deleting it.");
  expect(harness.calls.some((call) => call.startsWith("delete"))).toBe(false);
  expect(removals()).toEqual([]);
});

test("archiving a worktree session removes nothing, and its record keeps the worktree", async () => {
  const { harness, hub, meta, removals } = await setup();
  const info = await hub.create(worktreeAt);
  await hub.update({ sessionId: info.id, archived: true });
  expect(removals()).toEqual([]);
  expect(harness.calls.some((call) => call.startsWith("git branch"))).toBe(false);
  expect(meta.value.sessions[info.id]?.worktree).toEqual(info.worktree ?? undefined);
});

test("the only session of a worktree, deleted with the box, removes its folder once with --force", async () => {
  const { harness, hub, removals } = await setup();
  const info = await hub.create(worktreeAt);
  await hub.remove(info.id, true);
  expect(removals()).toEqual([`git worktree remove --force ${info.worktree?.path}`]);
  expect(harness.calls.some((call) => call.startsWith("git branch"))).toBe(false);
});
