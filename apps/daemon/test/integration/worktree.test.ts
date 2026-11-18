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
