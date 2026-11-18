import { expect, test } from "bun:test";
import {
  mentionProject,
  mentionable,
  searchRoot,
  worktreeFacts,
  worktreeKey,
  worktreeMark,
} from "../src/lib/worktrees.ts";
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

test("a worktree session's @ puts its repository's sessions first: it ranks by project, not by its own folder", () => {
  const sessions = [
    session({ id: "elsewhere", cwd: "/other", updatedAt: 9 }),
    session({ id: "sibling", cwd: "/repo", updatedAt: 1 }),
  ];
  const own = session({ id: "own", cwd: WORKTREE, worktree: worktreeInfo({ origin: "agent" }) });
  const ranked = mentionable(sessions, own.id, mentionProject(own, null));
  expect(ranked.map((each) => each.id)).toEqual(["sibling", "elsewhere"]);
  // Asked with the folder, as the composer did, nothing matches: the fault this fixes.
  expect(mentionable(sessions, own.id, own.cwd).map((each) => each.id)).toEqual([
    "elsewhere",
    "sibling",
  ]);
});

test("a draft ranks by its folder, which is already a project", () => {
  expect(mentionProject(null, { cwd: "/repo" })).toBe("/repo");
  expect(mentionProject(undefined, undefined)).toBe("");
});

test("@ reads files from where the agent works: the entered worktree, else the session's folder, else the draft's", () => {
  const entered = session({ cwd: "/repo", worktree: worktreeInfo({ origin: "agent" }) });
  expect(searchRoot(entered, null)).toBe(WORKTREE);
  // Made as the session was: its folder already is the worktree, or a subfolder inside it.
  const owned = session({ cwd: `${WORKTREE}/pkg`, worktree: worktreeInfo() });
  expect(searchRoot(owned, null)).toBe(`${WORKTREE}/pkg`);
  expect(searchRoot(session({ cwd: "/repo" }), null)).toBe("/repo");
  expect(searchRoot(null, { cwd: "/draft" })).toBe("/draft");
  expect(searchRoot(null, null)).toBe("");
});

test("the list of worktrees is read again when a session enters, leaves or changes its worktree, and not otherwise", () => {
  const plain = session({ id: "a" });
  const inside = session({ id: "b", worktree: worktreeInfo() });
  const before = worktreeKey([plain, inside]);
  expect(worktreeKey([plain, { ...inside, worktree: worktreeInfo({ origin: "agent" }) }])).toBe(
    before,
  );
  expect(worktreeKey([{ ...plain, worktree: worktreeInfo() }, inside])).not.toBe(before);
  expect(worktreeKey([plain])).not.toBe(before);
  expect(worktreeKey([plain, { ...inside, worktree: worktreeInfo({ path: "/x" }) }])).not.toBe(
    before,
  );
  // Nothing else of a session moves it, and the order of the sessions does not.
  const busy = { ...inside, activity: "running" as const, title: "More", updatedAt: 9 };
  expect(worktreeKey([plain, busy])).toBe(before);
  const other = session({ id: "c", worktree: worktreeInfo({ path: "/y" }) });
  expect(worktreeKey([inside, other])).toBe(worktreeKey([other, inside]));
});
