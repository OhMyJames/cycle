import { expect, test } from "bun:test";
import { type WorktreeInfo, workingDir } from "../src/index.ts";

const worktree = (origin: WorktreeInfo["origin"]): WorktreeInfo => ({
  repo: "/repo",
  base: "abc123",
  branch: "cycle/x",
  path: "/repo/.agents/worktree/cycle-x",
  origin,
});

test("a worktree the agent entered is where it works, whatever folder the session began in", () => {
  expect(workingDir({ cwd: "/repo", worktree: worktree("agent") })).toBe(
    "/repo/.agents/worktree/cycle-x",
  );
  expect(workingDir({ cwd: "/repo/pkg", worktree: worktree("agent") })).toBe(
    "/repo/.agents/worktree/cycle-x",
  );
});

test("one made as the session was is the session's own folder, below the root for a subfolder project", () => {
  expect(workingDir({ cwd: "/repo/.agents/worktree/cycle-x", worktree: worktree("owner") })).toBe(
    "/repo/.agents/worktree/cycle-x",
  );
  expect(
    workingDir({ cwd: "/repo/.agents/worktree/cycle-x/pkg", worktree: worktree("owner") }),
  ).toBe("/repo/.agents/worktree/cycle-x/pkg");
});

test("a session with no worktree works in its folder", () => {
  expect(workingDir({ cwd: "/repo/pkg", worktree: null })).toBe("/repo/pkg");
});
