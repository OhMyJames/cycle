import { expect, test } from "bun:test";
import type { ExecResult } from "@cycle/protocol";
import { Git, type Exec } from "../src/git.ts";

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const missing: ExecResult = { exitCode: 1, stdout: "", stderr: "" };

/** The words of a command after the four a git run starts with. */
const keyOf = (argv: string[]) => (argv[0] === "git" ? argv.slice(4) : argv).join(" ");

/** What one repository at `/repo` says to the commands a worktree is made with. */
function answer(key: string, cwd: string, roots: Record<string, string>, branches: string[]) {
  if (key === "rev-parse --show-toplevel") return ok(`${roots[cwd] ?? "/repo"}\n`);
  if (key === "rev-parse --path-format=absolute --git-common-dir") return ok("/repo/.git\n");
  if (key === "rev-parse --verify HEAD^{commit}") return ok("abc123\n");
  if (key.startsWith("for-each-ref")) return ok(branches.map((b) => `refs/heads/${b}\n`).join(""));
  if (key.startsWith("test -e")) return missing;
  return ok("");
}

/**
 * A git that answers for one repository and holds each `worktree add` until the test lets it go,
 * so what runs one after the other can be told from what runs together.
 */
function heldGit(options: { branches?: string[]; roots?: Record<string, string> } = {}) {
  const runs: { key: string; cwd: string }[] = [];
  const releases: (() => void)[] = [];
  const exec: Exec = async (argv, execOptions) => {
    const key = keyOf(argv);
    const cwd = execOptions.cwd ?? "";
    runs.push({ key, cwd });
    if (key.startsWith("worktree add")) {
      await new Promise<void>((resolve) => releases.push(resolve));
    }
    return answer(key, cwd, options.roots ?? {}, options.branches ?? ["main"]);
  };
  const adds = () => runs.filter((run) => run.key.startsWith("worktree add")).map((r) => r.key);
  return { git: new Git(exec), runs, releases, adds };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}

test("worktree changes to one repository run one after the other", async () => {
  const { git, releases, adds } = heldGit();
  const first = git.addWorktree({ cwd: "/repo", parent: "/w", branch: "one" });
  const second = git.addWorktree({ cwd: "/repo", parent: "/w", branch: "two" });
  await settle();
  expect(adds()).toHaveLength(1);
  releases[0]?.();
  await first;
  await settle();
  expect(adds()).toHaveLength(2);
  releases[1]?.();
  await second;
});

test("a worktree that failed to be made does not hold the next one", async () => {
  let added = 0;
  const git = new Git(async (argv, options) => {
    const key = keyOf(argv);
    if (key.startsWith("worktree add") && ++added === 1) {
      return { exitCode: 128, stdout: "", stderr: "fatal: no\n" };
    }
    return answer(key, options.cwd ?? "", {}, ["main"]);
  });
  const failed = git.addWorktree({ cwd: "/repo", parent: "/w", branch: "one" });
  const next = git.addWorktree({ cwd: "/repo", parent: "/w", branch: "two" });
  expect(failed).rejects.toThrow("fatal: no");
  expect((await next).worktree.branch).toBe("two");
});

test("a worktree is added on a new branch from the base, without tracking", async () => {
  const { git, releases, adds } = heldGit();
  const made = git.addWorktree({ cwd: "/repo", parent: "/w", branch: "feature" });
  await settle();
  releases[0]?.();
  const { worktree } = await made;
  expect(adds()[0]).toStartWith("worktree add --no-track -b feature ");
  expect(adds()[0]).toEndWith(" abc123");
  expect(worktree).toMatchObject({ repo: "/repo", base: "abc123", branch: "feature" });
});

test("a branch that is taken gets a number: -2, then -3", async () => {
  const { git, releases, adds } = heldGit({ branches: ["main", "feature", "feature-2"] });
  const made = git.addWorktree({ cwd: "/repo", parent: "/w", branch: "feature" });
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
