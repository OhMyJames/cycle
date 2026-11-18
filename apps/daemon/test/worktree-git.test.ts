import { expect, test } from "bun:test";
import { Git } from "../src/git.ts";
import { answer, heldGit, keyOf, settle } from "./held-git.ts";

test("worktree changes to one repository run one after the other", async () => {
  const { git, releases, adds } = heldGit();
  const first = git.addWorktree({ cwd: "/repo", branch: "one" });
  const second = git.addWorktree({ cwd: "/repo", branch: "two" });
  await settle();
  expect(adds()).toHaveLength(1);
  releases[0]?.();
  await first;
  await settle();
  expect(adds()).toHaveLength(2);
  releases[1]?.();
  await second;
});

test("worktree changes to two repositories do not wait for each other", async () => {
  const { git, releases, adds } = heldGit({
    roots: { "/other": "/other" },
    commons: { "/other": "/other/.git" },
  });
  const first = git.addWorktree({ cwd: "/repo", branch: "one" });
  const second = git.addWorktree({ cwd: "/other", branch: "two" });
  await settle();
  expect(adds()).toHaveLength(2);
  expect(adds().map((add) => add.split(" ").at(-2))).toEqual([
    "/repo/.agents/worktree/one",
    "/other/.agents/worktree/two",
  ]);
  for (const release of releases) release();
  await Promise.all([first, second]);
});

test("a worktree that failed to be made does not hold the next one, and leaves nothing registered", async () => {
  const keys: string[] = [];
  let added = 0;
  const git = new Git(async (argv, options) => {
    const key = keyOf(argv);
    keys.push(key);
    if (key.startsWith("worktree add") && ++added === 1) {
      return { exitCode: 128, stdout: "", stderr: "fatal: no\n" };
    }
    return answer(key, options.cwd ?? "");
  });
  const failed = git.addWorktree({ cwd: "/repo", branch: "one" });
  const next = git.addWorktree({ cwd: "/repo", branch: "two" });
  await expect(failed).rejects.toThrow("fatal: no");
  expect((await next).worktree.branch).toBe("two");
  expect(keys).toContain("worktree remove --force /repo/.agents/worktree/one");
});

test("a worktree is added on a new branch from the base, without tracking", async () => {
  const { git, releases, adds } = heldGit();
  const made = git.addWorktree({ cwd: "/repo", branch: "feature" });
  await settle();
  releases[0]?.();
  const { worktree } = await made;
  expect(adds()[0]).toBe(
    "worktree add --no-track -b feature /repo/.agents/worktree/feature abc123",
  );
  expect(worktree).toEqual({
    repo: "/repo",
    base: "abc123",
    branch: "feature",
    path: "/repo/.agents/worktree/feature",
  });
});

test("a branch that is taken gets a number: -2, then -3", async () => {
  const { git, releases, adds } = heldGit({ branches: ["main", "feature", "feature-2"] });
  const made = git.addWorktree({ cwd: "/repo", branch: "feature" });
  await settle();
  releases[0]?.();
  expect((await made).worktree.branch).toBe("feature-3");
  expect(adds()[0]).toStartWith("worktree add --no-track -b feature-3 ");
});

test("removing a worktree finds the root of the folder it was given, and keeps the branch", async () => {
  const { git, runs } = heldGit({ roots: { "/w/repo/f/sub": "/w/repo/f" } });
  await git.removeWorktree("/repo", "/w/repo/f/sub");
  const removal = runs.find((run) => run.key.startsWith("worktree remove"));
  expect(removal).toEqual({ key: "worktree remove --force /w/repo/f", cwd: "/repo" });
  expect(runs.some((run) => run.key.startsWith("branch"))).toBe(false);
});
