// Level-2 Task Graph (CYC-507, CYC-508): structured execution nodes owned by Loop inside one Level-1 work item.
//
// A Level-1 work item maps 1:1 to a git branch and a pull request. Inside it, Loop executes a DAG of standardized
// Task Nodes sequentially in topological order on that same branch, each in a fresh Dev session with its own local
// verification commands and checkpoint commit. Whole-item verify / QA / CI failures append `fix-<n>` nodes (origin:
// "fix") at the end of the graph so the full execution history stays inspectable.

import { z } from "zod";
import { parseVerify } from "./criteria.ts";
import { ALLOWED_COMMANDS, findSection } from "./preflight.ts";

/** Maximum planned nodes allowed in one Level-1 work item's Task Graph. */
export const MAX_PLANNED_NODES = 8;
/** Maximum total nodes including automatically appended `fix-*` nodes. */
export const MAX_TOTAL_NODES = 12;

export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const FIX_PREFIX = /^fix-/i;

export const TaskGraphSourceSchema = z.enum([
  "single",
  "plan_doc",
  "auto_plan",
  "auto_planner",
  "edited",
]);
export type TaskGraphSource = z.infer<typeof TaskGraphSourceSchema>;

export const TaskNodeOriginSchema = z.enum(["planned", "fix"]);
export type TaskNodeOrigin = z.infer<typeof TaskNodeOriginSchema>;

export const TaskNodeStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
]);
export type TaskNodeStatus = z.infer<typeof TaskNodeStatusSchema>;

/** One node as authored in a Plan document's fenced JSON graph block before runtime state is attached. */
export const TaskNodeSpecSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  filesHint: z.array(z.string().trim().min(1)).default([]),
  verify: z.array(z.string().trim().min(1)).min(1),
});
export type TaskNodeSpec = z.infer<typeof TaskNodeSpecSchema>;

/** One persisted execution node inside `graph_nodes`. */
export const TaskNodeSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().min(0),
  origin: TaskNodeOriginSchema,
  title: z.string().min(1),
  goal: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
  filesHint: z.array(z.string()),
  verify: z.array(z.string().min(1)).min(1),
  status: TaskNodeStatusSchema,
  sessionId: z.string().nullable(),
  commitSha: z.string().nullable(),
  rounds: z.number().int().min(0),
  lastError: z.string().nullable(),
  summary: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

/** Full execution graph for one Level-1 run. */
export const TaskGraphSchema = z.object({
  runKey: z.string().min(1),
  source: TaskGraphSourceSchema,
  revision: z.number().int().min(1),
  currentNodeId: z.string().nullable(),
  nodes: z.array(TaskNodeSchema).min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export type GraphValidation =
  | { ok: true; specs: TaskNodeSpec[] }
  | { ok: false; reasons: string[] };

export type PlanGraphParse =
  | { found: false }
  | { found: true; ok: true; specs: TaskNodeSpec[] }
  | { found: true; ok: false; reasons: string[] };

/**
 * Validates raw node specs and returns them in deterministic topological order (Kahn's algorithm, preserving original
 * relative order for ready nodes). Every `verify` command must pass `parseVerify`.
 */
export const validateGraphSpecs = (
  rawNodes: unknown,
  options: { maxNodes?: number; allowFixIds?: boolean } = {},
): GraphValidation => {
  const maxNodes = options.maxNodes ?? MAX_PLANNED_NODES;
  const allowFixIds = options.allowFixIds ?? false;
  if (!Array.isArray(rawNodes)) {
    return {
      ok: false,
      reasons: ['The Task Graph JSON must be an array of nodes or `{ "nodes": [...] }`.'],
    };
  }
  if (rawNodes.length === 0) {
    return { ok: false, reasons: ["The Task Graph must contain at least one node."] };
  }
  if (rawNodes.length > maxNodes) {
    return {
      ok: false,
      reasons: [
        `The Task Graph has ${rawNodes.length} nodes, exceeding the limit of ${maxNodes}. Split oversized work into separate Level-1 items.`,
      ],
    };
  }

  const reasons: string[] = [];
  const specs: TaskNodeSpec[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rawNodes.length; i++) {
    const parsed = TaskNodeSpecSchema.safeParse(rawNodes[i]);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "node"}: ${issue.message}`)
        .join("; ");
      reasons.push(`Task Graph node #${i + 1} is invalid: ${detail}.`);
      continue;
    }
    const spec = parsed.data;
    if (!NODE_ID_PATTERN.test(spec.id)) {
      reasons.push(
        `Task Graph node "${spec.id}" has an invalid id (use 1–32 lowercase letters, digits, '-' or '_').`,
      );
    }
    if (!allowFixIds && FIX_PREFIX.test(spec.id)) {
      reasons.push(
        `Task Graph node "${spec.id}" cannot start with "fix-"; that prefix is reserved for automatic fix nodes.`,
      );
    }
    if (seen.has(spec.id)) {
      reasons.push(`Duplicate Task Graph node id "${spec.id}".`);
    } else {
      seen.add(spec.id);
    }
    for (const cmd of spec.verify) {
      if (parseVerify(cmd) === undefined) {
        reasons.push(
          `Task Graph node "${spec.id}" has disallowed verify command \`${cmd}\` (allowed: ${ALLOWED_COMMANDS}).`,
        );
      }
    }
    specs.push(spec);
  }

  if (reasons.length > 0) return { ok: false, reasons };

  // Dependency checks: no self-dependency, no dangling reference, deduplicated dependsOn.
  const normalized: TaskNodeSpec[] = specs.map((spec) => ({
    ...spec,
    dependsOn: [...new Set(spec.dependsOn)],
    filesHint: [...new Set(spec.filesHint)],
  }));
  const byId = new Map(normalized.map((spec, index) => [spec.id, { spec, index }]));

  for (const spec of normalized) {
    for (const dep of spec.dependsOn) {
      if (dep === spec.id) {
        reasons.push(`Task Graph node "${spec.id}" cannot depend on itself.`);
      } else if (!byId.has(dep)) {
        reasons.push(`Task Graph node "${spec.id}" depends on unknown node "${dep}".`);
      }
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };

  // Kahn's topological sort, preserving original author order among ready nodes.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const spec of normalized) {
    inDegree.set(spec.id, spec.dependsOn.length);
    for (const dep of spec.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(spec.id);
      dependents.set(dep, list);
    }
  }

  const ready: string[] = normalized
    .filter((spec) => (inDegree.get(spec.id) ?? 0) === 0)
    .map((spec) => spec.id);
  const ordered: TaskNodeSpec[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => (byId.get(a)?.index ?? 0) - (byId.get(b)?.index ?? 0));
    const id = ready.shift() as string;
    const entry = byId.get(id);
    if (entry !== undefined) ordered.push(entry.spec);
    for (const next of dependents.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) ready.push(next);
    }
  }

  if (ordered.length !== normalized.length) {
    const stuck = normalized.filter((s) => (inDegree.get(s.id) ?? 0) > 0).map((s) => s.id);
    return {
      ok: false,
      reasons: [`The Task Graph contains a dependency cycle involving: ${stuck.join(", ")}.`],
    };
  }

  return { ok: true, specs: ordered };
};

const GRAPH_SECTION_NAMES = ["执行图", "Task Graph"] as const;
const FENCED_JSON = /```json[ \t]*\r?\n([\s\S]*?)```/i;

/**
 * Extracts and validates the fenced `json` Task Graph block under `## 执行图` or `## Task Graph` in a Plan document.
 * Returns `{ found: false }` when the document has no such section (legacy Plans stay backward-compatible).
 */
export const parsePlanGraph = (planMarkdown: string): PlanGraphParse => {
  const normalized = planMarkdown.replace(/\r\n/g, "\n");
  let section: { heading: number; end: number } | undefined;
  for (const name of GRAPH_SECTION_NAMES) {
    section = findSection(normalized, name);
    if (section !== undefined) break;
  }
  if (section === undefined) return { found: false };

  const body = normalized
    .split("\n")
    .slice(section.heading + 1, section.end)
    .join("\n");
  const match = FENCED_JSON.exec(body);
  if (match === null) {
    return {
      found: true,
      ok: false,
      reasons: [
        "The Plan has a 「执行图」/「Task Graph」 section but no fenced ```json ... ``` block.",
      ],
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(match[1] ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      found: true,
      ok: false,
      reasons: [`The Task Graph JSON block in Plan is not valid JSON: ${message}.`],
    };
  }

  const rawNodes =
    typeof parsedJson === "object" && parsedJson !== null && "nodes" in parsedJson
      ? (parsedJson as { nodes: unknown }).nodes
      : parsedJson;
  const validated = validateGraphSpecs(rawNodes);
  return validated.ok
    ? { found: true, ok: true, specs: validated.specs }
    : { found: true, ok: false, reasons: validated.reasons };
};

/** Creates a new persisted Task Graph with all nodes initialized to `pending`. */
export const buildGraph = (
  runKey: string,
  source: TaskGraphSource,
  specs: TaskNodeSpec[],
  nowIso: string,
): TaskGraph =>
  TaskGraphSchema.parse({
    runKey,
    source,
    revision: 1,
    currentNodeId: null,
    nodes: specs.map((spec, position) => ({
      id: spec.id,
      position,
      origin: "planned",
      title: spec.title,
      goal: spec.goal,
      dependsOn: spec.dependsOn,
      filesHint: spec.filesHint,
      verify: spec.verify,
      status: "pending",
      sessionId: null,
      commitSha: null,
      rounds: 0,
      lastError: null,
      summary: null,
      startedAt: null,
      finishedAt: null,
    })),
    createdAt: nowIso,
    updatedAt: nowIso,
  });

const isDoneStatus = (status: TaskNodeStatus): boolean =>
  status === "passed" || status === "skipped";

/** First `pending` node (by `position`) whose dependencies are all `passed` or `skipped`. */
export const nextReadyNode = (graph: TaskGraph): TaskNode | undefined => {
  const statusById = new Map(graph.nodes.map((node) => [node.id, node.status]));
  return [...graph.nodes]
    .sort((a, b) => a.position - b.position)
    .find(
      (node) =>
        node.status === "pending" &&
        node.dependsOn.every((dep) => {
          const s = statusById.get(dep);
          return s !== undefined && isDoneStatus(s);
        }),
    );
};

/** True when every node in the graph is `passed` or `skipped`. */
export const isGraphComplete = (graph: TaskGraph): boolean =>
  graph.nodes.length > 0 && graph.nodes.every((node) => isDoneStatus(node.status));

/** Returns a new TaskGraph with one node patched and `updatedAt` refreshed. */
export const updateGraphNode = (
  graph: TaskGraph,
  nodeId: string,
  patch: Partial<Omit<TaskNode, "id" | "position" | "origin">>,
  nowIso: string,
  currentNodeId: string | null | undefined = undefined,
): TaskGraph => {
  let found = false;
  const nodes = graph.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    found = true;
    return { ...node, ...patch };
  });
  if (!found) throw new Error(`no graph node ${nodeId} in ${graph.runKey}`);
  return TaskGraphSchema.parse({
    ...graph,
    currentNodeId: currentNodeId === undefined ? graph.currentNodeId : currentNodeId,
    nodes,
    updatedAt: nowIso,
  });
};

/**
 * Appends an automatic `fix-<n>` node (origin: "fix") to the end of the graph after whole-item verify, QA, CI, or
 * PR review rejects the branch. Depends on every currently completed node so completed nodes remain monotonic.
 */
export const appendFixNode = (
  graph: TaskGraph,
  input: {
    title: string;
    goal: string;
    verify: string[];
    nowIso: string;
    maxTotalNodes?: number;
  },
): { ok: true; graph: TaskGraph; node: TaskNode } | { ok: false; reason: string } => {
  const cap = input.maxTotalNodes ?? MAX_TOTAL_NODES;
  if (graph.nodes.length >= cap) {
    return {
      ok: false,
      reason: `Task Graph 已达最大节点数上限（${cap} 个），不再自动追加修补节点。`,
    };
  }
  const verify = input.verify.filter((cmd) => parseVerify(cmd) !== undefined);
  const safeVerify = verify.length > 0 ? [...new Set(verify)] : ["bun run check"];

  let nextNum = 1;
  for (const existing of graph.nodes) {
    const m = /^fix-(\d+)$/.exec(existing.id);
    if (m !== null) nextNum = Math.max(nextNum, Number.parseInt(m[1] as string, 10) + 1);
  }
  const id = `fix-${nextNum}`;
  const dependsOn = graph.nodes.filter((n) => isDoneStatus(n.status)).map((n) => n.id);
  const node: TaskNode = {
    id,
    position: graph.nodes.length,
    origin: "fix",
    title: input.title.trim() || `修复整单问题 #${nextNum}`,
    goal: input.goal.trim() || "Fix the reported verification/review findings.",
    dependsOn,
    filesHint: [],
    verify: safeVerify,
    status: "pending",
    sessionId: null,
    commitSha: null,
    rounds: 0,
    lastError: null,
    summary: null,
    startedAt: null,
    finishedAt: null,
  };
  const next = TaskGraphSchema.parse({
    ...graph,
    revision: graph.revision + 1,
    nodes: [...graph.nodes, node],
    updatedAt: input.nowIso,
  });
  return { ok: true, graph: next, node };
};

const STATUS_BADGE: Record<TaskNodeStatus, string> = {
  pending: "○ pending",
  running: "● running",
  passed: "✅ passed",
  failed: "❌ failed",
  blocked: "⏸ blocked",
  skipped: "↷ skipped",
};

/** Compact Markdown table summarizing all nodes for prompts, PR descriptions, and one-way tracker comments. */
export const formatGraphTable = (
  graph: TaskGraph,
  options: { includeCommits?: boolean } = {},
): string => {
  const sorted = [...graph.nodes].sort((a, b) => a.position - b.position);
  if (options.includeCommits) {
    const rows = sorted.map(
      (n) =>
        `| \`${n.id}\` | ${n.origin} | ${n.title.replace(/\|/g, "\\|")} | ${STATUS_BADGE[n.status]} | ${n.commitSha ? `\`${n.commitSha.slice(0, 8)}\`` : "-"} | ${n.verify.map((v) => `\`${v}\``).join("<br>")} |`,
    );
    return [
      "| Node | Origin | Title | Status | Commit | Verify |",
      "|---|---|---|---|---|---|",
      ...rows,
    ].join("\n");
  }
  const rows = sorted.map(
    (n) =>
      `| \`${n.id}\` | ${n.title.replace(/\|/g, "\\|")} | ${n.dependsOn.length === 0 ? "-" : n.dependsOn.map((d) => `\`${d}\``).join(", ")} | ${STATUS_BADGE[n.status]} | ${(n.summary ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 120) || "-"} |`,
  );
  return [
    "| Node | Title | Depends on | Status | Summary |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
};
