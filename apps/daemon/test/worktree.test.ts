import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkName,
  createWorktree,
  findWorktree,
  listBranches,
  listWorktrees,
  mainCheckout,
  removeWorktree,
  unsavedIn,
  WorktreeError,
} from "../src/worktree.ts";

let root: string;
const run = async (dir: string, ...args: string[]) => {
  const child = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const [out, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out;
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cycle-worktree-")));
  await run(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "a.txt"), "a");
  await run(root, "add", ".");
  await run(root, "commit", "-q", "-m", "first");
  await run(root, "branch", "topic");
});
afterAll(() => rm(root, { recursive: true, force: true }));

test("names follow Claude's rules", () => {
  expect(checkName("fix/login-1.2_x")).toBe("fix/login-1.2_x");
  for (const bad of ["", "a b", "/a", "a//b", "a/../b", "..", "x".repeat(65), "a\\b"])
    expect(() => checkName(bad)).toThrow(WorktreeError);
});

test("branches are the local ones, and which is checked out", async () => {
  const found = await listBranches(root);
  expect(found.branches.sort()).toEqual(["main", "topic"]);
  expect(found.current).toBe("main");
  expect(found.defaultBranch).toBeUndefined();
});

test("a worktree is made under .agents/worktree on branch worktree-<name>, from the chosen base", async () => {
  const made = await createWorktree(root, { name: "one", base: "topic" });
  expect(made).toMatchObject({
    created: true,
    root,
    path: join(root, ".agents", "worktree", "one"),
    branch: "worktree-one",
  });
  expect(await mainCheckout(made.path)).toBe(root);
  expect((await listWorktrees(root)).map((tree) => tree.path)).toContain(made.path);
  // The same name again is the same worktree, not made twice.
  expect(await createWorktree(made.path, { name: "one" })).toMatchObject({
    created: false,
    path: made.path,
  });
});

test("a base that is not there is refused", async () => {
  await expect(createWorktree(root, { name: "two", base: "nope" })).rejects.toMatchObject({
    reason: "invalid_base",
  });
});

test("outside a repository there is no worktree", async () => {
  const bare = await mkdtemp(join(tmpdir(), "cycle-not-git-"));
  try {
    await expect(createWorktree(bare)).rejects.toMatchObject({ reason: "not_a_repository" });
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test("removal sees files and commits that would be lost, and takes the branch with it", async () => {
  const made = await createWorktree(root, { name: "three" });
  expect(await unsavedIn(made)).toEqual({ files: [], commits: [] });
  await writeFile(join(made.path, "new.txt"), "x");
  await writeFile(join(made.path, "b.txt"), "b");
  await run(made.path, "add", "b.txt");
  await run(made.path, "commit", "-q", "-m", "second");
  const unsaved = await unsavedIn(made);
  expect(unsaved.files).toEqual(["new.txt"]);
  expect(unsaved.commits).toHaveLength(1);

  await removeWorktree(made, true);
  expect((await listWorktrees(root)).map((tree) => tree.path)).not.toContain(made.path);
  expect((await listBranches(root)).branches).not.toContain("worktree-three");
});

test("only a worktree in `git worktree list` can be entered by path", async () => {
  const made = await createWorktree(root, { name: "four" });
  expect(await findWorktree(root, made.path)).toMatchObject({ path: made.path });
  await expect(findWorktree(root, tmpdir())).rejects.toMatchObject({ reason: "not_a_worktree" });
});

test("a branch left behind is reused with no base, and refused when a base is asked for", async () => {
  await run(root, "branch", "worktree-left-over", "topic");
  const error = await createWorktree(root, { name: "left-over", base: "main" }).catch((e) => e);
  expect(error).toBeInstanceOf(WorktreeError);
  expect((error as WorktreeError).reason).toBe("branch_exists");
  const reused = await createWorktree(root, { name: "left-over" });
  expect(reused.branch).toBe("worktree-left-over");
  await removeWorktree(reused, true);
});

test("the main checkout is not a worktree to enter, and a relative path is the folder's own", async () => {
  const error = await findWorktree(root, root).catch((e) => e);
  expect((error as WorktreeError).reason).toBe("not_a_worktree");
  const made = await createWorktree(root, { name: "rel", base: "main" });
  const found = await findWorktree(root, join(".agents", "worktree", "rel"));
  expect(found.path).toBe(made.path);
  await removeWorktree(made, true);
});
