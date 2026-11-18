import { expect, test } from "bun:test";
import type { WorktreeEntry, WorktreeUser } from "@cycle/protocol";
import { describeRemoval, describeWorktree, worktreeUserName } from "../src/lib/worktrees.ts";

function user(patch: Partial<WorktreeUser> = {}): WorktreeUser {
  return { id: "s1", title: "Fix login", preview: "", activity: "idle", archived: false, ...patch };
}

function entry(patch: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: "/repo/.agents/worktree/fix-login",
    branch: "fix-login",
    head: "abc1234",
    base: "main",
    origin: "owner",
    managed: true,
    locked: false,
    missing: false,
    dirty: false,
    sessions: [],
    ...patch,
  };
}

test("a clean worktree Cycle made has no marks and can be removed", () => {
  const view = describeWorktree(entry());
  expect(view.name).toBe("fix-login");
  expect(view.origin).toBe("Made for a session");
  expect(view.marks).toEqual([]);
  expect(view.removal).toEqual({ offered: true, blocked: null });
});

function marks(patch: Partial<WorktreeEntry>): string[] {
  return describeWorktree(entry(patch)).marks.map((mark) => mark.label);
}

test("who made a worktree is said only when a session's record says", () => {
  expect(describeWorktree(entry({ origin: "agent" })).origin).toBe("Entered by an agent");
  expect(describeWorktree(entry({ origin: null })).origin).toBeNull();
});

test("each mark is shown for what is true of the worktree", () => {
  expect(marks({ dirty: true })).toEqual(["Changes"]);
  expect(marks({ locked: true })).toEqual(["Locked"]);
  expect(marks({ missing: true, dirty: null })).toEqual(["Folder missing"]);
  expect(marks({ managed: false })).toEqual(["Not made by Cycle"]);
  // Git could not tell whether it is dirty: that is not a change.
  expect(marks({ dirty: null })).toEqual([]);
});

test("a worktree not made by Cycle is listed and is not offered for removal", () => {
  const view = describeWorktree(entry({ managed: false, origin: null }));
  expect(view.removal.offered).toBe(false);
  expect(view.origin).toBeNull();
});

test("a session working in it, whatever it waits on, blocks removal with the daemon's words", () => {
  for (const activity of ["running", "requires_action"] as const) {
    const view = describeWorktree(entry({ sessions: [user({ activity })] }));
    expect(view.removal).toEqual({
      offered: true,
      blocked: 'A session is working in this worktree: "Fix login". Stop it first.',
    });
    expect(view.users[0]?.label).toBe("Fix login (working)");
  }
});

test("idle and archived sessions do not block removal, and are named", () => {
  const view = describeWorktree(
    entry({
      sessions: [user({ id: "a" }), user({ id: "b", title: "Old", archived: true })],
    }),
  );
  expect(view.removal.blocked).toBeNull();
  expect(view.users).toEqual([
    { id: "a", label: "Fix login" },
    { id: "b", label: "Old (archived)" },
  ]);
});

test("a locked worktree says how to unlock it, and a working session is said first", () => {
  const locked = describeWorktree(entry({ locked: true }));
  expect(locked.removal.blocked).toBe(
    "This worktree is locked. Unlock it with git (git worktree unlock) to remove it.",
  );
  const both = describeWorktree(entry({ locked: true, sessions: [user({ activity: "running" })] }));
  expect(both.removal.blocked).toContain("A session is working");
});

test("the confirmation names the worktree and says only what is lost", () => {
  expect(describeWorktree(entry()).confirmation).toEqual({
    title: "Remove the worktree fix-login?",
    lines: ["The folder is removed. The branch fix-login is kept."],
  });
});

test("the confirmation says uncommitted changes are lost, and who uses the worktree", () => {
  const { lines } = describeWorktree(
    entry({ dirty: true, sessions: [user(), user({ id: "b", title: "Other", archived: true })] }),
  ).confirmation;
  expect(lines).toEqual([
    "The folder is removed. The branch fix-login is kept.",
    "Uncommitted changes in it are lost.",
    "Used by: Fix login, Other (archived). Their conversations stay, but their folder is gone.",
  ]);
});

test("the confirmation does not claim a clean worktree when git could not tell", () => {
  const { lines } = describeWorktree(entry({ dirty: null })).confirmation;
  expect(lines).toContain("Git could not say whether it has uncommitted changes. Any are lost.");
});

test("a worktree whose folder is gone says it only removes git's record", () => {
  const { lines } = describeWorktree(entry({ missing: true, dirty: null })).confirmation;
  expect(lines).toEqual([
    "Its folder is already gone. This removes git's record of it. The branch fix-login is kept.",
  ]);
});

test("a detached worktree is named by its folder, keeps no branch, and loses commits no branch has", () => {
  const view = describeWorktree(entry({ branch: null }));
  expect(view.name).toBe("Detached");
  expect(view.confirmation.title).toBe("Remove the worktree fix-login?");
  expect(view.confirmation.lines).toEqual([
    "The folder is removed.",
    "Commits no branch has are lost with the folder.",
  ]);
});

test("a worktree on a branch is named by the branch, not by its folder", () => {
  const view = describeWorktree(
    entry({ branch: "feature/login", path: "/repo/.agents/worktree/x" }),
  );
  expect(view.confirmation.title).toBe("Remove the worktree feature/login?");
  expect(describeWorktree(entry()).confirmation.lines.join(" ")).not.toContain("Commits no branch");
});

test("the confirmation comes from the worktree as it is now, not as the row showed it", () => {
  const shown = entry({ dirty: false });
  // It has changes now, and a session working in it.
  const now = entry({ dirty: true, sessions: [user({ activity: "running" })] });
  expect(describeRemoval(shown, [shown]).lines).not.toContain(
    "Uncommitted changes in it are lost.",
  );
  expect(describeRemoval(shown, [now]).blocked).toContain("A session is working");
  // Nothing is said to be lost when nothing will be removed.
  expect(describeRemoval(shown, [now]).lines).toEqual([]);
  const changed = describeRemoval(shown, [entry({ dirty: true })]);
  expect(changed.blocked).toBeNull();
  expect(changed.lines).toContain("Uncommitted changes in it are lost.");
});

test("a removal is not offered when the worktree cannot be removed after all, and says why", () => {
  const shown = entry();
  const gone = describeRemoval(shown, [entry({ path: "/repo/.agents/worktree/other" })]);
  expect(gone).toEqual({
    title: "Remove the worktree fix-login?",
    lines: [],
    blocked: "This worktree is not in the list any more.",
  });
  expect(describeRemoval(shown, [entry({ locked: true })]).blocked).toContain("locked");
  expect(describeRemoval(shown, [entry({ managed: false })]).blocked).toBe(
    "Cycle removes only the worktrees it made. Remove this one with git.",
  );
  const failed = describeRemoval(shown, "A worktree needs a git repository.");
  expect(failed.blocked).toBe(
    "Could not read the worktree's state: A worktree needs a git repository.",
  );
  expect(failed.lines).toEqual([]);
});

test("a session with no title is named by the start of its prompt", () => {
  expect(worktreeUserName(user({ title: null, preview: "Add a retry\nto the client" }))).toBe(
    "Add a retry",
  );
  expect(worktreeUserName(user({ title: null, preview: "" }))).toBe("New session");
});
