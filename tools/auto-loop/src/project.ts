// Resolves what used to be hardcoded for infra.CYC (columns, the `auto` label, issue type ids) from the tracker's
// `get_project` reply (CYC-392). Columns are chosen by stateType, never by name; when a stateType has several columns
// they are taken in board order (`position`): Todo is the first `unstarted`; In Progress, In Review and Blocked are
// the first, second and third `started`.

import type { Config, LoopPhase } from "./types.ts";

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

/** The phases the loop mirrors onto a work item, and the option name each one has in the project's select field. */
export const LOOP_PHASES = {
  dev: "开发",
  verify: "验证",
  qa: "QA",
  ci: "等 CI",
  review: "评审",
  merge: "等合并",
} as const satisfies Record<LoopPhase, string>;

export const PHASE_FIELD = "Loop 阶段";
export const STARTED_FIELD = "Loop 阶段开始于";

export type LoopFields = {
  phaseFieldId: number;
  startedFieldId: number;
  optionIds: Record<LoopPhase, number>;
};

/**
 * Finds the two custom fields and the option ids by name in the `list_custom_fields` reply. A missing field or option
 * gives `null` (do not write), never an error: the fields only mirror the run record.
 */
export const resolveLoopFields = (reply: unknown): LoopFields | null => {
  const body = rec(reply);
  const rows = Array.isArray(reply) ? list(reply) : list(body.data ?? body.fields);
  // Only fields for every issue type count (a field scoped to one type fails for the others), and a name that
  // matches twice is ambiguous: neither is taken.
  const only = (name: string, fieldType: string) => {
    const found = rows.filter(
      (f) => f.name === name && f.fieldType === fieldType && (f.issueTypeId ?? null) === null,
    );
    return found.length === 1 ? found[0] : undefined;
  };
  const phase = only(PHASE_FIELD, "select");
  const started = only(STARTED_FIELD, "datetime");
  const id = (v: unknown): number =>
    typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : Number.NaN;
  const phaseFieldId = id(phase?.id);
  const startedFieldId = id(started?.id);
  if (!Number.isInteger(phaseFieldId) || !Number.isInteger(startedFieldId)) return null;
  const options = list(phase?.options);
  const optionIds = {} as Record<LoopPhase, number>;
  for (const [key, name] of Object.entries(LOOP_PHASES)) {
    const optionId = id(options.find((o) => o.value === name)?.id);
    if (!Number.isInteger(optionId)) return null;
    optionIds[key as LoopPhase] = optionId;
  }
  return { phaseFieldId, startedFieldId, optionIds };
};
