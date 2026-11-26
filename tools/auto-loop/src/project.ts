// Resolves what used to be hardcoded for infra.CYC (columns, the `auto` label, issue type ids) from the tracker's
// `get_project` reply (CYC-392). Columns are chosen by stateType, never by name; when a stateType has several columns
// they are taken in board order (`position`): Todo is the first `unstarted`; In Progress, In Review and Blocked are
// the first, second and third `started`.

import type { Config } from "./types.ts";

export type ProjectSetup = Pick<
  Config,
  "columns" | "autoLabelId" | "allowedTypeIds" | "featureTypeId" | "bugTypeId"
>;

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

export const resolveProject = (
  reply: unknown,
  names: { projectKey: string; autoLabel: string; featureType: string; bugType: string },
): ProjectSetup => {
  const body = rec(reply);
  const data = rec(body.data ?? body);
  const columns = list(data.columns).sort((a, b) => Number(a.position) - Number(b.position));
  const of = (stateType: string) =>
    columns.filter((c) => c.stateType === stateType).map((c) => Number(c.id));
  const pick = (stateType: string, nth: number, role: string): number => {
    const id = of(stateType)[nth];
    if (id === undefined || !Number.isInteger(id))
      throw new Error(
        `project ${names.projectKey}: no ${role} column (needs the ${nth + 1}th column with stateType ${stateType})`,
      );
    return id;
  };
  const byName = (rows: unknown, name: string, what: string): number => {
    const found = list(rows).find((r) => String(r.name).toLowerCase() === name.toLowerCase());
    const id = Number(found?.id);
    if (found === undefined || !Number.isInteger(id))
      throw new Error(`project ${names.projectKey}: no ${what} named "${name}"`);
    return id;
  };
  const featureTypeId = byName(data.issueTypes, names.featureType, "issue type");
  const bugTypeId = byName(data.issueTypes, names.bugType, "issue type");
  return {
    columns: {
      todo: pick("unstarted", 0, "todo"),
      inProgress: pick("started", 0, "in-progress"),
      inReview: pick("started", 1, "in-review"),
      blocked: pick("started", 2, "blocked"),
      done: pick("completed", 0, "done"),
      canceled: pick("canceled", 0, "canceled"),
    },
    autoLabelId: byName(data.labels, names.autoLabel, "label"),
    allowedTypeIds: [...new Set([featureTypeId, bugTypeId])],
    featureTypeId,
    bugTypeId,
  };
};
