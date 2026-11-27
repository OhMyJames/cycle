// Small-item Task Graph planning (CYC-509): which 小档 work items go straight to one node, and how a read-only planner's
// reply is checked before it becomes a Level-2 graph. Everything here is deterministic; the planner session itself is
// driven from `flows/dev/graph.ts`.

import { realpath } from "node:fs/promises";
import { isAbsolute, join, posix, sep } from "node:path";
import { parseCriteria } from "./criteria.ts";
import { type TaskNodeSpec, validateGraphSpecs } from "./graph.ts";
import { findSection } from "./preflight.ts";
import type { Config, Issue } from "./types.ts";

/** The planner must return this many nodes; one node is what the fast path is for. */
export const PLANNER_MIN_NODES = 2;
export const PLANNER_MAX_NODES = 4;
/** One first call plus at most two corrections. */
export const PLANNER_MAX_TURNS = 3;
/** At most this many acceptance criteria (and one package) still count as simple. */
export const SIMPLE_MAX_CRITERIA = 3;

const PACKAGE_ROOTS = new Set(["apps", "packages", "cloud", "harness"]);

const pathOk = (token: string): boolean =>
  token !== "" &&
  !token.includes("://") &&
  !/\s/.test(token) &&
  !token.startsWith("/") &&
  !token.startsWith("~") &&
  !token.startsWith("-") &&
  /^[\w.@*/-]+$/.test(token);

/** The top-level package directory a relative path belongs to: `cloud/loop`, `apps/desktop`, or the first segment. */
export const packageOf = (path: string): string | undefined => {
  const clean = path.replace(/^\.\//, "").replace(/\/+$/, "");
  const parts = clean.split("/").filter((p) => p !== "" && p !== ".");
  const [first, second] = parts;
  if (first === undefined || first === "..") return undefined;
  if (PACKAGE_ROOTS.has(first)) return second === undefined ? first : `${first}/${second}`;
  return first;
};

/**
 * The package directories the work item's 「涉及面」 section names. Paths are the backticked tokens with a `/`, and bare
 * words that start with a package root. A section without any path says nothing, which counts as one module.
 */
export const touchedPackages = (description: string): Set<string> => {
  const text = description.replace(/\r\n/g, "\n");
  const section = findSection(text, "涉及面");
  const found = new Set<string>();
  if (section === undefined) return found;
  const body = text
    .split("\n")
    .slice(section.heading + 1, section.end)
    .join("\n");
  const tokens: string[] = [];
  for (const m of body.matchAll(/`([^`\n]+)`/g)) tokens.push((m[1] as string).trim());
  const bare = body.replace(/`[^`\n]*`/g, " ");
  for (const m of bare.matchAll(/(?<![\w./-])(?:apps|packages|cloud|harness)\/[\w.@*/-]+/g))
    tokens.push(m[0]);
  for (const token of tokens) {
    const clean = token.replace(/^\.\//, "");
    if (!pathOk(clean)) continue;
    if (!clean.includes("/") && !PACKAGE_ROOTS.has(clean)) continue;
    const pkg = packageOf(clean);
    if (pkg !== undefined) found.add(pkg);
  }
  return found;
};

export type SmallRoute =
  | { route: "single"; reason: "simple_bug" | "single_package" }
  | { route: "plan"; reason: "criteria" | "cross_package"; criteria: number; packages: number };

/** The deterministic fast-path check for a 小档 work item: no planner is started for `single`. */
export const routeSmallItem = (
  issue: Pick<Issue, "typeId" | "description">,
  config: Pick<Config, "bugTypeId">,
): SmallRoute => {
  const criteria = parseCriteria(issue.description).length;
  const packages = touchedPackages(issue.description).size;
  if (criteria <= SIMPLE_MAX_CRITERIA) {
    if (issue.typeId === config.bugTypeId) return { route: "single", reason: "simple_bug" };
    if (packages <= 1) return { route: "single", reason: "single_package" };
  }
  return criteria > SIMPLE_MAX_CRITERIA
    ? { route: "plan", reason: "criteria", criteria, packages }
    : { route: "plan", reason: "cross_package", criteria, packages };
};

const underWorktree = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Why a `filesHint` entry leaves the worktree, or undefined when it stays inside (symlinks followed). */
const hintProblem = async (worktree: string, hint: string): Promise<string | undefined> => {
  if (
    isAbsolute(hint) ||
    hint.startsWith("/") ||
    hint.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(hint)
  )
    return `\`${hint}\` is an absolute path; use a path relative to the worktree`;
  if (hint.includes("\\")) return `\`${hint}\` uses a backslash; use "/" separators`;
  if (hint.split("/").includes(".."))
    return `\`${hint}\` contains "..": it must stay inside the worktree`;
  const normal = posix.normalize(hint);
  if (normal === ".." || normal.startsWith("../")) return `\`${hint}\` escapes the worktree`;
  let root = worktree;
  try {
    root = await realpath(worktree);
  } catch {
    // A worktree that cannot be resolved is compared as written.
  }
  // The file, or the nearest parent that exists, must really be inside the worktree.
  const parts = normal.split("/").filter((p) => p !== "" && p !== ".");
  for (let n = parts.length; n >= 0; n--) {
    const candidate = join(worktree, ...parts.slice(0, n));
    try {
      const real = await realpath(candidate);
      if (!underWorktree(root, real)) return `\`${hint}\` resolves outside the worktree (${real})`;
      return undefined;
    } catch {
      // Not there yet: look at its parent.
    }
  }
  return undefined;
};

const FENCED = /```json[ \t]*\r?\n([\s\S]*?)```/gi;

export type PlannerCheck = { ok: true; specs: TaskNodeSpec[] } | { ok: false; reasons: string[] };

/** Checks one planner reply: a fenced `json` block holding 2–4 valid nodes whose `filesHint`s stay in the worktree. */
export const checkPlannerReply = async (text: string, worktree: string): Promise<PlannerCheck> => {
  const block = Array.from(text.matchAll(FENCED)).at(-1);
  if (block === undefined)
    return {
      ok: false,
      reasons: ["The reply has no fenced ```json ... ``` block with the Task Graph."],
    };
  let raw: unknown;
  try {
    raw = JSON.parse(block[1] ?? "");
  } catch (error) {
    return {
      ok: false,
      reasons: [
        `The json block is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      ],
    };
  }
  const nodes =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && "nodes" in raw
      ? (raw as { nodes: unknown }).nodes
      : raw;
  if (Array.isArray(nodes) && nodes.length < PLANNER_MIN_NODES)
    return {
      ok: false,
      reasons: [
        `The graph has ${nodes.length} node(s); it must have ${PLANNER_MIN_NODES} to ${PLANNER_MAX_NODES}.`,
      ],
    };
  const checked = validateGraphSpecs(nodes, { maxNodes: PLANNER_MAX_NODES });
  if (!checked.ok) return checked;
  const reasons: string[] = [];
  for (const spec of checked.specs) {
    for (const hint of spec.filesHint) {
      const problem = await hintProblem(worktree, hint);
      if (problem !== undefined) reasons.push(`Node "${spec.id}" filesHint: ${problem}.`);
    }
  }
  return reasons.length > 0 ? { ok: false, reasons } : checked;
};
