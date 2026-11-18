import type { WorktreeEntry, WorktreeUser } from "@cycle/protocol";
import { basename } from "./format.ts";
import { plainMentions } from "./suggest.ts";

/** What a session that uses a worktree is called: its title, else the start of its first prompt. */
export function worktreeUserName(user: WorktreeUser): string {
  return user.title || plainMentions(user.preview).split("\n")[0]?.slice(0, 80) || "New session";
}

export interface WorktreeMark {
  label: string;
  /** `warning` is what the owner should look at, `error` what is broken; `muted` is only a fact. */
  tone: "warning" | "error" | "muted";
}

export interface WorktreeView {
  /** What the row is called: its branch, or "Detached". */
  name: string;
  /** Who made it, as a note, when a session's record says. */
  origin: string | null;
  marks: WorktreeMark[];
  users: { id: string; label: string }[];
  /**
   * Whether the list offers Remove at all (only worktrees Cycle made), and why it is not to be
   * pressed now. The daemon refuses the same cases, with the same words.
   */
  removal: { offered: boolean; blocked: string | null };
  /** What the confirmation says. Its lines are only what is true of this worktree. */
  confirmation: { title: string; lines: string[] };
}

/**
 * Everything the page says about a worktree, decided in one place: its marks, whether it can be
 * removed and why not, and what removing it loses.
 */
export function describeWorktree(entry: WorktreeEntry): WorktreeView {
  const marks: WorktreeMark[] = [];
  if (entry.dirty) marks.push({ label: "Changes", tone: "warning" });
  if (entry.locked) marks.push({ label: "Locked", tone: "muted" });
  if (entry.missing) marks.push({ label: "Folder missing", tone: "error" });
  if (!entry.managed) marks.push({ label: "Not made by Cycle", tone: "muted" });

  const users = entry.sessions.map((user) => {
    const name = worktreeUserName(user);
    const notes = [user.activity !== "idle" ? "working" : null, user.archived ? "archived" : null];
    const note = notes.filter(Boolean).join(", ");
    return { id: user.id, label: note ? `${name} (${note})` : name };
  });

  const working = entry.sessions.find((user) => user.activity !== "idle");
  const blocked = working
    ? `A session is working in this worktree: "${worktreeUserName(working)}". Stop it first.`
    : entry.locked
      ? "This worktree is locked. Unlock it with git (git worktree unlock) to remove it."
      : null;

  const kept = entry.branch ? ` The branch ${entry.branch} is kept.` : "";
  const lines = [
    entry.missing
      ? `Its folder is already gone. This removes git's record of it.${kept}`
      : `The folder is removed.${kept}`,
  ];
  if (entry.dirty) lines.push("Uncommitted changes in it are lost.");
  else if (entry.dirty === null && !entry.missing) {
    lines.push("Git could not say whether it has uncommitted changes. Any are lost.");
  }
  if (users.length) {
    lines.push(
      `Used by: ${users.map((user) => user.label).join(", ")}. Their conversations stay, but their folder is gone.`,
    );
  }

  return {
    name: entry.branch ?? "Detached",
    origin:
      entry.origin === "owner"
        ? "Made for a session"
        : entry.origin === "agent"
          ? "Entered by an agent"
          : null,
    marks,
    users,
    removal: { offered: entry.managed, blocked },
    confirmation: {
      title: `Remove the worktree ${entry.branch ?? basename(entry.path)}?`,
      lines,
    },
  };
}
