import type { Session, WorktreeEntry, WorktreeUser } from "@cycle/protocol";
import { basename } from "./format.ts";
import { plainMentions } from "./suggest.ts";

/** The folder a session belongs to in the list: its repository, not its worktree. */
export function projectOf(info: Session): string {
  return info.worktree?.repo ?? info.cwd;
}

/**
 * The sessions an `@` can mention, those of `folder` first, each group newest first. A session is
 * of a folder by its project, so `folder` is a project, never a worktree's own path.
 */
export function mentionable(
  sessions: readonly Session[],
  except: string | null,
  folder: string,
): Session[] {
  return sessions
    .filter((other) => other.id !== except && !other.archived)
    .toSorted(
      (a, b) =>
        Number(projectOf(b) === folder) - Number(projectOf(a) === folder) ||
        b.updatedAt - a.updatedAt,
    );
}

/** What removing a worktree loses, in one place for the list's confirmation and the delete dialog. */
const LOST = {
  dirty: "Uncommitted changes in it are lost.",
  unknown: "Git could not say whether it has uncommitted changes. Any are lost.",
  missing: "Its folder is already gone. This removes git's record of it.",
  noBranch: "Commits no branch has are lost with the folder.",
} as const;

const LOCKED = "This worktree is locked. Unlock it with git (git worktree unlock) to remove it.";

/** Who made a worktree, said the same wherever it is shown. */
export function originNote(origin: WorktreeEntry["origin"]): string | null {
  return origin === "owner"
    ? "Made for a session"
    : origin === "agent"
      ? "Entered by an agent"
      : null;
}

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
      ? LOCKED
      : null;

  const kept = entry.branch ? ` The branch ${entry.branch} is kept.` : "";
  const lines = [entry.missing ? `${LOST.missing}${kept}` : `The folder is removed.${kept}`];
  if (entry.branch === null) lines.push(LOST.noBranch);
  if (entry.dirty) lines.push(LOST.dirty);
  else if (entry.dirty === null && !entry.missing) lines.push(LOST.unknown);
  if (users.length) {
    lines.push(
      `Used by: ${users.map((user) => user.label).join(", ")}. Their conversations stay, but their folder is gone.`,
    );
  }

  return {
    name: entry.branch ?? "Detached",
    origin: originNote(entry.origin),
    marks,
    users,
    removal: { offered: entry.managed, blocked },
    confirmation: {
      title: `Remove the worktree ${entry.branch ?? basename(entry.path)}?`,
      lines,
    },
  };
}

/** What the confirmation shows, from a list read as it opened. */
export interface RemovalAsked {
  title: string;
  /** What is lost. Empty when the worktree is not to be removed after all. */
  lines: string[];
  /** Why Remove is not offered, or null when it is. */
  blocked: string | null;
}

/**
 * The confirmation of a removal, made from the worktree as it is when the dialog opens, not as the
 * list showed it earlier: it may have changes now, or a session working in it, or be gone. `read`
 * is the list just read, or what went wrong reading it. `shown` is the row the owner pressed, which
 * only names the worktree when it is no longer there.
 */
export function describeRemoval(
  shown: WorktreeEntry,
  read: WorktreeEntry[] | string,
): RemovalAsked {
  const named = `Remove the worktree ${shown.branch ?? basename(shown.path)}?`;
  if (typeof read === "string") {
    return { title: named, lines: [], blocked: `Could not read the worktree's state: ${read}` };
  }
  const now = read.find((entry) => entry.path === shown.path);
  if (!now) {
    return { title: named, lines: [], blocked: "This worktree is not in the list any more." };
  }
  const view = describeWorktree(now);
  const blocked =
    view.removal.blocked ??
    (view.removal.offered
      ? null
      : "Cycle removes only the worktrees it made. Remove this one with git.");
  return { title: view.confirmation.title, lines: blocked ? [] : view.confirmation.lines, blocked };
}

/** The box "Also remove its worktree folder" of the dialog that deletes a session. */
export interface WorktreeBox {
  /** Whether the owner can check it. Only an offered box is ever sent as `removeWorktree`. */
  state: "checking" | "offered" | "refused";
  label: string;
  /** What is lost, when it is offered: only what is true of the worktree. */
  lines: string[];
  /** Why it is not offered. */
  why: string | null;
}

/**
 * What the dialog that deletes a session offers of its worktree, made from `worktree.list` read as
 * the dialog opened (null while it is being read; a string when it failed). It never offers what the
 * daemon would refuse (`SessionHub.remove`): a session working in the worktree, or any other that
 * uses it, which is stricter than the daemon in one case, a session only inside the folder, whose
 * wire record does not say whether it names the worktree. The daemon stays the authority: a list
 * that cannot be read, or has no such worktree, gives the box as it always was.
 */
export function describeSessionDelete(
  info: Pick<Session, "id" | "worktree">,
  read: WorktreeEntry[] | string | null,
): WorktreeBox | null {
  const { worktree } = info;
  if (!worktree) return null;
  const label = `Also remove its worktree folder (the branch ${worktree.branch} is kept)`;
  if (read === null) {
    return { state: "checking", label: "Checking its worktree…", lines: [], why: null };
  }
  const now = typeof read === "string" ? undefined : read.find((one) => one.path === worktree.path);
  if (!now) return { state: "offered", label, lines: [], why: null };
  const refused = (why: string): WorktreeBox => ({ state: "refused", label, lines: [], why });
  const others = now.sessions.filter((user) => user.id !== info.id);
  const working = others.find((user) => user.activity !== "idle");
  if (working) {
    return refused(
      `A session is working in this worktree: "${worktreeUserName(working)}". Stop it first, or delete without removing the worktree.`,
    );
  }
  const [shared] = others;
  if (shared) {
    return refused(
      `Another session uses this worktree: "${worktreeUserName(shared)}". Delete without removing the worktree, or delete that one first.`,
    );
  }
  if (now.locked) return refused(LOCKED);
  const lines: string[] = [];
  if (now.dirty) lines.push(LOST.dirty);
  else if (now.dirty === null && !now.missing) lines.push(LOST.unknown);
  if (now.missing) lines.push(LOST.missing);
  if (now.branch === null) lines.push(LOST.noBranch);
  return { state: "offered", label, lines, why: null };
}
