import { expect, test } from "bun:test";
import type { WorktreeEntry, WorktreeUser } from "@cycle/protocol";
import { type WorktreeBox, describeSessionDelete } from "../src/lib/worktrees.ts";
import { entry, session, user, worktreeInfo } from "./session-fixture.ts";

// The words of `session.delete`'s two refusals, copied from the daemon (`SessionHub.remove`), which
// pins them as the same literals in `apps/daemon/test/worktree-users.test.ts`. A change of one is a
// change of both. The quoted name is the page's own (`worktreeUserName`), not the daemon's.
const uses = (name: string) =>
  `Another session uses this worktree: "${name}". Delete without removing the worktree, or delete that one first.`;
const working = (name: string) =>
  `A session is working in this worktree: "${name}". Stop it first, or delete without removing the worktree.`;
const LABEL = "Also remove its worktree folder (the branch fix-login is kept)";

const mine = session({ id: "me", worktree: worktreeInfo() });
const self = user({ id: "me", title: "Fix login" });
const read = (patch: Partial<WorktreeEntry> = {}) => [entry({ sessions: [self], ...patch })];
const box = (patch: Partial<WorktreeEntry> = {}) => describeSessionDelete(mine, read(patch));
const lines = (patch: Partial<WorktreeEntry>) => box(patch)?.lines;
const named = (patch: Partial<WorktreeUser>) =>
  box({ sessions: [self, user({ id: "o", ...patch })] })?.why;

test("a session with no worktree has no box", () => {
  expect(describeSessionDelete(session(), [])).toBeNull();
  expect(describeSessionDelete(session(), null)).toBeNull();
});

test("while the worktree is being read the box waits, disabled, and says so", () => {
  expect(describeSessionDelete(mine, null)).toEqual({
    state: "checking",
    label: "Checking its worktree…",
    lines: [],
    why: null,
  });
});

test("a worktree only this session uses is offered as it always was, with nothing more to say", () => {
  expect(box()).toEqual({ state: "offered", label: LABEL, lines: [], why: null });
});

test("a session working in the worktree refuses the box, in the daemon's words", () => {
  for (const activity of ["running", "requires_action"] as const) {
    const other = user({ id: "o", title: "Run the build", activity });
    expect(box({ sessions: [self, other] })).toMatchObject({
      state: "refused",
      why: working("Run the build"),
    });
  }
});

test("another session that uses it, idle, archived or a fork's, refuses the box", () => {
  for (const archived of [false, true]) {
    const other = user({ id: "o", title: "The fork", archived });
    expect(box({ sessions: [self, other] })).toMatchObject({
      state: "refused",
      why: uses("The fork"),
    });
  }
});

test("a session working wins over an idle one in the words, whichever is listed first", () => {
  const idle = user({ id: "a", title: "Idle one", archived: true });
  const busy = user({ id: "b", title: "Busy one", activity: "running" });
  for (const sessions of [
    [self, idle, busy],
    [busy, self, idle],
  ]) {
    expect(box({ sessions })).toMatchObject({ why: working("Busy one") });
  }
});

test("a session is named by its title, else the start of its first prompt, else New session", () => {
  expect(named({ title: null, preview: "Please look at the failing test\nmore" })).toBe(
    uses("Please look at the failing test"),
  );
  expect(named({ title: null, preview: "" })).toBe(uses("New session"));
});

test("the session itself in the list is ignored, and a list without it is no different", () => {
  expect(box({ sessions: [self] })?.state).toBe("offered");
  expect(box({ sessions: [] })?.state).toBe("offered");
});

test("a locked worktree refuses the box and says how to unlock it, and a working session still comes first", () => {
  expect(box({ locked: true })).toMatchObject({
    state: "refused",
    why: "This worktree is locked. Unlock it with git (git worktree unlock) to remove it.",
  });
  const busy = user({ id: "b", title: "Busy", activity: "running" });
  expect(box({ locked: true, sessions: [self, busy] })?.why).toBe(working("Busy"));
});

test("an offered box says what is lost, and only what is true", () => {
  expect(lines({ dirty: true })).toEqual(["Uncommitted changes in it are lost."]);
  expect(lines({ dirty: null })).toEqual([
    "Git could not say whether it has uncommitted changes. Any are lost.",
  ]);
  expect(lines({ dirty: null, missing: true })).toEqual([
    "Its folder is already gone. This removes git's record of it.",
  ]);
  expect(lines({ branch: null })).toEqual(["Commits no branch has are lost with the folder."]);
  expect(lines({ dirty: true, branch: null })).toEqual([
    "Uncommitted changes in it are lost.",
    "Commits no branch has are lost with the folder.",
  ]);
  expect(lines({ dirty: false })).toEqual([]);
});

test("a list that failed, or has no such worktree, gives the box as it always was: the daemon decides", () => {
  const asis: WorktreeBox = { state: "offered", label: LABEL, lines: [], why: null };
  expect(describeSessionDelete(mine, "Could not reach the daemon")).toEqual(asis);
  expect(describeSessionDelete(mine, [])).toEqual(asis);
  const elsewhere = entry({ path: "/repo/.agents/worktree/other", sessions: [self, user()] });
  expect(describeSessionDelete(mine, [elsewhere])).toEqual(asis);
});

test("a source whose fork is gone is offered the box; while the fork is there it is not", () => {
  const source = session({ id: "src", worktree: worktreeInfo() });
  const fork = user({ id: "fork", title: "Fork" });
  const both = [entry({ sessions: [user({ id: "src" }), fork] })];
  expect(describeSessionDelete(source, both)?.state).toBe("refused");
  const alone = [entry({ sessions: [user({ id: "src" })] })];
  expect(describeSessionDelete(source, alone)?.state).toBe("offered");
});

test("the box is offered only where the daemon would let the worktree go", () => {
  // Every combination: the daemon removes a worktree only when no other session is working in it
  // or names it, and git refuses a locked one. The box must never be offered where it would not.
  const others: WorktreeUser[][] = [
    [],
    [user({ id: "o" })],
    [user({ id: "o", archived: true })],
    [user({ id: "o", activity: "running" })],
    [user({ id: "o", activity: "requires_action", archived: true })],
  ];
  let offered = 0;
  for (const sessions of others) {
    for (const locked of [false, true]) {
      for (const missing of [false, true]) {
        for (const dirty of [false, true, null]) {
          const result = box({ sessions: [self, ...sessions], locked, missing, dirty });
          if (result?.state !== "offered") continue;
          offered++;
          expect(sessions).toEqual([]);
          expect(locked).toBe(false);
        }
      }
    }
  }
  // The combinations that stay offered are the ones with nobody else and no lock: not an empty test.
  expect(offered).toBe(6);
});
