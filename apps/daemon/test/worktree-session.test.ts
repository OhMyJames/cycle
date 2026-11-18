import { expect, test } from "bun:test";
import { setup, worktreeAt } from "./worktree-hub.ts";

test("a worktree session starts in the worktree's folder, inside the project's subfolder", async () => {
  const { hub, meta } = await setup();
  const info = await hub.create({ cwd: "/repo/packages/app", worktree: { branch: "feature" } });
  expect(info.cwd).toMatch(/\/feature-2\/packages\/app$/);
  expect(info.worktree).toMatchObject({ repo: "/repo", base: "abc123", branch: "feature-2" });
  expect(info.branch).toBe("feature-2");
  expect(meta.value.sessions[info.id]?.worktree).toEqual(info.worktree ?? undefined);
});

test("an agent that cannot start leaves no worktree: its folder is removed, its branch kept", async () => {
  const { harness, hub, removals } = await setup();
  harness.createSession = async () => {
    throw new Error("no agent");
  };
  await expect(hub.create(worktreeAt)).rejects.toThrow("no agent");
  const added = harness.calls.find((call) => call.startsWith("git worktree add"));
  const folder = added?.split(" ").at(-2);
  expect(removals()).toEqual([`git worktree remove --force ${folder}`]);
  expect(harness.calls.some((call) => call.startsWith("git branch"))).toBe(false);
});

test("deleting a session removes its worktree's folder when asked, and never its branch", async () => {
  const { harness, hub, removals } = await setup();
  const info = await hub.create(worktreeAt);
  await hub.remove(info.id, true);
  expect(removals()).toEqual([`git worktree remove --force ${info.cwd}`]);
  expect(harness.calls.some((call) => call.startsWith("git branch"))).toBe(false);
  const kept = await hub.create(worktreeAt);
  await hub.remove(kept.id, false);
  expect(removals()).toHaveLength(1);
});

test("a fork keeps its source's worktree, and its record says so", async () => {
  const { hub, meta } = await setup();
  const source = await hub.create(worktreeAt);
  const fork = await hub.fork(source.id, null);
  expect(fork.worktree).toEqual(source.worktree);
  expect(meta.value.sessions[fork.id]?.worktree).toEqual(source.worktree ?? undefined);
});

test("a worktree an older daemon recorded still shows on the session, with its branch", async () => {
  const folder = "/home/worktrees/repo/feat";
  const worktree = { repo: "/repo", base: "abc123", branch: "feat" };
  const { harness, hub } = await setup({ sessions: { old: { worktree } } });
  harness.stored = [harness.session("old", { cwd: `${folder}/sub`, branch: "other" })];
  const [info] = await hub.list(false);
  expect(info?.worktree).toMatchObject(worktree);
  expect(info?.branch).toBe("feat");
  expect(info?.cwd).toBe(`${folder}/sub`);
});

test("a worktree without a path or an origin is read as the owner's, at the root its folder shows", async () => {
  const worktree = { repo: "/repo", base: "abc123", branch: "feat" };
  const { harness, hub, removals } = await setup({ sessions: { old: { worktree } } });
  harness.stored = [harness.session("old", { cwd: "/home/worktrees/repo/feat/sub" })];
  const [info] = await hub.list(false);
  expect(info?.worktree).toEqual({
    ...worktree,
    path: "/home/worktrees/repo/feat",
    origin: "owner",
  });
  await hub.remove("old", true);
  expect(removals()).toEqual(["git worktree remove --force /home/worktrees/repo/feat"]);
});

test("a worktree with no path, outside the older place, is rooted at the session's folder", async () => {
  const worktree = { repo: "/repo", base: "abc123", branch: "feat" };
  const { harness, hub } = await setup({ sessions: { odd: { worktree } } });
  harness.stored = [harness.session("odd", { cwd: "/elsewhere/feat" })];
  const [info] = await hub.list(false);
  expect(info?.worktree).toMatchObject({ path: "/elsewhere/feat", origin: "owner" });
});

test("a stored path and origin are kept, and a new worktree stores both", async () => {
  const stored = {
    repo: "/repo",
    base: "b",
    branch: "x",
    path: "/repo/.agents/worktree/x",
    origin: "agent",
  } as const;
  const { harness, hub, meta } = await setup({ sessions: { kept: { worktree: stored } } });
  harness.stored = [harness.session("kept", { cwd: "/repo/.agents/worktree/x" })];
  const [info] = await hub.list(false);
  expect(info?.worktree).toEqual(stored);
  const made = await hub.create(worktreeAt);
  expect(made.worktree).toMatchObject({ origin: "owner" });
  expect(meta.value.sessions[made.id]?.worktree).toEqual({
    repo: "/repo",
    base: "abc123",
    branch: "feature-2",
    path: made.cwd,
    origin: "owner",
  });
});
