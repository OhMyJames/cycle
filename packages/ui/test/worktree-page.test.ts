import { expect, test } from "bun:test";
import { mentionable, worktreeFacts, worktreeMark } from "../src/lib/worktrees.ts";
import { WORKTREE, session, worktreeInfo } from "./session-fixture.ts";

test("a row's mark names the branch, and says when the agent entered the worktree", () => {
  expect(worktreeMark(worktreeInfo())).toEqual({
    label: "Worktree fix-login",
    branch: "fix-login",
    byAgent: false,
  });
  expect(worktreeMark(worktreeInfo({ origin: "agent", branch: "cycle/demo" }))).toEqual({
    label: "Worktree cycle/demo, entered by the agent",
    branch: "cycle/demo",
    byAgent: true,
  });
});

test("a session with no worktree has no mark", () => {
  expect(worktreeMark(null)).toBeNull();
});

test("the overview of a session with no worktree says only its folder", () => {
  expect(worktreeFacts(session({ cwd: "/home/me/app" }), "/home/me")).toEqual({
    folder: { text: "~/app", full: "/home/me/app" },
    worktree: null,
    repository: null,
  });
});

test("the overview of a worktree made for a session: its folder, the worktree, and who made it", () => {
  const owned = session({ cwd: WORKTREE, worktree: worktreeInfo() });
  expect(worktreeFacts(owned, undefined)).toEqual({
    folder: { text: WORKTREE, full: WORKTREE },
    worktree: { text: WORKTREE, full: WORKTREE, note: "Made for a session" },
    repository: { text: "/repo", full: "/repo" },
  });
});

test("the overview of a worktree the agent entered: the folder is the worktree, not the folder the session began in", () => {
  const entered = session({ cwd: "/repo", worktree: worktreeInfo({ origin: "agent" }) });
  const facts = worktreeFacts(entered, undefined);
  expect(facts.folder.full).toBe(WORKTREE);
  expect(facts.worktree?.note).toBe("Entered by an agent");
  expect(facts.repository?.full).toBe("/repo");
});

test("a project that is a subfolder keeps its subfolder as the folder, and the worktree's root as the worktree", () => {
  const sub = `${WORKTREE}/pkg/web`;
  const owned = session({ cwd: sub, worktree: worktreeInfo() });
  const facts = worktreeFacts(owned, undefined);
  expect(facts.folder.full).toBe(sub);
  expect(facts.worktree?.full).toBe(WORKTREE);
});

test("a long path is shortened from the front, with the whole one kept for the tip", () => {
  const long = `/home/me/work/some/deep/folder/.agents/worktree/a-very-long-branch-name`;
  const facts = worktreeFacts(
    session({ cwd: long, worktree: worktreeInfo({ path: long }) }),
    "/home/me",
  );
  expect(facts.worktree?.text.startsWith("…")).toBe(true);
  expect(facts.worktree?.full).toBe(long);
});

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
