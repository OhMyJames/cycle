// `bun run worktree:prune`: remove the worktrees under `.agents/worktree/` whose work is already in main.
//
//   bun scripts/worktree-prune.ts [--repo dir] [--main origin/main]
//
// A worktree is removed (and its branch deleted) only when both hold: its branch is merged into
// origin/main, and it has no uncommitted changes (untracked files count). "Merged" includes a squash merge:
// the branch is an ancestor of main, or merging it into main would not change main's content.
// Everything else is skipped and listed with the reason. Worktrees outside `.agents/worktree/` (and the one
// this runs in) are never touched. origin is fetched first; if that fails nothing is removed.
// Exit 0 when the run completed (skips are normal), 1 when it could not run or a removal failed.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export type Outcome = { name: string; action: "removed" | "skipped"; reason: string };

const git = (cwd: string, args: string[]) => {
  // GIT_DIR and the like (set when this runs from a git hook) would point git somewhere else than `cwd`.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
};

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

type Entry = { path: string; branch: string | undefined; locked: boolean };

const parse = (porcelain: string): Entry[] =>
  porcelain
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
      const ref = lines.find((l) => l.startsWith("branch "))?.slice(7);
      return {
        path,
        branch: ref?.replace(/^refs\/heads\//, ""),
        locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
      };
    });

/** Whether `branch` is in `main`: an ancestor, or merging it would leave main's tree unchanged (squash). */
const merged = (repo: string, branch: string, main: string): { ok: boolean; why?: string } => {
  const ancestor = git(repo, ["merge-base", "--is-ancestor", branch, main]);
  if (ancestor.code === 0) return { ok: true };
  if (ancestor.code !== 1)
    return { ok: false, why: `could not compare with ${main}: ${ancestor.err}` };
  const tree = git(repo, ["merge-tree", "--write-tree", main, branch]);
  // Exit 1 is a conflict: the branch has changes main does not.
  if (tree.code !== 0) return { ok: false, why: `not merged into ${main}` };
  const mainTree = git(repo, ["rev-parse", `${main}^{tree}`]);
  const merge = tree.out.split("\n")[0];
  return merge === mainTree.out ? { ok: true } : { ok: false, why: `not merged into ${main}` };
};

export const prune = (repoArg: string, main = "origin/main"): Outcome[] => {
  const top = git(repoArg, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (top.code !== 0) throw new Error(`${repoArg} is not a git repository: ${top.err}`);
  // The main checkout is the first worktree listed; `.agents/worktree/` lives under it.
  const list = git(repoArg, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) throw new Error(`git worktree list: ${list.err}`);
  const entries = parse(list.out);
  const root = real(entries[0]?.path ?? repoArg);
  const base = join(root, ".agents", "worktree");
  const here = real(git(repoArg, ["rev-parse", "--show-toplevel"]).out || repoArg);

  const remote = main.split("/")[0] ?? "origin";
  const fetched = git(root, ["fetch", "--quiet", remote]);
  if (fetched.code !== 0)
    throw new Error(`git fetch ${remote} failed, so merged cannot be judged: ${fetched.err}`);
  if (git(root, ["rev-parse", "--verify", "--quiet", `${main}^{commit}`]).code !== 0)
    throw new Error(`${main} is not here: merged cannot be judged`);

  const out: Outcome[] = [];
  for (const entry of entries.slice(1)) {
    const path = real(entry.path);
    const rel = relative(base, path);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || resolve(rel) === rel) continue;
    const name = rel.split(sep).join("/");
    const skip = (reason: string) => out.push({ name, action: "skipped", reason });
    if (path === here) {
      skip("this is the worktree the command runs in");
      continue;
    }
    if (entry.locked) {
      skip("locked");
      continue;
    }
    if (entry.branch === undefined) {
      skip("no branch (detached HEAD)");
      continue;
    }
    const status = git(path, ["status", "--porcelain"]);
    if (status.code !== 0) {
      skip(`could not read status: ${status.err}`);
      continue;
    }
    if (status.out !== "") {
      skip("has uncommitted changes");
      continue;
    }
    const verdict = merged(root, entry.branch, main);
    if (!verdict.ok) {
      skip(`branch ${entry.branch}: ${verdict.why}`);
      continue;
    }
    const removed = git(root, ["worktree", "remove", entry.path]);
    if (removed.code !== 0) {
      skip(`could not remove the worktree: ${removed.err}`);
      continue;
    }
    // -D: a squash-merged branch is not an ancestor, so -d would refuse it. Merged was checked above.
    const branch = git(root, ["branch", "-D", entry.branch]);
    out.push({
      name,
      action: "removed",
      reason:
        branch.code === 0
          ? `merged into ${main}; branch ${entry.branch} deleted`
          : `worktree removed, branch ${entry.branch} not deleted: ${branch.err}`,
    });
  }
  return out;
};

export const report = (outcomes: readonly Outcome[]): string => {
  const removed = outcomes.filter((o) => o.action === "removed");
  const skipped = outcomes.filter((o) => o.action === "skipped");
  const lines = [`removed ${removed.length}, skipped ${skipped.length}`];
  for (const o of removed) lines.push(`  removed  ${o.name}: ${o.reason}`);
  for (const o of skipped) lines.push(`  skipped  ${o.name}: ${o.reason}`);
  return lines.join("\n");
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (flag: string, fallback: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : fallback;
  };
  try {
    const outcomes = prune(opt("--repo", process.cwd()), opt("--main", "origin/main"));
    console.log(report(outcomes));
    process.exit(outcomes.some((o) => o.reason.startsWith("could not remove")) ? 1 : 0);
  } catch (e) {
    console.error(`worktree:prune: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
