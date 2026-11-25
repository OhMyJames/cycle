import type { Config, Issue, Priority } from "./types.ts";

const RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * The one work item to take: in the `Todo` column AND carrying the `auto` label, highest priority first, then oldest.
 * The tracker is asked for the `Todo` column, but this checks both again: a work item that is not both is never
 * touched, whatever the tracker hands back.
 */
export const pickNext = (
  issues: Issue[],
  config: Pick<Config, "columns" | "autoLabelId">,
): Issue | undefined => {
  const eligible = issues.filter(
    (issue) =>
      issue.columnId === config.columns.todo && issue.labelIds.includes(config.autoLabelId),
  );
  eligible.sort(
    (a, b) =>
      (a.priority === null ? 4 : RANK[a.priority]) - (b.priority === null ? 4 : RANK[b.priority]) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.number - b.number,
  );
  return eligible[0];
};
