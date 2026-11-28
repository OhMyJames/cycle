import type { LoopProjectInfo } from "../api.ts";

/** Project-level views mounted under a Loop-backed workspace in the sidebar (CYC-533). */
export type LoopProjectTab = "kanban" | "timeline";

/** Where the Loop page is: the cross-project overview, one Project's tab (Kanban / Timeline), or a ticket drawer. */
export type LoopView =
  | { at: "overview" }
  | { at: "project"; projectKey: string; tab: LoopProjectTab }
  | { at: "ticket"; projectKey: string; identifier: string };

/**
 * One level up (Escape on a ticket's drawer): ticket → board. Nothing from a board, timeline or the overview: Escape
 * does not move between them or leave the Loop; the sidebar does.
 */
export function up(view: LoopView): LoopView | undefined {
  if (view.at === "ticket") return { at: "project", projectKey: view.projectKey, tab: "kanban" };
  return undefined;
}

/** The Project a view is in, if it is in one. */
export function viewProject(view: LoopView): string | undefined {
  return view.at === "overview" ? undefined : view.projectKey;
}

/** Matches a local workspace's normalised `owner/name` repo against the Loop server's Projects (case-insensitive). */
export function matchLoopProject(
  projects: readonly LoopProjectInfo[],
  repoDisplayName: string | null | undefined,
): LoopProjectInfo | undefined {
  if (repoDisplayName == null || repoDisplayName === "") return undefined;
  const target = repoDisplayName.toLowerCase();
  return projects.find((p) => p.repo.displayName.toLowerCase() === target);
}
