import type { Session, WorktreeEntry, WorktreeInfo, WorktreeUser } from "@cycle/protocol";

/** A session as the page holds it, with only what a test names changed. */
export function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s1",
    harness: "claude",
    title: "Fix login",
    preview: "",
    cwd: "/repo",
    model: "m",
    effort: null,
    mode: "auto",
    activity: "idle",
    loaded: true,
    failed: false,
    branch: null,
    worktree: null,
    environment: null,
    sandboxCwd: null,
    directories: [],
    createdAt: 0,
    updatedAt: 1000,
    archived: false,
    pinned: false,
    unread: false,
    forkedFrom: null,
    scheduleId: null,
    ...patch,
  };
}

export const WORKTREE = "/repo/.agents/worktree/fix-login";

/** A session's record of a worktree made as it was, or entered by its agent. */
export function worktreeInfo(patch: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    repo: "/repo",
    base: "abc1234",
    branch: "fix-login",
    path: WORKTREE,
    origin: "owner",
    ...patch,
  };
}

export function user(patch: Partial<WorktreeUser> = {}): WorktreeUser {
  return { id: "s2", title: "Other", preview: "", activity: "idle", archived: false, ...patch };
}

/** What `worktree.list` answers for a clean worktree Cycle made. */
export function entry(patch: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: WORKTREE,
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
