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
 * Finds the two custom fields and the option ids by name in the `list_custom_fields` reply. Anything wrong comes back
 * as `problem`, a sentence for the warning (do not write), never an error: the fields only mirror the run record.
 */
export const resolveLoopFields = (reply: unknown): { fields: LoopFields } | { problem: string } => {
  const body = rec(reply);
  const rows = Array.isArray(reply) ? list(reply) : list(body.data ?? body.fields);
  const id = (v: unknown): number =>
    typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : Number.NaN;
  // Only fields for every issue type count (a field scoped to one type fails for the others), and a name that
  // matches twice is ambiguous.
  const only = (name: string, fieldType: string): Record<string, unknown> | string => {
    const named = rows.filter((f) => f.name === name);
    if (named.length === 0) return `no field named 「${name}」`;
    const global = named.filter((f) => (f.issueTypeId ?? null) === null);
    if (global.length !== 1)
      return `「${name}」 must be one field for every issue type (found ${named.length}, ${global.length} unscoped)`;
    const field = global[0] as Record<string, unknown>;
    if (field.fieldType !== fieldType) return `「${name}」 must be a ${fieldType} field`;
    if (!Number.isInteger(id(field.id))) return `「${name}」 has no usable id`;
    return field;
  };
  const phase = only(PHASE_FIELD, "select");
  if (typeof phase === "string") return { problem: phase };
  const started = only(STARTED_FIELD, "datetime");
  if (typeof started === "string") return { problem: started };
  const options = list(phase.options);
  const optionIds = {} as Record<LoopPhase, number>;
  for (const [key, name] of Object.entries(LOOP_PHASES)) {
    const optionId = id(options.find((o) => o.value === name)?.id);
    if (!Number.isInteger(optionId))
      return { problem: `「${PHASE_FIELD}」 has no option 「${name}」` };
    optionIds[key as LoopPhase] = optionId;
  }
  return { fields: { phaseFieldId: id(phase.id), startedFieldId: id(started.id), optionIds } };
};
