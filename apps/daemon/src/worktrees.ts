import type { WorktreeEntry } from "@cycle/protocol";
import { type Git, GitError, type ListedWorktree } from "./git.ts";
import { SessionError, type WorktreeUser } from "./sessions.ts";

/** Where a repository's worktrees are, relative to its main checkout. */
const WORKTREES = ".agents/worktree";

export interface WorktreesOptions {
  git: Git;
  /** The sessions that name a worktree or are in it: the hub's. */
  users(path: string): WorktreeUser[];
  /** Where older daemons made worktrees. */
  legacyWorktrees: string;
}

/** Whether `path` is inside `folder`, by its words: no `.` or `..` can lead out of it. */
function isInside(folder: string, path: string): boolean {
  if (!path.startsWith(`${folder}/`)) return false;
  return path
    .slice(folder.length + 1)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * The owner's view of a repository's worktrees, and their removal. The decisions are here; git and
 * the sessions come through ports.
 *
 * Which worktrees there are is git's own list, read again at each call. Cycle removes only the ones
 * under `<main checkout>/.agents/worktree/` or the older place: the rest, made by hand or by an
 * agent's own tool, are listed and left to git.
 */
export class Worktrees {
  private readonly options: WorktreesOptions;

  constructor(options: WorktreesOptions) {
    this.options = options;
  }

  /**
   * The worktrees of the repository `workspace` is in. It runs one `git worktree list`, and a
   * `test -e` and a `git status` for each worktree: a handful, for one owner.
   */
  async list(workspace: string): Promise<{ workspace: string; worktrees: WorktreeEntry[] }> {
    const { main, linked } = await this.read(workspace);
    const entries = await Promise.all(
      linked.map(async (worktree): Promise<WorktreeEntry> => {
        const missing = !(await this.options.git.exists(main, worktree.path));
        const dirty = missing ? null : await this.options.git.dirty(worktree.path);
        const users = this.options.users(worktree.path);
        const record = users.find((user) => user.named);
        return {
          path: worktree.path,
          branch: worktree.branch,
          head: worktree.head,
          base: record?.base ?? null,
          origin: record?.origin ?? null,
          managed: this.managed(main, worktree.path),
          locked: worktree.locked,
          missing,
          dirty,
          sessions: users.map((user) => ({
            id: user.id,
            title: user.title,
            preview: user.preview,
            activity: user.activity,
            archived: user.archived,
          })),
        };
      }),
    );
    entries.sort(
      (a, b) =>
        Number(b.managed) - Number(a.managed) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    return { workspace: main, worktrees: entries };
  }

  /**
   * Removes a worktree's folder, keeping its branch, or refuses before changing anything: `path`
   * must be, character for character, one that git lists for the repository, and one Cycle made,
   * not locked, and no session working in it. Uncommitted work goes with it: the caller confirmed.
   * The rules are asked again inside the repository's lock, right before git runs.
   */
  async remove(workspace: string, path: string): Promise<void> {
    const { main, linked } = await this.read(workspace);
    this.allow(main, linked, path);
    await this.options.git.removeWorktree(main, path, async () => {
      const again = await this.read(main);
      this.allow(again.main, again.linked, path);
    });
  }

  /** The repository's main checkout and the linked worktrees git lists for it. */
  private async read(workspace: string): Promise<{ main: string; linked: ListedWorktree[] }> {
    const listed = await this.options.git.worktrees(workspace);
    const first = listed[0];
    if (!first) throw new GitError("A worktree needs a git repository.");
    if (first.bare) throw new GitError("A worktree needs a git checkout.");
    return { main: first.path, linked: listed.slice(1).filter((worktree) => !worktree.bare) };
  }

  private managed(main: string, path: string): boolean {
    return isInside(`${main}/${WORKTREES}`, path) || isInside(this.options.legacyWorktrees, path);
  }

  /** Throws unless `path` may be removed. */
  private allow(main: string, linked: ListedWorktree[], path: string): void {
    const worktree = linked.find((one) => one.path === path);
    if (!worktree) throw new GitError("That folder is not a worktree of this repository.");
    if (!this.managed(main, path)) {
      throw new GitError("Cycle removes only the worktrees it made. Remove this one with git.");
    }
    const busy = this.options.users(path).find((user) => user.activity !== "idle");
    if (busy) {
      throw new SessionError(
        `A session is working in this worktree: "${busy.name}". Stop it first.`,
      );
    }
    if (worktree.locked) {
      throw new GitError(
        "This worktree is locked. Unlock it with git (git worktree unlock) to remove it.",
      );
    }
  }
}
