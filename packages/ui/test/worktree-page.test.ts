import { expect, test } from "bun:test";
import { mentionable } from "../src/lib/worktrees.ts";
import { WORKTREE, session, worktreeInfo } from "./session-fixture.ts";

test("an @ lists the sessions of a folder first, newest first, and leaves out its own and archived ones", () => {
  const sessions = [
    session({ id: "elsewhere", cwd: "/other", updatedAt: 9 }),
    session({ id: "old", cwd: "/repo", updatedAt: 1 }),
    session({ id: "new", cwd: "/repo", updatedAt: 5 }),
    session({ id: "self", cwd: "/repo", updatedAt: 7 }),
    session({ id: "archived", cwd: "/repo", archived: true }),
  ];
  expect(mentionable(sessions, "self", "/repo").map((each) => each.id)).toEqual([
    "new",
    "old",
    "elsewhere",
  ]);
});

test("a worktree session's own folder is not its project, so the ranking asked with it finds no sessions of the repository first", () => {
  // The fault this pins (`composer.tsx` asked with the session's `cwd`): the repository's sessions
  // are of project "/repo", a worktree session's `cwd` is its worktree's folder, and they never match.
  const sessions = [
    session({ id: "elsewhere", cwd: "/other", updatedAt: 9 }),
    session({ id: "sibling", cwd: "/repo", updatedAt: 1 }),
  ];
  const own = session({ id: "own", cwd: WORKTREE, worktree: worktreeInfo() });
  expect(mentionable(sessions, own.id, own.cwd).map((each) => each.id)).toEqual([
    "elsewhere",
    "sibling",
  ]);
});
