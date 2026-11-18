import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@cycle/protocol";
import { Git } from "../../src/index.ts";

/** The daemon's `Git` over real processes, in a scratch repository. */
let root: string;
let repo: string;

async function exec(argv: string[], options: ExecOptions): Promise<ExecResult> {
  const child = Bun.spawn(argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cycle-worktree-")));
  repo = join(root, "repo");
  Bun.spawnSync(["mkdir", "-p", join(repo, "pkg")]);
  writeFileSync(join(repo, "pkg", "a.txt"), "a\n");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("worktrees are made inside the repository, which stays clean, and removed with their branch kept", async () => {
  const worktrees = new Git(exec);
  const first = await worktrees.addWorktree({ cwd: join(repo, "pkg"), branch: "feature/x" });
  const folder = join(repo, ".agents", "worktree");
  expect(first.worktree).toMatchObject({
    repo,
    branch: "feature/x",
    path: join(folder, "feature-x"),
  });
  expect(first.cwd).toBe(join(folder, "feature-x", "pkg"));
  expect(existsSync(join(first.cwd, "a.txt"))).toBe(true);
  expect(readFileSync(join(folder, ".gitignore"), "utf8")).toBe("*\n");
  expect(git("status", "--porcelain")).toBe("");

  // `feature/x` and `feature-x` are made safe alike: the second takes the next free folder.
  const second = await worktrees.addWorktree({ cwd: repo, branch: "feature-x" });
  expect(second.worktree.path).toBe(join(folder, "feature-x-2"));
  // From inside a worktree, the new one is still made in the main checkout.
  const third = await worktrees.addWorktree({ cwd: first.cwd, branch: "later" });
  expect(third.worktree).toMatchObject({ repo, path: join(folder, "later") });
  expect(third.cwd).toBe(join(folder, "later", "pkg"));

  // A `.gitignore` already there is not written over.
  writeFileSync(join(folder, ".gitignore"), "*\n!keep\n");
  await worktrees.addWorktree({ cwd: repo, branch: "again" });
  expect(readFileSync(join(folder, ".gitignore"), "utf8")).toBe("*\n!keep\n");

  await worktrees.removeWorktree(repo, first.cwd);
  expect(existsSync(first.worktree.path)).toBe(false);
  expect(git("branch", "--list", "feature/x")).toContain("feature/x");
  expect(git("status", "--porcelain")).toBe("");
});

test("a repository with its git dir elsewhere gets worktrees, and a bare one is refused", async () => {
  const separate = join(root, "separate");
  Bun.spawnSync(["mkdir", "-p", separate]);
  const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: separate });
  run("init", "-q", "-b", "main", "--separate-git-dir", join(root, "separate.git"));
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  const made = await new Git(exec).addWorktree({ cwd: separate, branch: "y" });
  expect(made.worktree).toMatchObject({
    repo: separate,
    path: join(separate, ".agents", "worktree", "y"),
  });

  const bare = join(root, "bare.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
  await expect(new Git(exec).addWorktree({ cwd: bare, branch: "z" })).rejects.toThrow(
    "A worktree needs a git checkout.",
  );
});

test("removing a worktree discards its uncommitted files and keeps its branch with the commit", async () => {
  const worktrees = new Git(exec);
  const made = await worktrees.addWorktree({ cwd: repo, branch: "dirty" });
  const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: made.worktree.path });
  writeFileSync(join(made.worktree.path, "committed.txt"), "c\n");
  run("add", "-A");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
  writeFileSync(join(made.worktree.path, "pkg", "a.txt"), "changed\n");
  writeFileSync(join(made.worktree.path, "untracked.txt"), "u\n");
  expect(run("status", "--porcelain").stdout.toString()).toContain("untracked.txt");

  await worktrees.removeWorktree(repo, made.worktree.path);
  expect(existsSync(made.worktree.path)).toBe(false);
  expect(git("branch", "--list", "dirty")).toContain("dirty");
  expect(git("log", "--format=%s", "dirty", "-1")).toBe("work\n");
  expect(git("status", "--porcelain")).toBe("");
});

test("a worktree whose folder was deleted by hand is removed without error", async () => {
  const worktrees = new Git(exec);
  const made = await worktrees.addWorktree({ cwd: repo, branch: "vanished" });
  rmSync(made.worktree.path, { recursive: true, force: true });
  expect(git("worktree", "list", "--porcelain")).toContain(made.worktree.path);
  await worktrees.removeWorktree(repo, made.worktree.path);
  expect(git("worktree", "list", "--porcelain")).not.toContain(made.worktree.path);
});

test("the main checkout is never removed", async () => {
  await expect(new Git(exec).removeWorktree(repo, repo)).rejects.toThrow();
  expect(existsSync(join(repo, "pkg", "a.txt"))).toBe(true);
  expect(existsSync(join(repo, ".git"))).toBe(true);
});

test("a locked worktree is not removed: the known limit of a single --force", async () => {
  const worktrees = new Git(exec);
  const made = await worktrees.addWorktree({ cwd: repo, branch: "locked" });
  git("worktree", "lock", made.worktree.path);
  await expect(worktrees.removeWorktree(repo, made.worktree.path)).rejects.toThrow(/locked/);
  expect(existsSync(made.worktree.path)).toBe(true);
});
