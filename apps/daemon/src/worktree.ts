// Git worktrees as Cycle makes them (docs/protocol.md §6 "Worktree"): `<main checkout>/.agents/worktree/<name>`, branch
// `worktree-<name>`, the same place and names as the repository's Claude hooks, so a worktree made by either is
// found by the other. The contract of EnterWorktree and ExitWorktree follows Claude's own tools.
import { randomBytes } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gitEnv } from "./git.ts";

/** A worktree is made and removed in this time; a checkout of a large repository can take a while. */
const TIME_LIMIT_MS = 120_000;
const NAME_LIMIT = 64;
const NAME_PART = /^[A-Za-z0-9._-]+$/;

export class WorktreeError extends Error {
  constructor(
    readonly reason:
      | "not_a_repository"
      | "invalid_name"
      | "invalid_base"
      | "not_a_worktree"
      | "branch_exists"
      | "unsaved_changes"
      | "git_failed",
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Run = { code: number; out: string; err: string };

/** Git in `dir`, with its output kept (unlike `runGit`, which is for looking, this one is for changing). */
const git = async (
  dir: string,
  args: readonly string[],
  timeoutMs = TIME_LIMIT_MS,
): Promise<Run> => {
  const child = Bun.spawn(["git", "-C", dir, "--no-pager", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv(),
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
};

const must = async (dir: string, args: readonly string[]): Promise<string> => {
  const result = await git(dir, args);
  if (result.code !== 0)
    throw new WorktreeError("git_failed", `git ${args[0]} failed: ${result.err.trim()}`, {
      command: args[0],
    });
  return result.out;
};

/** The main checkout of the repository `dir` is in, even from inside one of its worktrees. */
export const mainCheckout = async (dir: string): Promise<string> => {
  // The first entry of the list is the main working tree (right for submodules and separate git dirs too).
  const listed = await git(dir, ["worktree", "list", "--porcelain"]);
  const first = listed.out.split("\n").find((line) => line.startsWith("worktree "));
  if (listed.code !== 0 || first === undefined)
    throw new WorktreeError("not_a_repository", `${dir} is not in a git repository`);
  return first.slice(9);
};

/** A worktree name checked the way Claude checks it: `/`-separated parts of letters, digits, `.`, `_`, `-`; ≤ 64. */
export const checkName = (name: string): string => {
  const parts = name.split("/");
  if (
    name.length === 0 ||
    name.length > NAME_LIMIT ||
    parts.some(
      (part) => !NAME_PART.test(part) || part === "." || part === ".." || part.includes(".."),
    )
  )
    throw new WorktreeError(
      "invalid_name",
      `A worktree name is up to ${NAME_LIMIT} characters of letters, digits, ".", "_" and "-", in parts separated by "/"`,
    );
  return name;
};

export const randomName = (): string => `wt-${randomBytes(4).toString("hex")}`;

export type Branches = {
  /** Local branches. */
  branches: string[];
  /** The branch checked out in the folder, absent when HEAD is detached. */
  current?: string;
  /** The remote's default branch, as a local name when there is one with that name, else `origin/<name>`. */
  defaultBranch?: string;
};

/** The branches a worktree may start from (local ones, and the remote's default; no fetch). */
export const listBranches = async (dir: string): Promise<Branches> => {
  const root = await mainCheckout(dir);
  const listed = await must(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const branches = listed.split("\n").filter((line) => line !== "");
  const head = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remote = await git(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const remoteName = remote.code === 0 ? remote.out.trim().replace(/^origin\//, "") : undefined;
  const defaultBranch =
    remoteName === undefined
      ? undefined
      : branches.includes(remoteName)
        ? remoteName
        : remote.out.trim();
  return {
    branches,
    ...(head.code === 0 ? { current: head.out.trim() } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
  };
};

export type Worktree = {
  /** The main checkout. */
  root: string;
  path: string;
  branch?: string;
};

/** The worktrees of the repository `dir` is in (`git worktree list`). */
export const listWorktrees = async (dir: string): Promise<Worktree[]> => {
  const root = await mainCheckout(dir);
  const text = await must(root, ["worktree", "list", "--porcelain"]);
  const found: Worktree[] = [];
  for (const block of text.split("\n\n")) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
    }
    if (path !== undefined) found.push({ root, path, ...(branch !== undefined ? { branch } : {}) });
  }
  return found;
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** What to start from: the chosen branch; else the remote's default; else where the folder is. */
const baseOf = async (root: string, base: string | undefined): Promise<string> => {
  if (base !== undefined) {
    const found = await git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (found.code !== 0) throw new WorktreeError("invalid_base", `There is no branch ${base}`);
    return base;
  }
  const remote = await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  return remote.code === 0 ? remote.out.trim() : "HEAD";
};

export type Made = Worktree & {
  /** False when a worktree of that name was already there and is used as it is (no setup to run). */
  created: boolean;
};

/**
 * Makes the worktree `name` for the repository `dir` is in, or finds the one already there. Branch `worktree-<name>`
 * from `base` (a branch name; the remote's default when absent, no fetch).
 */
export const createWorktree = async (
  dir: string,
  options: { name?: string | undefined; base?: string | undefined } = {},
): Promise<Made> => {
  const root = await mainCheckout(dir);
  const name = checkName(options.name ?? randomName());
  const path = join(root, ".agents", "worktree", name);
  const branch = `worktree-${name}`;
  if (await exists(path)) {
    const known = (await listWorktrees(root)).find((tree) => resolve(tree.path) === resolve(path));
    if (known === undefined)
      throw new WorktreeError("not_a_worktree", `${path} exists and is not a worktree`);
    return { ...known, created: false };
  }
  await mkdir(dirname(path), { recursive: true });
  const taken = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (taken.code === 0) {
    // A branch left behind by an earlier worktree: it is reused when no start was asked for, never passed off as
    // made from `base`.
    if (options.base !== undefined)
      throw new WorktreeError(
        "branch_exists",
        `The branch ${branch} already exists, so a worktree named ${name} cannot start from ${options.base}. Pick another name, or delete the branch.`,
      );
    await must(root, ["worktree", "add", path, branch]);
  } else
    await must(root, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      path,
      await baseOf(root, options.base),
    ]);
  return { root, path, branch, created: true };
};

/** An existing worktree of the repository, by path (for EnterWorktree's `path`). */
export const findWorktree = async (dir: string, path: string): Promise<Worktree> => {
  // A relative path is the session's own folder's, not the daemon's.
  const wanted = resolve(dir, path);
  const found = (await listWorktrees(dir)).find((tree) => resolve(tree.path) === wanted);
  if (found === undefined)
    throw new WorktreeError("not_a_worktree", `${path} is not in \`git worktree list\``);
  if (resolve(found.path) === resolve(found.root))
    throw new WorktreeError("not_a_worktree", `${path} is the main checkout, not a worktree`);
  return found;
};

export type Unsaved = { files: string[]; commits: string[] };

/** What removing the worktree would lose: files not committed, commits on no other branch. */
export const unsavedIn = async (tree: Worktree): Promise<Unsaved> => {
  const status = await must(tree.path, ["status", "--porcelain", "--untracked-files=all"]);
  const files = status
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));
  let commits: string[] = [];
  if (tree.branch !== undefined) {
    const log = await must(tree.root, [
      "rev-list",
      "--oneline",
      `refs/heads/${tree.branch}`,
      "--not",
      `--exclude=${tree.branch}`,
      "--branches",
      "--remotes",
    ]);
    commits = log.split("\n").filter((line) => line !== "");
  }
  return { files, commits };
};

/** Removes the worktree and its branch (the branch only if git agrees). Unsaved work is the caller's to have checked. */
export const removeWorktree = async (tree: Worktree, discardCommits = false): Promise<void> => {
  await must(tree.root, ["worktree", "remove", "--force", tree.path]);
  if (tree.branch !== undefined)
    await git(tree.root, ["branch", discardCommits ? "-D" : "-d", tree.branch]);
};
