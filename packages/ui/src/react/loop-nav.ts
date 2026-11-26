/** Where the Loop page is: three levels, the Loop overview, a Project, and one of its tickets. */
export type LoopView =
  | { at: "overview" }
  | { at: "project"; projectKey: string; tab: "kanban" | "overview" }
  | { at: "ticket"; projectKey: string; identifier: string };

/**
 * One level up (Escape, Back): ticket → board → Loop overview → out of the Loop (undefined). The overview page does not
 * exist yet, so the board's parent is leaving the Loop until it does.
 */
export function up(view: LoopView): LoopView | undefined {
  if (view.at === "ticket") return { at: "project", projectKey: view.projectKey, tab: "kanban" };
  return undefined;
}

/** Where entering the Loop lands: where it was left, else the overview. */
export function enter(last: LoopView | undefined): LoopView {
  return last ?? { at: "overview" };
}

/** The Project a view is in, if it is in one. */
export function viewProject(view: LoopView): string | undefined {
  return view.at === "overview" ? undefined : view.projectKey;
}
