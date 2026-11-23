// A code review's findings, as the agent reported them (CYCL-138, CYCL-216).
//
// They come one of two ways. Claude's `ReportFindings` tool takes them as the call's input, typed (the Agent SDK's
// `ReportFindingsInput`). But `/code-review` in a session runs as a forked skill, and its findings come back as what the
// `Skill` call returned: `Skill "code-review" completed (forked execution).`, `Result:`, a sentence or two, and the
// findings as a bare JSON array in a ```json block, in the same fields (so in every recorded session, CYCL-216). Both are
// read the same way. Either comes from the agent and is not trusted: every field is checked, and a call that is not a
// review in that shape is drawn as any other call.
import type { ToolItem } from "./conversation.ts";
import { streamsOf } from "./facts.ts";

/** Claude's tool that reports a code review. */
export const REVIEW_TOOLS: ReadonlySet<string> = new Set(["ReportFindings"]);

/** The tool that runs a skill, and the skill that reviews: a plugin's is named `plugin:code-review`. */
const SKILL_TOOL = "Skill";
const REVIEW_SKILL = /^\/?(?:[\w.-]+:)?code-review$/;

/** How sure the review is of a finding: checked by a second pass, likely, or not said (no second pass ran). */
export type Verdict = "confirmed" | "plausible";

/** What became of a finding, when the review is reported again after fixing. */
export type Outcome = "fixed" | "skipped" | "no_change_needed";

export type Finding = {
  /** Where, as the agent wrote it: relative to the repository, or absolute. */
  file: string;
  line?: number;
  /** The defect, in one sentence. */
  summary: string;
  /** A shorter label of it, when the agent gave one. */
  short?: string;
  /** What inputs or state make it go wrong, and how. */
  scenario: string;
  /** A kebab-case word for its kind: correctness, efficiency… */
  category?: string;
  verdict?: Verdict;
  outcome?: Outcome;
};

export type Review = {
  level?: string;
  findings: Finding[];
  /** What the agent said around the findings (a skill's result), as Markdown: what it looked at, why nothing was found. */
  prose?: string;
};

/** As many as the tool allows; more would be an agent sending something else. */
const MAX_FINDINGS = 32;
/** A field longer than this is cut: the card is for reading, the whole of it is in the call. */
const MAX_CHARS = 4_000;
/** A skill's result longer than this is not read as a review: 32 findings with every field full fit well inside it. */
const MAX_RESULT = 1_000_000;
const LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const OUTCOMES: ReadonlySet<string> = new Set(["fixed", "skipped", "no_change_needed"]);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_CHARS) : undefined;

const findingOf = (value: unknown): Finding | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const file = text(v.file);
  const summary = text(v.summary);
  const scenario = text(v.failure_scenario);
  if (file === undefined || summary === undefined || scenario === undefined) return undefined;
  const short = text(v.short_summary);
  const category = text(v.category);
  const verdict =
    v.verdict === "CONFIRMED" ? "confirmed" : v.verdict === "PLAUSIBLE" ? "plausible" : undefined;
  const outcome =
    typeof v.outcome === "string" && OUTCOMES.has(v.outcome) ? (v.outcome as Outcome) : undefined;
  return {
    file,
    ...(Number.isInteger(v.line) && (v.line as number) > 0 ? { line: v.line as number } : {}),
    summary,
    ...(short !== undefined && short !== summary ? { short } : {}),
    scenario,
    ...(category !== undefined ? { category } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
  };
};

/** A call that may report a review: Claude's review tool, or the code-review skill. */
const isReviewCall = (tool: ToolItem): boolean => {
  if (REVIEW_TOOLS.has(tool.name ?? "")) return true;
  if (tool.name !== SKILL_TOOL) return false;
  const input = tool.rawInput;
  const skill =
    typeof input === "object" && input !== null ? (input as { skill?: unknown }).skill : undefined;
  return typeof skill === "string" && REVIEW_SKILL.test(skill.trim());
};

/** Parsed once per call: a turn is laid out again on every update in it, and the call does not change. */
const parsed = new WeakMap<ToolItem, Review | undefined>();

/**
 * The review a call reports, when it is one: not failed, with findings that are all in shape. Otherwise nothing, and
 * the call is drawn as a call. An empty list is a review that found nothing. The findings keep the agent's order, which
 * is the most severe first (the tool asks for that); how sure each is, is shown on it.
 */
export const reviewOf = (tool: ToolItem): Review | undefined => {
  if (!isReviewCall(tool)) return undefined;
  if (parsed.has(tool)) return parsed.get(tool);
  const review = tool.name === SKILL_TOOL ? fromSkill(tool) : fromInput(tool);
  parsed.set(tool, review);
  return review;
};

const findingsOf = (findings: unknown): Finding[] | undefined => {
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) return undefined;
  const read = findings.map(findingOf);
  return read.some((f) => f === undefined) ? undefined : (read as Finding[]);
};

const levelOf = (level: unknown): { level?: string } =>
  typeof level === "string" && LEVELS.has(level) ? { level } : {};

const fromInput = (tool: ToolItem): Review | undefined => {
  if (tool.status === "failed" || tool.status === "cancelled") return undefined;
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null) return undefined;
  const { findings, level } = input as Record<string, unknown>;
  const read = findingsOf(findings);
  return read === undefined ? undefined : { ...levelOf(level), findings: read };
};

/**
 * What the skill tool says before a forked skill's result: the line that it completed, then `Result:`. Whatever is
 * before that line (a `<tools-used-before-summary>` tag, in some) goes with it.
 */
const SKILL_HEAD = /^[\s\S]*?completed \(forked execution\)\.[ \t]*\n\s*Result:[ \t]*\n/;
/** A ```json block, on lines of its own. */
const JSON_BLOCK = /^```json[ \t]*\n([\s\S]*?)\n?```[ \t]*$/gm;

/**
 * A finished code-review skill whose result holds one ```json block of findings. The words around the block are kept,
 * as the review's prose; anything else (no block, two, one that does not parse, a finding out of shape) is no review.
 */
const fromSkill = (tool: ToolItem): Review | undefined => {
  // Only a finished one: its result is whole only then, and one still going is not shown at all (`isPendingReview`).
  if (tool.status !== "completed") return undefined;
  const result = streamsOf(tool).out;
  if (result.length > MAX_RESULT) return undefined;
  const body = result.replace(SKILL_HEAD, "");
  const blocks = [...body.matchAll(JSON_BLOCK)];
  const block = blocks[0];
  if (blocks.length !== 1 || block === undefined) return undefined;
  let findings: unknown;
  try {
    findings = JSON.parse(block[1] ?? "");
  } catch {
    return undefined;
  }
  const read = findingsOf(findings);
  if (read === undefined) return undefined;
  const around = `${body.slice(0, block.index)}\n\n${body.slice(block.index + block[0].length)}`;
  const prose = text(around.replace(/\n{3,}/g, "\n\n"));
  // The level the skill was asked for, when its arguments start with one (`high origin/main...HEAD`).
  const args = (tool.rawInput as { args?: unknown }).args;
  const level = typeof args === "string" ? args.trim().split(/\s+/)[0] : undefined;
  return { ...levelOf(level), findings: read, ...(prose !== undefined ? { prose } : {}) };
};

/**
 * A review call still on its way whose input is not yet a review: shown as nothing, not as a row that would then turn
 * into the card; the step line says what is going meanwhile. Once it has ended, a call that is not a review in shape is
 * a call like any other.
 */
export const isPendingReview = (tool: ToolItem): boolean =>
  isReviewCall(tool) &&
  !["completed", "failed", "cancelled"].includes(tool.status ?? "pending") &&
  reviewOf(tool) === undefined;

/** How many findings there are of each verdict, for the card's summary line. */
export const reviewTally = (
  review: Review,
): { total: number; confirmed: number; plausible: number; fixed: number } => ({
  total: review.findings.length,
  confirmed: review.findings.filter((f) => f.verdict === "confirmed").length,
  plausible: review.findings.filter((f) => f.verdict === "plausible").length,
  fixed: review.findings.filter((f) => f.outcome === "fixed").length,
});
