// Resolves what used to be hardcoded for infra.CYC (columns, the `auto` label, issue type ids) from the tracker's
// `get_project` reply (CYC-392). Columns are chosen by stateType, never by name; when a stateType has several columns
// they are taken in board order (`position`): Todo is the first `unstarted`; In Progress, In Review and Blocked are
// the first, second and third `started`.

import type { Config, DocumentEntry, LoopPhase } from "./types.ts";

export type ProjectSetup = Pick<
  Config,
  "columns" | "autoLabelId" | "allowedTypeIds" | "featureTypeId" | "bugTypeId"
>;

/** What `resolveProject` finds for research (CYC-447); the rest of `Config.research` comes from the config file. */
export type ResearchSetup = { typeId: number; backlogColumn: number; folderId: number };

/** Names to look up for research: the issue type, and the folder's title among the project's documents. */
export type ResearchNames = { type: string; folder: string; documents: DocumentEntry[] };

/** What `resolveProject` finds for the planning node (CYC-322); the counts come from the config file. */
export type PlanningSetup = Pick<
  NonNullable<Config["planning"]>,
  "labels" | "backlogColumn" | "epicTypeId" | "templates"
>;

/** Names to look up for planning: its three labels, and the full-process label it keeps away from. */
export type PlanningNames = {
  pending: string;
  awaitingAnswer: string;
  skip: string;
  fullProcess: string;
};

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

export const resolveProject = (
  reply: unknown,
  names: { projectKey: string; autoLabel: string; featureType: string; bugType: string },
  research?: ResearchNames,
  planning?: PlanningNames,
): ProjectSetup & { research: ResearchSetup | null; planning: PlanningSetup | null } => {
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
  const optionalByName = (rows: unknown, name: string): number | null => {
    const id = Number(
      list(rows).find((r) => String(r.name).toLowerCase() === name.toLowerCase())?.id,
    );
    return Number.isInteger(id) ? id : null;
  };
  const featureTypeId = byName(data.issueTypes, names.featureType, "issue type");
  const bugTypeId = byName(data.issueTypes, names.bugType, "issue type");
  // Research is only looked up when it is on, so a project without the type or the folder still starts with it off.
  const researchSetup: ResearchSetup | null =
    research === undefined
      ? null
      : {
          typeId: byName(data.issueTypes, research.type, "issue type"),
          backlogColumn: pick("backlog", 0, "backlog"),
          folderId: folder(research, names.projectKey),
        };
  // Planning likewise: its labels, Epic and the templates are required only when it is on.
  const planningSetup: PlanningSetup | null =
    planning === undefined
      ? null
      : {
          labels: {
            pending: byName(data.labels, planning.pending, "label"),
            awaitingAnswer: byName(data.labels, planning.awaitingAnswer, "label"),
            skip: byName(data.labels, planning.skip, "label"),
            // Only kept away from: a project without the label has no work item carrying it.
            fullProcess: optionalByName(data.labels, planning.fullProcess),
          },
          backlogColumn: pick("backlog", 0, "backlog"),
          epicTypeId: byName(data.issueTypes, "Epic", "issue type"),
          templates: {
            feature: template(data.issueTemplates, featureTypeId, names.featureType, names),
            bug: template(data.issueTemplates, bugTypeId, names.bugType, names),
          },
        };
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
    allowedTypeIds: [
      ...new Set([
        featureTypeId,
        bugTypeId,
        ...(researchSetup === null ? [] : [researchSetup.typeId]),
      ]),
    ],
    featureTypeId,
    bugTypeId,
    research: researchSetup,
    planning: planningSetup,
  };
};

/**
 * The body of the issue template for a type. A type may have several (CYC has 「Feature」 and 「Feature（完整流程）」):
 * the one named like the type is taken; with none so named, a single one is, and more than one is an error rather
 * than a guess.
 */
const template = (
  rows: unknown,
  typeId: number,
  typeName: string,
  names: { projectKey: string },
): string => {
  const ofType = list(rows).filter((t) => Number(t.typeId) === typeId);
  const named = ofType.filter((t) => String(t.name).toLowerCase() === typeName.toLowerCase());
  const chosen = named.length > 0 ? named : ofType;
  const [only] = chosen;
  if (only === undefined)
    throw new Error(`project ${names.projectKey}: no issue template for type "${typeName}"`);
  if (chosen.length > 1)
    throw new Error(
      `project ${names.projectKey}: ${chosen.length} issue templates for type "${typeName}" (${named.length} named "${typeName}"); name one "${typeName}"`,
    );
  const body = only.descriptionTemplate;
  if (typeof body !== "string" || body.trim() === "")
    throw new Error(
      `project ${names.projectKey}: issue template "${only.name}" has no description`,
    );
  return body;
};

/**
 * The folder by its exact title. Titles are not unique: when several match, the one at the top of the tree is taken,
 * and if that still leaves more than one, it is an error rather than a guess.
 */
const folder = (research: ResearchNames, projectKey: string): number => {
  const named = research.documents.filter((d) => d.title === research.folder);
  const top = named.filter((d) => d.parentId === null);
  if (named.length === 0)
    throw new Error(`project ${projectKey}: no document named "${research.folder}"`);
  const chosen = named.length === 1 ? named : top;
  const [only] = chosen;
  if (only === undefined || chosen.length > 1)
    throw new Error(
      `project ${projectKey}: ${named.length} documents named "${research.folder}" (${top.length} at the top level); rename all but one`,
    );
  return only.id;
};

/**
 * The phases of research (CYC-447) and of the planning node (CYC-322): their options may be missing, and then those
 * phases are not mirrored.
 */
type OptionalPhase = "research" | "researchQa" | "plan" | "planQa";
type RequiredPhase = Exclude<LoopPhase, OptionalPhase>;

/** The phases the loop mirrors onto a work item, and the option name each one has in the project's select field. */
export const LOOP_PHASES = {
  dev: "开发",
  verify: "验证",
  qa: "QA",
  ci: "等 CI",
  review: "评审",
  merge: "等合并",
} as const satisfies Record<RequiredPhase, string>;

export const OPTIONAL_LOOP_PHASES = {
  research: "调研",
  researchQa: "调研 QA",
  plan: "规划",
  planQa: "规划 QA",
} as const satisfies Record<OptionalPhase, string>;

export const PHASE_FIELD = "Loop 阶段";
export const STARTED_FIELD = "Loop 阶段开始于";

export type LoopFields = {
  phaseFieldId: number;
  startedFieldId: number;
  optionIds: Record<RequiredPhase, number> & Partial<Record<OptionalPhase, number>>;
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
  const optionOf = (name: string) => id(options.find((o) => o.value === name)?.id);
  const optionIds = {} as LoopFields["optionIds"];
  for (const [key, name] of Object.entries(LOOP_PHASES)) {
    const optionId = optionOf(name);
    if (!Number.isInteger(optionId))
      return { problem: `「${PHASE_FIELD}」 has no option 「${name}」` };
    optionIds[key as RequiredPhase] = optionId;
  }
  for (const [key, name] of Object.entries(OPTIONAL_LOOP_PHASES)) {
    const optionId = optionOf(name);
    if (Number.isInteger(optionId)) optionIds[key as OptionalPhase] = optionId;
  }
  return { fields: { phaseFieldId: id(phase.id), startedFieldId: id(started.id), optionIds } };
};
