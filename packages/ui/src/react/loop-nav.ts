/** Where the Loop page is: three levels, the Loop overview, a Project, and one of its tickets. */
export type LoopView =
  /** `landing`: just entered with nowhere remembered; the page sends it to the board when there is only one Project. */
  | { at: "overview"; landing?: true }
  | { at: "project"; projectKey: string; tab: "kanban" | "overview" }
  | { at: "ticket"; projectKey: string; identifier: string };

/**
 * One level up (Escape on a ticket's drawer): ticket → board. Nothing from a board or the overview: Escape does not move
 * between them or leave the Loop; the sidebar does (CYC-500).
 */
export function up(view: LoopView): LoopView | undefined {
  if (view.at === "ticket") return { at: "project", projectKey: view.projectKey, tab: "kanban" };
  return undefined;
}

/** Where entering the Loop lands: where it was left, else the overview (or the only Project's board: see `landing`). */
export function enter(last: LoopView | undefined): LoopView {
  return last ?? { at: "overview", landing: true };
}

/** The Project a view is in, if it is in one. */
export function viewProject(view: LoopView): string | undefined {
  return view.at === "overview" ? undefined : view.projectKey;
}
