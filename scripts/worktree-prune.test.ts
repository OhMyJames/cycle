import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prune, report } from "./worktree-prune.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "worktree-prune-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const clean = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !k.startsWith("GIT_") && v !== undefined),
  ) as Record<string, string>;

const git = (cwd: string, ...args: string[]): string => {
  const run = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: clean() },
  );
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.toString().trim();
};

test("removes merged clean worktrees (also squash), skips the rest, leaves outside ones alone", async () => {
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  await writeFile(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c1");
  git(repo, "push", "-q", "origin", "HEAD:main");
  const wt = (name: string, dirPath = join(repo, ".agents", "worktree", name)) => {
    git(repo, "worktree", "add", "-q", "-b", name.replace("/", "-"), dirPath, "main");
    return dirPath;
  };
  const commit = async (path: string, file: string, text: string) => {
    await writeFile(join(path, file), text);
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", file);
  };

  // ancestor: merged by fast-forward
  const ff = wt("ff");
  await commit(ff, "ff.txt", "ff\n");
  // squash: same content lands on main as a different commit
  const sq = wt("auto/sq");
  await commit(sq, "sq.txt", "sq\n");
  await commit(sq, "sq.txt", "sq2\n");
  // not merged
  const open = wt("open");
  await commit(open, "open.txt", "open\n");
  // merged but dirty
  const dirty = wt("dirty");
  await writeFile(join(dirty, "scratch.txt"), "x");
  // outside .agents/worktree: merged and clean, must stay
  const outside = wt("outside", join(dir, "elsewhere"));

  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--ff-only", "ff");
  await writeFile(join(repo, "sq.txt"), "sq2\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "squash sq");
  git(repo, "push", "-q", "origin", "main");

  const outcomes = prune(repo);
  const by = Object.fromEntries(outcomes.map((o) => [o.name, o]));
  expect(by.ff?.action).toBe("removed");
  expect(by["auto/sq"]?.action).toBe("removed");
  expect(by.open?.action).toBe("skipped");
  expect(by.open?.reason).toContain("not merged");
  expect(by.dirty?.action).toBe("skipped");
  expect(by.dirty?.reason).toContain("uncommitted");
  expect(by.outside).toBeUndefined();

  expect(existsSync(ff)).toBe(false);
  expect(existsSync(sq)).toBe(false);
  expect(existsSync(open)).toBe(true);
  expect(existsSync(dirty)).toBe(true);
  expect(existsSync(outside)).toBe(true);
  const branches = git(repo, "branch", "--format=%(refname:short)").split("\n");
  expect(branches).not.toContain("ff");
  expect(branches).not.toContain("auto-sq");
  expect(branches).toContain("open");
  expect(branches).toContain("outside");

  const text = report(outcomes);
  expect(text).toContain("skipped  open");
  expect(text).toContain("skipped  dirty");
});
