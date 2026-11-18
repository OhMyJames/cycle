import { expect, test } from "bun:test";
import { settle } from "./held-git.ts";
import {
  LEGACY,
  MADE,
  MAIN,
  type RepoOptions,
  listing,
  record,
  repo,
  user,
} from "./worktree-repo.ts";

const main = record(MAIN, { branch: "main" });
const made = `${MADE}/feature`;
const NOT_LISTED = "That folder is not a worktree of this repository.";
const BY_HAND = "Cycle removes only the worktrees it made. Remove this one with git.";
const LOCKED = "This worktree is locked. Unlock it with git (git worktree unlock) to remove it.";

function oneMade(extra: Partial<RepoOptions> = {}) {
  return repo({ porcelain: listing(main, record(made, { branch: "feature" })), ...extra });
}

test("a managed worktree no session works in is removed from the main checkout, keeping its branch", async () => {
  const { worktrees, runs, removals } = oneMade();
  await worktrees.remove(MAIN, made);
  expect(removals()).toEqual([{ key: `worktree remove --force ${made}`, cwd: MAIN }]);
  expect(runs.some((run) => run.key.includes("branch"))).toBe(false);
});

test("it is removed whichever folder of the repository names the workspace, its own included", async () => {
  const { worktrees, removals } = oneMade();
  await worktrees.remove(made, made);
  expect(removals()).toEqual([{ key: `worktree remove --force ${made}`, cwd: MAIN }]);
});

test.each([
  ["a path with .. in it", `${MADE}/../worktree/feature`],
  ["a trailing slash", `${made}/`],
  ["a relative path", ".agents/worktree/feature"],
  ["a folder inside it", `${made}/pkg`],
  ["the folder above it", MADE],
  ["the main checkout", MAIN],
  ["a folder of another repository", "/other/.agents/worktree/feature"],
  ["a different case", `${MADE}/Feature`],
  ["nothing", ""],
])("%s is refused before git is asked to remove anything", async (_name, path) => {
  const { worktrees, removals, runs } = oneMade();
  await expect(worktrees.remove(MAIN, path)).rejects.toThrow(NOT_LISTED);
  expect(removals()).toEqual([]);
  expect(runs.some((run) => run.key.startsWith("worktree remove"))).toBe(false);
});

test("a worktree git lists that Cycle did not make is refused, in any place outside its own", async () => {
  for (const path of [
    "/repo/.claude/worktrees/entered",
    "/elsewhere",
    `${MAIN}/.agents/worktree-x/sibling`,
    `${LEGACY}-other/x`,
  ]) {
    const { worktrees, removals } = repo({
      porcelain: listing(main, record(path, { branch: "x" })),
    });
    await expect(worktrees.remove(MAIN, path)).rejects.toThrow(BY_HAND);
    expect(removals()).toEqual([]);
  }
});

test("a worktree of the older place is removed too", async () => {
  const old = `${LEGACY}/repo/feat`;
  const { worktrees, removals } = repo({
    porcelain: listing(main, record(old, { branch: "feat" })),
  });
  await worktrees.remove(MAIN, old);
  expect(removals().map((run) => run.key)).toEqual([`worktree remove --force ${old}`]);
});

test("a session working in it blocks, by name, whatever it is working on", async () => {
  for (const activity of ["running", "requires_action"] as const) {
    const { worktrees, removals } = oneMade({
      users: { [made]: [user("a", { name: "Fix the build", activity })] },
    });
    await expect(worktrees.remove(MAIN, made)).rejects.toThrow(
      'A session is working in this worktree: "Fix the build". Stop it first.',
    );
    expect(removals()).toEqual([]);
  }
});

test("idle sessions and archived ones do not block, named or only in the folder", async () => {
  const { worktrees, removals } = oneMade({
    users: {
      [made]: [
        user("idle"),
        user("archived", { archived: true }),
        user("inside", { named: false, base: null, origin: null }),
      ],
    },
  });
  await worktrees.remove(MAIN, made);
  expect(removals()).toHaveLength(1);
});

test("a locked worktree is refused, with a reason or without", async () => {
  for (const locked of [true, "a reason"] as const) {
    const { worktrees, removals } = repo({
      porcelain: listing(main, record(made, { branch: "feature", locked })),
    });
    await expect(worktrees.remove(MAIN, made)).rejects.toThrow(LOCKED);
    expect(removals()).toEqual([]);
  }
});

test("the first reason wins: not listed, then not made by Cycle, then working, then locked", async () => {
  const hand = "/repo/.claude/worktrees/x";
  const both = repo({
    porcelain: listing(main, record(hand, { locked: true })),
    users: { [hand]: [user("a", { activity: "running" })] },
  });
  await expect(both.worktrees.remove(MAIN, hand)).rejects.toThrow(BY_HAND);
  const busyAndLocked = repo({
    porcelain: listing(main, record(made, { locked: true })),
    users: { [made]: [user("a", { activity: "running" })] },
  });
  await expect(busyAndLocked.worktrees.remove(MAIN, made)).rejects.toThrow("working");
});

test("a worktree whose folder is gone is removed, so git forgets it", async () => {
  const { worktrees, removals } = oneMade({ gone: [made] });
  await worktrees.remove(MAIN, made);
  expect(removals().map((run) => run.key)).toEqual([`worktree remove --force ${made}`]);
});

test("a session that starts working after the check, before git runs, stops the removal", async () => {
  const options = {
    porcelain: listing(main, record(made, { branch: "feature" })),
    users: { [made]: [user("a")] },
    onRun: (key: string) => {
      // The lock is had and the folder found: now the session starts a turn.
      if (key === "rev-parse --show-toplevel") {
        options.users[made] = [user("a", { activity: "running" })];
      }
    },
  };
  const { worktrees, removals } = repo(options);
  await expect(worktrees.remove(MAIN, made)).rejects.toThrow("A session is working");
  expect(removals()).toEqual([]);
});

test("a worktree git no longer lists by the time the lock is had is not removed", async () => {
  const options = {
    porcelain: listing(main, record(made, { branch: "feature" })),
    onRun: (key: string) => {
      if (key === "rev-parse --show-toplevel") options.porcelain = main;
    },
  };
  const { worktrees, removals } = repo(options);
  await expect(worktrees.remove(MAIN, made)).rejects.toThrow(NOT_LISTED);
  expect(removals()).toEqual([]);
});

test("two removals in one repository run one after the other", async () => {
  const other = `${MADE}/other`;
  const { worktrees, removals, releases, holdRemovals } = repo({
    porcelain: listing(main, record(made, { branch: "feature" }), record(other, { branch: "o" })),
  });
  holdRemovals();
  const first = worktrees.remove(MAIN, made);
  const second = worktrees.remove(MAIN, other);
  await settle();
  expect(removals().map((run) => run.key)).toEqual([`worktree remove --force ${made}`]);
  releases[0]?.();
  await first;
  await settle();
  expect(removals().map((run) => run.key)).toEqual([
    `worktree remove --force ${made}`,
    `worktree remove --force ${other}`,
  ]);
  releases[1]?.();
  await second;
});
