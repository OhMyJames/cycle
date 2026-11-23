// A code review's findings, as the agent reported them (CYCL-138).
//
// Claude reports a review with its `ReportFindings` tool: the findings arrive as the call's input, typed (the Agent SDK's
// `ReportFindingsInput`), not as text in a reply. So they are read from there. The input comes from the agent and is not
// trusted: every field is checked, and a call whose input is not a review in that shape is drawn as any other call.
import type { ToolItem } from "./conversation.ts";

/** Claude's tool that reports a code review. */
export const REVIEW_TOOLS: ReadonlySet<string> = new Set(["ReportFindings"]);

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

export type Review = { level?: string; findings: Finding[] };

/** As many as the tool allows; more would be an agent sending something else. */
const MAX_FINDINGS = 32;
/** A field longer than this is cut: the card is for reading, the whole of it is in the call. */
const MAX_CHARS = 4_000;
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

/** The surest first; among equals, as the agent ordered them (most severe first, it is told). */
const RANK: Record<Verdict | "none", number> = { confirmed: 0, plausible: 1, none: 2 };

/**
 * The review a call reports, when it is one: Claude's review tool, not failed, with findings that are all in shape.
 * Otherwise nothing, and the call is drawn as a call. An empty list is a review that found nothing.
 */
export const reviewOf = (tool: ToolItem): Review | undefined => {
  if (!REVIEW_TOOLS.has(tool.name ?? "")) return undefined;
  if (tool.status === "failed" || tool.status === "cancelled") return undefined;
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null) return undefined;
  const { findings, level } = input as Record<string, unknown>;
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) return undefined;
  const read = findings.map(findingOf);
  if (read.some((f) => f === undefined)) return undefined;
  const sorted = (read as Finding[])
    .map((finding, at) => ({ finding, at }))
    .sort(
      (a, b) =>
        RANK[a.finding.verdict ?? "none"] - RANK[b.finding.verdict ?? "none"] || a.at - b.at,
    )
    .map(({ finding }) => finding);
  return {
    ...(typeof level === "string" && LEVELS.has(level) ? { level } : {}),
    findings: sorted,
  };
};

/** How many findings there are of each verdict, for the card's summary line. */
export const reviewTally = (
  review: Review,
): { total: number; confirmed: number; plausible: number; fixed: number } => ({
  total: review.findings.length,
  confirmed: review.findings.filter((f) => f.verdict === "confirmed").length,
  plausible: review.findings.filter((f) => f.verdict === "plausible").length,
  fixed: review.findings.filter((f) => f.outcome === "fixed").length,
});
