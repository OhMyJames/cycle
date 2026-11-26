// Reading what a session says back: tagged blocks, the verdicts and the lists they must carry.

import { z } from "zod";
import type { CriterionSpec, ParsedCriterion } from "../criteria.ts";
import { verifyArgv } from "../criteria.ts";

/** The content of the last `<tag>` block, trimmed; null when there is none. Earlier ones are drafts it replaced. */
export const last = (text: string, tag: string): string | null => {
  const found = Array.from(text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))).at(-1);
  return found === undefined ? null : (found[1] as string).trim();
};

/** `name="value"` in the attributes of a tag. */
export const attribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attributes)?.[1];

/** Priorities from most to least urgent; an unknown one sorts after them. */
export const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * The criteria a description names, as specs the loop can run; and the reasons why those that cannot be. `label(n)`
 * names criterion `n` (from 1) in a reason.
 */
export const criterionSpecs = (
  parsed: ParsedCriterion[],
  label: (n: number) => string,
  allowed: string,
): { specs: CriterionSpec[]; reasons: string[] } => {
  const specs: CriterionSpec[] = [];
  const reasons: string[] = [];
  parsed.forEach((criterion, index) => {
    const name = label(index + 1);
    if (criterion.commands.length === 0) {
      reasons.push(`${name} names no command to check it. Add 「验证：\`bun test <path>\`」.`);
      return;
    }
    const argv = verifyArgv(criterion.commands);
    if (!argv.ok) {
      reasons.push(
        `${name} names a command the loop may not run: ${argv.rejected.map((c) => `\`${c}\``).join(", ")}. Allowed: ${allowed}.`,
      );
      return;
    }
    specs.push({ text: criterion.text, verify: argv.argv });
  });
  return { specs, reasons };
};

export const parseProgress = (text: string): string | undefined =>
  last(text, "progress") ?? undefined;

const VerdictSchema = z.object({
  pass: z.boolean(),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]),
        where: z.string(),
        problem: z.string(),
        fix: z.string(),
      }),
    )
    .default([]),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** The verdict QA ended with, or undefined when it gave none that can be read. */
export const parseVerdict = (text: string): Verdict | undefined => {
  const block = last(text, "verdict");
  if (block === null) return undefined;
  try {
    const verdict = VerdictSchema.parse(JSON.parse(block));
    // A pass with a blocker in it is not a pass.
    const blocking = verdict.findings.some((f) => f.severity !== "minor");
    return { ...verdict, pass: verdict.pass && !blocking };
  } catch {
    return undefined;
  }
};

const ReviewFindingSchema = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  where: z.string().trim().min(1),
  problem: z.string().trim().min(1),
  fix: z.string().trim().min(1),
});

const ReviewVerdictSchema = z.object({
  decision: z.enum(["merge", "reject", "escalate"]),
  summary: z.string().trim().min(1),
  reasons: z.array(z.string().trim().min(1)).default([]),
  findings: z.array(ReviewFindingSchema).default([]),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/** The structured PR review conclusion, or undefined when missing or unreadable. */
export const parseReviewVerdict = (text: string): ReviewVerdict | undefined => {
  const block = last(text, "review");
  if (block === null) return undefined;
  try {
    const verdict = ReviewVerdictSchema.parse(JSON.parse(block));
    // A "merge" verdict that still carries a blocker or major finding cannot merge: treat it as "reject".
    if (verdict.decision === "merge" && verdict.findings.some((f) => f.severity !== "minor")) {
      return { ...verdict, decision: "reject" };
    }
    return verdict;
  } catch {
    return undefined;
  }
};

export const formatFindings = (verdict: Verdict): string =>
  verdict.findings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.problem}\n   fix: ${f.fix}`)
    .join("\n");

/** Formats a PR review verdict's summary, reasons, and findings for Dev feedback or comments. */
export const formatReviewFindings = (verdict: ReviewVerdict): string => {
  const lines: string[] = [verdict.summary];
  if (verdict.reasons.length > 0) {
    lines.push("", ...verdict.reasons.map((r) => `- ${r}`));
  }
  if (verdict.findings.length > 0) {
    lines.push(
      "",
      ...verdict.findings.map(
        (f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.problem}\n   fix: ${f.fix}`,
      ),
    );
  }
  return lines.join("\n");
};

/** QA and PR review are told to list what they checked before the verdict block; a pass without that list is not taken. */
export const listsWhatWasChecked = (text: string): boolean => {
  const at = text.search(/what i checked/i);
  if (at === -1) return false;
  const after = text.slice(at).split(/<(?:verdict|review)>/)[0] ?? "";
  return /^\s*(?:[-*]|\d+[.)])\s+\S/m.test(after);
};
