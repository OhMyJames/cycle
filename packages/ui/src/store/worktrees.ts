// A worktree for the blank conversation (docs/desktop.md "Worktree"): whether one is offered, whether it is on, and where
// it starts from.
import type { GitBranches } from "../api.ts";
import type { AppState, BlankConversation } from "./state.ts";

export type BlankWorktree = {
  on: boolean;
  /** The branch it starts from. */
  base: string | undefined;
  branches: GitBranches;
};

/**
 * What the blank conversation offers for a worktree, or undefined when it offers none: a location that is not this
 * computer, a daemon that cannot, a folder that is not in a repository (or not read yet). The switch follows the
 * agent's default until the person moves it; the branch is the remote's default, else the one checked out.
 */
export const blankWorktreeOf = (
  state: AppState,
  blank: BlankConversation,
  agentId: string | undefined,
): BlankWorktree | undefined => {
  const location = state.locations.find((l) => l.id === blank.locationId);
  if (location?.kind !== "local") return undefined;
  if (state.status[blank.locationId]?.capabilities?.worktrees !== true) return undefined;
  const read = blank.branches;
  if (read === undefined || read.value === null) return undefined;
  if (read.locationId !== blank.locationId || read.cwd !== blank.cwd.trim()) return undefined;
  const { branches, current, defaultBranch } = read.value;
  const chosen = blank.worktreeChoice?.base;
  const base =
    chosen !== undefined && (branches.includes(chosen) || chosen === defaultBranch)
      ? chosen
      : (defaultBranch ?? current ?? branches[0]);
  const on =
    blank.worktreeChoice?.on ??
    (agentId !== undefined && (state.preferences?.worktreeAgents ?? []).includes(agentId));
  return { on, base, branches: read.value };
};
