import type { Config, Issue, Priority } from "./types.ts";

const RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * The one work item to take: in the `Todo` column, carrying the `auto` label, matching a configured type id (e.g.
 * Feature or Bug), and a leaf (no subtasks), and not blocked by an unfinished issue (a blocker outside Done and Canceled, or unknown
 * links, keeps it in Todo); highest priority first, then oldest.
 * The tracker is asked for the `Todo` column, but this checks every condition again: a work item that does not meet
 * all of them is never touched, whatever the tracker hands back.
 */
export const pickNext = (
  issues: Issue[],
  config: Pick<Config, "columns" | "autoLabelId" | "allowedTypeIds">,
): Issue | undefined => {
  const eligible = issues.filter(
    (issue) =>
      issue.columnId === config.columns.todo &&
      issue.labelIds.includes(config.autoLabelId) &&
      issue.typeId !== null &&
      config.allowedTypeIds.includes(issue.typeId) &&
      issue.subtaskCount === 0 &&
      issue.blockerColumnIds?.every(
        (c) => c === config.columns.done || c === config.columns.canceled,
      ),
  );
  eligible.sort(
    (a, b) =>
      (a.priority === null ? 4 : RANK[a.priority]) - (b.priority === null ? 4 : RANK[b.priority]) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.number - b.number,
  );
  return eligible[0];
};
