/*
 * What the daemon decides when Claude Code enters a worktree: whether the name its model chose may
 * become a branch and a folder, and where the agent is, against the worktree Cycle made for it.
 * Pure, so each rule is tested alone.
 */

/** Longest a name may be: it becomes a branch and the folder of a worktree. */
const MAX_NAME = 64;

/**
 * Why a name the model chose may not be a worktree's, in words it reads, or null. It is hostile
 * until proven otherwise: the harness lets through a leading `-` or `.`, `x.lock`, `a/.b` and `a.`,
 * which git refuses with its own stderr. The daemon refuses each itself, before git or a folder is
 * touched. Whatever passes becomes the branch `cycle/<name>`, whose prefix no option begins with,
 * and a folder named by `branchSlug`, which has no `/` or `..` in it.
 */
export function worktreeNameProblem(name: string): string | null {
  if (name === "" || name.length > MAX_NAME || !/^[A-Za-z0-9._/-]+$/.test(name)) {
    return "A worktree's name is letters, digits, dots, dashes and slashes, 64 at most.";
  }
  if (name.startsWith("-")) return "A worktree's name does not begin with a dash.";
  for (const part of name.split("/")) {
    if (part === "") return "A worktree's name has no empty part between slashes.";
    if (part.startsWith(".")) return "No part of a worktree's name begins with a dot.";
    if (part.endsWith(".") || part.endsWith(".lock")) {
      return "No part of a worktree's name ends with a dot or in .lock.";
    }
    if (part.includes("..")) return "A worktree's name has no two dots in a row.";
  }
  return null;
}

/** Whether `path` is `folder` or below it, by whole parts: `/a/bc` is not inside `/a/b`. */
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

/** Where a session's agent-made worktree is, and the session's own folder: all of them real paths. */
export interface Placement {
  /** The worktree's root. */
  path: string;
  /** The main checkout the worktree is of. */
  repo: string;
  /** The session's own folder, which its agent's record is keyed by. */
  cwd: string;
}

/**
 * Where the agent said it works (`at`) against the worktree Cycle made for it:
 * - `in`: in the worktree, or a folder inside it. Nothing changes.
 * - `left`: back in the session's own folder or one inside it. Every worktree is inside its
 *   repository, so being inside `cwd` alone proves nothing: the worktrees' folder, and Claude
 *   Code's own under `.claude/worktrees`, are not "back".
 * - `elsewhere`: a folder Cycle made nothing of. Another `WorktreeCreate` hook (the owner's, which
 *   runs beside Cycle's and whose path wins) is the likely cause.
 */
export function placeOf(at: string, own: Placement): "in" | "left" | "elsewhere" {
  if (isWithin(at, own.path)) return "in";
  const apart =
    !isWithin(at, `${own.repo}/.agents/worktree`) && !isWithin(at, `${own.repo}/.claude/worktrees`);
  return isWithin(at, own.cwd) && apart ? "left" : "elsewhere";
}
