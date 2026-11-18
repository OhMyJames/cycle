import { expect, test } from "bun:test";
import { folderOf, setup } from "./worktree-enter-hub.ts";

// Claude Code's agent asked to remove a worktree. It is told "removed" whatever Cycle answers, so
// the owner is told what is true: nothing was removed.

const NOTICE =
  "Claude Code asked to remove the worktree cycle/x. Cycle keeps it until you remove it.";

async function entered() {
  const rig = await setup();
  const session = await rig.hub.create({ cwd: "/repo" });
  await rig.hub.enterWorktree(session.id, { name: "x", helper: false });
  return { ...rig, id: session.id };
}

test("leaving removes no folder and no branch, says so to the owner, and the session's record goes", async () => {
  const { hub, harness, meta, removals, notices, id } = await entered();
  await hub.leaveWorktree(id, { path: folderOf("x"), helper: false });
  expect(removals()).toEqual([]);
  expect(harness.calls.some((call) => call.startsWith("git branch"))).toBe(false);
  expect((await notices(id)).at(-1)).toEqual({ level: "info", message: NOTICE });
  expect(hub.info(id)).toMatchObject({ worktree: null, branch: null });
  expect(meta.value.sessions[id]?.worktree).toBeUndefined();
});

test("a helper's call, and a path that is not the session's worktree, leave the record alone", async () => {
  const { hub, meta, removals, notices, id } = await entered();
  const record = structuredClone(meta.value.sessions[id]?.worktree);
  await hub.leaveWorktree(id, { path: folderOf("x"), helper: true });
  await hub.leaveWorktree(id, { path: "/repo/.agents/worktree/other", helper: false });
  expect(meta.value.sessions[id]?.worktree).toEqual(record);
  expect(hub.info(id).worktree?.path).toBe(folderOf("x"));
  expect(removals()).toEqual([]);
  // Each says what was asked, by the folder's name when the record is not of that one.
  expect((await notices(id)).map((notice) => notice.message)).toEqual([
    NOTICE,
    "Claude Code asked to remove the worktree other. Cycle keeps it until you remove it.",
  ]);
});

test("a worktree the owner made is never taken off its session by the agent's asking", async () => {
  const { hub, meta, removals, id } = await setup().then(async (rig) => {
    const session = await rig.hub.create({ cwd: "/repo", worktree: { branch: "mine" } });
    return { ...rig, id: session.id };
  });
  const path = hub.info(id).worktree?.path ?? "";
  await hub.leaveWorktree(id, { path, helper: false });
  expect(hub.info(id).worktree?.origin).toBe("owner");
  expect(meta.value.sessions[id]?.worktree?.path).toBe(path);
  expect(removals()).toEqual([]);
});

test("a session nobody knows is told nothing and nothing is removed", async () => {
  const { hub, removals } = await setup();
  await hub.leaveWorktree("nobody", { path: folderOf("x"), helper: false });
  expect(removals()).toEqual([]);
});
