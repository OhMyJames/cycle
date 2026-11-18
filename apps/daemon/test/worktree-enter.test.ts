import { expect, test } from "bun:test";
import { settle } from "./held-git.ts";
import { folderOf, setup } from "./worktree-enter-hub.ts";

// What the hub does when Claude Code's agent asks to enter a worktree: Cycle makes it, writes its
// record at once, and refuses cleanly what it must.

const enter = (name: string, helper = false) => ({ name, helper });

test("an agent's worktree is made on cycle/<name> from HEAD, recorded as the agent's, and answered by its root", async () => {
  const { hub, meta, told, added } = await setup();
  const session = await hub.create({ cwd: "/repo" });
  told.length = 0;
  const answered = await hub.enterWorktree(session.id, enter("fix-bug"));
  expect(answered).toEqual({ path: folderOf("fix-bug") });
  expect([...added]).toEqual([
    `worktree add --no-track -b cycle/fix-bug ${folderOf("fix-bug")} abc123`,
  ]);
  const record = {
    repo: "/repo",
    base: "abc123",
    branch: "cycle/fix-bug",
    path: folderOf("fix-bug"),
    origin: "agent" as const,
  };
  // Written before the answer: the meta, the session, and what the page was told.
  expect(meta.value.sessions[session.id]?.worktree).toEqual(record);
  expect(hub.info(session.id)).toMatchObject({ worktree: record, branch: "cycle/fix-bug" });
  expect(told.at(-1)).toMatchObject({ id: session.id, worktree: record });
  // The folder the agent's record is keyed by does not move.
  expect(hub.info(session.id).cwd).toBe("/repo");
});

test("the record outlives the hub's memory of the session: a list rebuilds it from the meta", async () => {
  const { harness, hub } = await setup();
  const session = await hub.create({ cwd: "/repo" });
  await hub.enterWorktree(session.id, enter("x"));
  harness.stored = [harness.session(session.id, { cwd: "/repo", branch: "main" })];
  const [listed] = await hub.list(false);
  expect(listed).toMatchObject({
    branch: "cycle/x",
    worktree: { origin: "agent", path: folderOf("x"), branch: "cycle/x" },
  });
});

test("a session that already works in a worktree, of either origin, is refused and nothing is made", async () => {
  const { hub, added } = await setup();
  const entered = await hub.create({ cwd: "/repo" });
  await hub.enterWorktree(entered.id, enter("one"));
  await expect(hub.enterWorktree(entered.id, enter("two"))).rejects.toThrow(
    "This session already works in a worktree.",
  );
  const owned = await hub.create({ cwd: "/repo", worktree: { branch: "mine" } });
  const before = added.size;
  await expect(hub.enterWorktree(owned.id, enter("three"))).rejects.toThrow(
    "This session already works in a worktree.",
  );
  expect(added.size).toBe(before);
  expect(hub.info(entered.id).worktree?.branch).toBe("cycle/one");
});

test("two requests at once make one worktree: the second is refused while the first is made", async () => {
  const { hub, meta, holds, added } = await setup({ hold: "add" });
  const session = await hub.create({ cwd: "/repo" });
  const first = hub.enterWorktree(session.id, enter("a"));
  await settle();
  await expect(hub.enterWorktree(session.id, enter("b"))).rejects.toThrow(
    "A worktree is already being made for this session.",
  );
  holds.adds.shift()?.();
  await first;
  expect(added.size).toBe(1);
  expect(meta.value.sessions[session.id]?.worktree?.branch).toBe("cycle/a");
  // Answered: it may be asked again, and is refused for its worktree.
  await expect(hub.enterWorktree(session.id, enter("c"))).rejects.toThrow("already works");
});

test("a request that fails leaves the session free to ask again", async () => {
  const { hub } = await setup({ world: { bare: new Set(["/repo"]) } });
  const session = await hub.create({ cwd: "/repo" });
  await expect(hub.enterWorktree(session.id, enter("a"))).rejects.toThrow(
    "A worktree needs a git checkout.",
  );
  await expect(hub.enterWorktree(session.id, enter("a"))).rejects.toThrow(
    "A worktree needs a git checkout.",
  );
});

test("a session nobody knows, one in a sandbox, and an agent that does not declare it are refused before git is asked", async () => {
  const { harness, hub, runs } = await setup({
    stored: { sessions: { boxed: { sandbox: "box" } } },
  });
  await expect(hub.enterWorktree("nobody", enter("x"))).rejects.toThrow("does not know");
  harness.stored = [harness.session("boxed")];
  await hub.list(false);
  await expect(hub.enterWorktree("boxed", enter("x"))).rejects.toThrow(
    "A session in a sandbox works in the folder itself, not a worktree.",
  );
  const session = await hub.create({ cwd: "/repo" });
  harness.declaration = { ...harness.declaration, operations: [] };
  await expect(hub.enterWorktree(session.id, enter("x"))).rejects.toThrow(
    "does not enter worktrees through Cycle",
  );
  expect(runs).toEqual([]);
});

const hostile = [
  "",
  "..",
  "../x",
  "a/../b",
  "a..b",
  "-x",
  "--force",
  ".x",
  "a/.b",
  "x.lock",
  "a/x.lock/b",
  "a.",
  "a//b",
  "a/",
  "/a",
  "é",
  "a b",
  "a\nb",
  "a\0b",
  "a~1",
  "a:b",
  "a@{u}",
  "x".repeat(65),
];

test("a hostile name is refused with a reason, before git or a folder is touched", async () => {
  const { hub, meta, runs } = await setup();
  const session = await hub.create({ cwd: "/repo" });
  for (const name of hostile) {
    const refused = await hub.enterWorktree(session.id, enter(name)).then(
      () => null,
      (error: Error) => error.message,
    );
    expect({ name, refused: refused?.endsWith(".") }).toEqual({ name, refused: true });
  }
  expect(runs).toEqual([]);
  expect(meta.value.sessions[session.id]?.worktree).toBeUndefined();
});

test("a name that is awkward but safe is made, as a branch under cycle/ and a folder of its own", async () => {
  const { hub, added } = await setup();
  const session = await hub.create({ cwd: "/repo" });
  const other = await hub.create({ cwd: "/repo" });
  await hub.enterWorktree(session.id, enter("feature/v1.2_x"));
  await hub.enterWorktree(other.id, enter("x".repeat(64)));
  expect([...added].map((key) => key.split(" ").slice(4, 6))).toEqual([
    ["cycle/feature/v1.2_x", "/repo/.agents/worktree/cycle-feature-v1.2_x"],
    [`cycle/${"x".repeat(64)}`, `/repo/.agents/worktree/cycle-${"x".repeat(64)}`],
  ]);
});

test("a helper's worktree is made and recorded nowhere, and asks nothing of the session's own", async () => {
  const { hub, meta, told } = await setup();
  const session = await hub.create({ cwd: "/repo", worktree: { branch: "mine" } });
  const before = { info: hub.info(session.id), meta: meta.value.sessions[session.id] };
  told.length = 0;
  const answered = await hub.enterWorktree(session.id, enter("agent-0123456789ab", true));
  expect(answered.path).toBe("/repo/.agents/worktree/cycle-agent-0123456789ab");
  expect(hub.info(session.id)).toEqual(before.info);
  expect(meta.value.sessions[session.id]).toEqual(before.meta);
  expect(told).toEqual([]);
  // Nor is a helper held to the one-worktree rule: its own is its own.
  await hub.enterWorktree(session.id, enter("agent-0123456789ab", true));
});

test("a session deleted while its worktree is made leaves no worktree: Cycle removes the one it just made", async () => {
  const { hub, holds, gone, removals } = await setup({
    hold: "add",
    world: { roots: { [folderOf("late")]: folderOf("late") } },
  });
  const session = await hub.create({ cwd: "/repo" });
  const asked = hub.enterWorktree(session.id, enter("late"));
  const outcome = asked.then(
    () => "made",
    (error: Error) => error.message,
  );
  await settle();
  await hub.remove(session.id, false);
  holds.adds.shift()?.();
  expect(await outcome).toBe("The session was deleted.");
  expect(gone).toEqual([session.id]);
  expect(removals().map((run) => run.key)).toEqual([`worktree remove --force ${folderOf("late")}`]);
});
