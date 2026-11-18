import type { Session } from "./model.ts";

/** A folder as a session's agent knows it, and as this machine does. */
export interface FolderIn {
  /** The path on this machine. */
  cwd: string;
  /** Where a sandbox sees that folder, when it sees it somewhere else. */
  sandboxCwd: string | null;
}

/**
 * Where a path an agent said points on this machine. A sandbox names the folder its own way, so
 * a file its tools touched is opened here at the same file, not at a path that is not here.
 */
export function toMachinePath(path: string, folder: FolderIn): string {
  const inside = folder.sandboxCwd;
  if (!inside || !folder.cwd) return path;
  if (path !== inside && !path.startsWith(`${inside}/`)) return path;
  return `${folder.cwd}${path.slice(inside.length)}`;
}

/**
 * The folder a session's agent works in now, which the page's files, terminal and changes read. A
 * worktree the agent entered is its own root. One made as the session was is the folder the session
 * starts in already: for a project that is a subfolder, `cwd` is below the worktree's root, and
 * `path` would take the panels up out of it.
 */
export function workingDir(session: Pick<Session, "cwd" | "worktree">): string {
  return session.worktree?.origin === "agent" ? session.worktree.path : session.cwd;
}
