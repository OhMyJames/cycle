import { expect, test } from "bun:test";
import { LEGACY, MADE, MAIN, listing, record, repo, user } from "./worktree-repo.ts";

const main = record(MAIN, { branch: "main" });
const outer = `${MADE}/outer`;
const BY_HAND = "Cycle removes only the worktrees it made. Remove this one with git.";
const BROKEN =
  "This folder is not the root of its worktree: its .git file is missing or broken. Remove it with git.";

test("only a folder directly under .agents/worktree, or <repository>/<branch> of the older place, is managed", async () => {
  const nested = [
    `${outer}/sub`,
    `${outer}/.claude/worktrees/x`,
    `${LEGACY}/old`,
    `${LEGACY}/repo/old/inner`,
  ];
  const { worktrees } = repo({
    porcelain: listing(
      main,
      record(outer, { branch: "outer" }),
      record(`${LEGACY}/repo/old`, { branch: "old" }),
      ...nested.map((path) => record(path, { branch: "n" })),
    ),
  });
  const entries = (await worktrees.list(MAIN)).worktrees;
  expect(entries.filter((entry) => entry.managed).map((entry) => entry.path)).toEqual([
    `${LEGACY}/repo/old`,
    outer,
  ]);
  expect(
    entries
      .filter((entry) => !entry.managed)
      .map((entry) => entry.path)
      .toSorted(),
  ).toEqual(nested.toSorted());
});

test("a worktree inside another is not removed, nor the one it is inside, and nothing is run", async () => {
  const sub = `${outer}/sub`;
  const { worktrees, removals } = repo({
    porcelain: listing(main, record(outer, { branch: "outer" }), record(sub, { branch: "sub" })),
  });
  await expect(worktrees.remove(MAIN, sub)).rejects.toThrow(BY_HAND);
  await expect(worktrees.remove(MAIN, outer)).rejects.toThrow(
    `Another worktree is inside this one: ${sub}. Remove that one first.`,
  );
  expect(removals()).toEqual([]);
});

test("an entered worktree of an agent's own tool inside a worktree of Cycle's blocks its removal too", async () => {
  const entered = `${outer}/.claude/worktrees/x`;
  const { worktrees, removals } = repo({
    porcelain: listing(main, record(outer), record(entered, { branch: "x" })),
  });
  await expect(worktrees.remove(MAIN, outer)).rejects.toThrow(entered);
  expect(removals()).toEqual([]);
});

test("a nested worktree that appears after the first look stops the removal inside the lock", async () => {
  const sub = `${outer}/sub`;
  const options = {
    porcelain: listing(main, record(outer, { branch: "outer" })),
    onRun: (key: string) => {
      if (key === "rev-parse --show-toplevel") {
        options.porcelain = listing(main, record(outer), record(sub, { branch: "sub" }));
      }
    },
  };
  const { worktrees, removals } = repo(options);
  await expect(worktrees.remove(MAIN, outer)).rejects.toThrow("Another worktree is inside");
  expect(removals()).toEqual([]);
});

test("a worktree whose .git file is gone resolves to the checkout above it, and is not removed", async () => {
  const { worktrees, removals, runs } = repo({
    porcelain: listing(main, record(outer, { branch: "outer" })),
    broken: [outer],
  });
  await expect(worktrees.remove(MAIN, outer)).rejects.toThrow(BROKEN);
  expect(removals()).toEqual([]);
  expect(runs.some((run) => run.key === "rev-parse --show-toplevel" && run.cwd === outer)).toBe(
    true,
  );
});

test("a worktree whose folder is gone is still removed, since git then forgets it", async () => {
  const { worktrees, removals } = repo({
    porcelain: listing(main, record(outer, { branch: "outer" })),
    gone: [outer],
  });
  await worktrees.remove(MAIN, outer);
  expect(removals().map((run) => run.key)).toEqual([`worktree remove --force ${outer}`]);
});

test("a running session blocks whether it is archived or only in the folder", async () => {
  const cases = [
    user("archived", { archived: true, activity: "running", name: "Old work" }),
    user("inside", {
      named: false,
      base: null,
      origin: null,
      activity: "requires_action",
      name: "Direct",
    }),
  ];
  for (const one of cases) {
    const { worktrees, removals } = repo({
      porcelain: listing(main, record(outer, { branch: "outer" })),
      users: { [outer]: [user("idle"), one] },
    });
    await expect(worktrees.remove(MAIN, outer)).rejects.toThrow(
      `A session is working in this worktree: "${one.name}". Stop it first.`,
    );
    expect(removals()).toEqual([]);
  }
});
