import { expect, test } from "bun:test";
import { Git, GitError, parseWorktrees } from "../src/index.ts";
import { keyOf, ok } from "./held-git.ts";

const PORCELAIN = [
  "worktree /repo",
  "HEAD 1111111",
  "branch refs/heads/main",
  "",
  "worktree /repo/.agents/worktree/feature",
  "HEAD 2222222",
  "branch refs/heads/feature/x",
  "",
  "worktree /elsewhere",
  "HEAD 3333333",
  "detached",
  "",
  "worktree /locked-bare-reason",
  "HEAD 4444444",
  "branch refs/heads/a",
  "locked in use on a usb drive",
  "",
  "worktree /locked-no-reason",
  "HEAD 5555555",
  "branch refs/heads/b",
  "locked",
  "",
  "worktree /gone",
  "HEAD 6666666",
  "branch refs/heads/c",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

test("git's list is read as records: the first is the main checkout", () => {
  const listed = parseWorktrees(PORCELAIN);
  expect(listed.map((one) => [one.path, one.branch, one.head, one.main])).toEqual([
    ["/repo", "main", "1111111", true],
    ["/repo/.agents/worktree/feature", "feature/x", "2222222", false],
    ["/elsewhere", null, "3333333", false],
    ["/locked-bare-reason", "a", "4444444", false],
    ["/locked-no-reason", "b", "5555555", false],
    ["/gone", "c", "6666666", false],
  ]);
});

test("a lock is told with a reason and without, and a prunable record is not locked", () => {
  const locks = parseWorktrees(PORCELAIN).map((one) => one.locked);
  expect(locks).toEqual([false, false, false, true, true, false]);
});

test("a bare record is marked, and a missing trailing blank line loses nothing", () => {
  const listed = parseWorktrees(
    "worktree /repo.git\nbare\n\nworktree /w\nHEAD abc\nbranch refs/heads/z",
  );
  expect(listed).toEqual([
    { path: "/repo.git", head: "", branch: null, locked: false, bare: true, main: true },
    { path: "/w", head: "abc", branch: "z", locked: false, bare: false, main: false },
  ]);
});

test("no output is no worktrees", () => {
  expect(parseWorktrees("")).toEqual([]);
});

const gitReturning = (result: { exitCode: number; stdout: string; stderr: string }) => {
  const runs: string[] = [];
  const git = new Git(async (argv, options) => {
    runs.push(`${options.cwd}: ${keyOf(argv)}`);
    return result;
  });
  return { git, runs };
};

test("the list is asked of the folder it is for, with no -z for older gits", async () => {
  const { git, runs } = gitReturning(ok(PORCELAIN));
  expect((await git.worktrees("/repo/sub")).length).toBe(6);
  expect(runs).toEqual(["/repo/sub: worktree list --porcelain"]);
});

test("a folder in no repository says so, and any other failure says what git did", async () => {
  const none = gitReturning({
    exitCode: 128,
    stdout: "",
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
  });
  const error = await none.git.worktrees("/nowhere").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(GitError);
  expect((error as Error).message).toBe("A worktree needs a git repository.");
  const other = gitReturning({ exitCode: 1, stdout: "", stderr: "fatal: odd\n" });
  await expect(other.git.worktrees("/repo")).rejects.toThrow("fatal: odd");
});

test("a worktree is dirty when status prints anything, and unknown when git cannot tell", async () => {
  const dirty = gitReturning(ok(" M a.txt\n?? b.txt\n"));
  expect(await dirty.git.dirty("/w")).toBe(true);
  expect(dirty.runs).toEqual(["/w: status --porcelain"]);
  expect(await gitReturning(ok("")).git.dirty("/w")).toBe(false);
  expect(await gitReturning(ok("\n")).git.dirty("/w")).toBe(false);
  expect(await gitReturning({ exitCode: 128, stdout: "", stderr: "x" }).git.dirty("/w")).toBe(null);
  const throwing = new Git(async () => {
    throw new Error("no such folder");
  });
  expect(await throwing.dirty("/w")).toBe(null);
});

test("a guard runs inside the removal, after the folder is found and before git removes it", async () => {
  const keys: string[] = [];
  const git = new Git(async (argv) => {
    keys.push(keyOf(argv));
    return keyOf(argv).startsWith("rev-parse --show-toplevel") ? ok("/w\n") : ok("");
  });
  await git.removeWorktree("/repo", "/w", async () => {
    keys.push("guard");
  });
  expect(keys.slice(-2)).toEqual(["guard", "worktree remove --force /w"]);
  keys.length = 0;
  await expect(
    git.removeWorktree("/repo", "/w", async () => {
      throw new GitError("refused");
    }),
  ).rejects.toThrow("refused");
  expect(keys.some((key) => key.startsWith("worktree remove"))).toBe(false);
});
