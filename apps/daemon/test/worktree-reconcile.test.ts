import { expect, test } from "bun:test";
import { settle } from "./held-git.ts";
import { folderOf, setup, where } from "./worktree-enter-hub.ts";

// Where the agent says it works, against the worktree Cycle made for it: the record follows Claude
// Code's own memory, which a restart, a fork or an exit changes without asking Cycle.

const resolves = (key: string) => key.includes("pwd -P");

async function entered(options: Parameters<typeof setup>[0] = {}, cwd = "/repo") {
  const rig = await setup(options);
  const session = await rig.hub.create({ cwd });
  await rig.hub.enterWorktree(session.id, { name: "x", helper: false });
  rig.told.length = 0;
  return { ...rig, id: session.id };
}

test("the agent in its worktree, or a folder inside it, changes nothing and asks the machine nothing", async () => {
  const { hub, harness, meta, runs, id } = await entered();
  const kept = structuredClone(meta.value.sessions[id]);
  harness.emit(where(id, folderOf("x")));
  harness.emit(where(id, `${folderOf("x")}/pkg/deep`));
  await settle();
  expect(hub.info(id).worktree?.path).toBe(folderOf("x"));
  expect(meta.value.sessions[id]).toEqual(kept);
  expect(runs.some((run) => resolves(run.key))).toBe(false);
  // Not a folder that only begins with the same letters: that is somewhere else.
  harness.emit(where(id, `${folderOf("x")}-2`));
  await settle();
  expect(runs.some((run) => resolves(run.key))).toBe(true);
  expect(hub.info(id).worktree?.path).toBe(folderOf("x"));
});

test("the agent back in the project's own folder, or one inside it, clears the record and keeps the folder", async () => {
  for (const back of ["/repo", "/repo/pkg"]) {
    const { hub, harness, meta, id, removals } = await entered();
    harness.emit(where(id, back));
    await settle();
    expect(hub.info(id)).toMatchObject({ worktree: null, branch: null, cwd: "/repo" });
    expect(meta.value.sessions[id]?.worktree).toBeUndefined();
    expect(removals()).toEqual([]);
  }
});

test("a worktree under the project is not 'back': another of Cycle's, and Claude Code's own, keep the record and say so once", async () => {
  const { hub, harness, meta, id, notices } = await entered();
  for (const at of ["/repo/.agents/worktree/other", "/repo/.claude/worktrees/z"]) {
    harness.emit(where(id, at));
    harness.emit(where(id, at));
    await settle();
    expect(hub.info(id).worktree?.path).toBe(folderOf("x"));
    expect(meta.value.sessions[id]?.worktree?.origin).toBe("agent");
  }
  const said = (await notices(id)).filter((notice) => notice.level === "warning");
  expect(said.map((notice) => notice.message)).toEqual([
    expect.stringContaining(
      "works in /repo/.agents/worktree/other, not in the worktree Cycle made",
    ),
    expect.stringContaining("works in /repo/.claude/worktrees/z, not in the worktree Cycle made"),
  ]);
  expect(said[0]?.message).toContain("A WorktreeCreate hook of your own may have made another");
});

test("an agent in a folder that is neither the project nor a worktree says another hook answered", async () => {
  const { harness, id, notices } = await entered();
  harness.emit(where(id, "/elsewhere/owner-made"));
  await settle();
  expect((await notices(id)).at(-1)).toMatchObject({
    level: "warning",
    message: expect.stringContaining("/elsewhere/owner-made"),
  });
});

test("the agent says its real path, and the session's folder may be a link to it", async () => {
  const { hub, harness, meta, id, runs } = await entered({
    real: { "/real/repo": "/real/repo", "/repo": "/real/repo" },
  });
  harness.emit(where(id, "/real/repo"));
  await settle();
  expect(runs.some((run) => resolves(run.key))).toBe(true);
  expect(hub.info(id).worktree).toBeNull();
  expect(meta.value.sessions[id]?.worktree).toBeUndefined();
});

test("the worktree's own folder through a link is still the worktree, and says nothing", async () => {
  const { hub, harness, id, notices } = await entered({
    real: { [`/link/x/sub`]: `${folderOf("x")}/sub`, "/repo": "/repo" },
  });
  harness.emit(where(id, "/link/x/sub"));
  await settle();
  expect(hub.info(id).worktree?.path).toBe(folderOf("x"));
  expect((await notices(id)).filter((notice) => notice.level === "warning")).toEqual([]);
});

test("a fork begins in the project: its inherited record clears, and the source's stays", async () => {
  const { hub, harness, meta, id } = await entered();
  harness.forkSession = async (sessionId) => harness.session(`${sessionId}-fork`, { cwd: "/repo" });
  const fork = await hub.fork(id, null);
  expect(fork.worktree?.origin).toBe("agent");
  harness.emit(where(fork.id, "/repo"));
  await settle();
  expect(hub.info(fork.id).worktree).toBeNull();
  expect(meta.value.sessions[fork.id]?.worktree).toBeUndefined();
  expect(hub.info(id).worktree?.path).toBe(folderOf("x"));
  expect(meta.value.sessions[id]?.worktree?.origin).toBe("agent");
});

test("a report that was waiting for the machine is dropped when the agent entered or left since", async () => {
  const { hub, harness, meta, holds, id } = await entered({ hold: "resolve" });
  harness.emit(where(id, "/repo"));
  await settle();
  // While the paths are resolved, the agent leaves through its own call, and enters another.
  await hub.leaveWorktree(id, { path: folderOf("x"), helper: false });
  expect(hub.info(id).worktree).toBeNull();
  await hub.enterWorktree(id, { name: "y", helper: false });
  holds.resolves.shift()?.();
  await settle();
  expect(hub.info(id).worktree?.path).toBe(folderOf("y"));
  expect(meta.value.sessions[id]?.worktree?.path).toBe(folderOf("y"));
});

test("an owner's worktree and a session with none are not touched by where the agent says it is", async () => {
  const { hub, harness, meta, notices } = await setup();
  const owned = await hub.create({ cwd: "/repo", worktree: { branch: "mine" } });
  const plain = await hub.create({ cwd: "/repo" });
  const kept = structuredClone(meta.value.sessions);
  for (const at of ["/repo", "/repo/.claude/worktrees/z", "/elsewhere"]) {
    harness.emit(where(owned.id, at));
    harness.emit(where(plain.id, at));
  }
  await settle();
  expect(meta.value.sessions).toEqual(kept);
  expect(hub.info(owned.id).worktree?.origin).toBe("owner");
  expect(hub.info(plain.id).worktree).toBeNull();
  // Nor is either told of a worktree it never had.
  expect(await notices(owned.id)).toEqual([]);
  expect(await notices(plain.id)).toEqual([]);
});

test("an agent named its own worktree like a helper's: when it turns out to work there, it is the session's", async () => {
  const { hub, harness, meta, told } = await setup();
  const session = await hub.create({ cwd: "/repo" });
  const path = (await hub.enterWorktree(session.id, { name: "agent-0123456789ab", helper: true }))
    .path;
  expect(hub.info(session.id).worktree).toBeNull();
  // A helper's own place is not the session's: another folder says nothing.
  harness.emit(where(session.id, "/repo"));
  await settle();
  expect(hub.info(session.id).worktree).toBeNull();
  told.length = 0;
  harness.emit(where(session.id, `${path}/pkg`));
  await settle();
  const record = { repo: "/repo", branch: "cycle/agent-0123456789ab", path, origin: "agent" };
  expect(hub.info(session.id).worktree).toMatchObject(record);
  expect(meta.value.sessions[session.id]?.worktree).toMatchObject(record);
  expect(told.at(-1)?.worktree).toMatchObject(record);
});

test("a session running in the folder its agent works in keeps it busy, and its project it does not", async () => {
  const { hub, harness, id } = await entered();
  harness.emit({ type: "turn.started", sessionId: id, turnId: "t1", startedAt: null });
  expect(hub.busyIn(folderOf("x"))).toBe(true);
  expect(hub.busyIn("/repo")).toBe(false);
  expect(hub.busyIn(`${folderOf("x")}/pkg`)).toBe(false);
});
