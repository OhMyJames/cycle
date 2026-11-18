import { expect, test } from "bun:test";
import { heldGit, settle } from "./held-git.ts";

/** Makes the worktrees one after the other, each one let go as soon as it is held. */
async function make(git: ReturnType<typeof heldGit>, ...branches: string[]) {
  const out = [];
  for (const branch of branches) {
    const made = git.git.addWorktree({ cwd: "/repo", branch });
    await settle();
    git.releases.at(-1)?.();
    out.push(await made);
  }
  return out;
}

test("branches a/b and a-b get folders a-b and a-b-2, since both are made safe alike", async () => {
  const held = heldGit();
  const made = await make(held, "a/b", "a-b");
  expect(made.map((each) => each.worktree.path)).toEqual([
    "/repo/.agents/worktree/a-b",
    "/repo/.agents/worktree/a-b-2",
  ]);
  expect(made.map((each) => each.worktree.branch)).toEqual(["a/b", "a-b"]);
});

test("a path that exists is skipped, whoever made it", async () => {
  const held = heldGit({
    existing: new Set(["/repo/.agents/worktree/x", "/repo/.agents/worktree/x-2"]),
  });
  const [made] = await make(held, "x");
  expect(made?.worktree.path).toBe("/repo/.agents/worktree/x-3");
});

test("the folder is made to ignore itself before the first worktree, and never over a file", async () => {
  const held = heldGit();
  await make(held, "x");
  const keys = held.runs.map((run) => run.key);
  const ignore = keys.findIndex((key) => key.startsWith("sh -c "));
  expect(ignore).toBeGreaterThan(-1);
  expect(ignore).toBeLessThan(keys.findIndex((key) => key.startsWith("worktree add")));
  const command = keys[ignore] ?? "";
  expect(command).toEndWith(" sh /repo/.agents/worktree");
  expect(command).toContain('[ -e "$f" ] || [ -L "$f" ] || printf "*\\n" > "$f"');
  expect(held.runs[ignore]?.cwd).toBe("/repo");
});

test("a worktree made from inside another goes to the main checkout, and starts in the same subfolder", async () => {
  const linked = "/repo/.agents/worktree/one";
  const held = heldGit({ roots: { [`${linked}/sub`]: linked } });
  const made = held.git.addWorktree({ cwd: `${linked}/sub`, branch: "two" });
  await settle();
  held.releases[0]?.();
  const { cwd, worktree } = await made;
  expect(worktree).toMatchObject({ repo: "/repo", path: "/repo/.agents/worktree/two" });
  expect(cwd).toBe("/repo/.agents/worktree/two/sub");
  expect(held.runs.find((run) => run.key.startsWith("worktree add"))?.cwd).toBe(linked);
});

test("a subfolder of the repository starts in the same subfolder of the worktree", async () => {
  const held = heldGit({ roots: { "/repo/packages/app": "/repo" } });
  const made = held.git.addWorktree({ cwd: "/repo/packages/app", branch: "x" });
  await settle();
  held.releases[0]?.();
  expect((await made).cwd).toBe("/repo/.agents/worktree/x/packages/app");
});

test("removing an old worktree takes the lock of the main checkout its repo belongs to", async () => {
  const held = heldGit({ commons: { "/repo/.agents/worktree/one": "/repo/.git" } });
  const adding = held.git.addWorktree({ cwd: "/repo", branch: "two" });
  await settle();
  const removing = held.git.removeWorktree("/repo/.agents/worktree/one", "/old/f");
  await settle();
  expect(held.runs.some((run) => run.key.startsWith("worktree remove"))).toBe(false);
  held.releases[0]?.();
  await adding;
  await removing;
  expect(held.runs.some((run) => run.key.startsWith("worktree remove"))).toBe(true);
});
