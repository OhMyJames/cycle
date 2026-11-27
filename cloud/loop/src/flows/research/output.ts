// What a research session hands back, and the rules it must meet before QA sees it (CYC-447). The session is
// read-only and never touches the tracker: its last reply carries the summary, the report and follow-up drafts as tag
// blocks, and the loop publishes them. Tag blocks and not JSON: the report and the drafts are long Markdown, which a
// model escapes badly inside a JSON string.

import { attribute, last } from "../../parse/blocks.ts";
import { CONCLUSION, findSection, type PreflightConfig, preflight } from "../../preflight.ts";
import type { Config, Issue } from "../../types.ts";

export type FollowupType = "Feature" | "Bug";

export type Followup = {
  /** Null when the block's `type` is missing or is not Feature or Bug: a finding, not a draft to drop. */
  type: FollowupType | null;
  title: string;
  body: string;
};

export type ResearchOutput = {
  summary: string | null;
  report: string | null;
  followups: Followup[];
};

/** Characters, as a person counts them: a Chinese summary is not cut short by its UTF-16 length. */
export const MAX_SUMMARY = 600;
/** Below the tracker's own limits (250k for a document, 50k for an issue description), with room for what the loop adds. */
export const MAX_REPORT = 200_000;
export const MAX_FOLLOWUP_BODY = 40_000;

/**
 * The last `<summary>` and `<report>`, and every `<followup>`, in what the session said. Earlier summaries and reports
 * are drafts it replaced. Follow-ups are taken from the whole text, so a draft written twice counts twice: the
 * session is told to write each once.
 */
export const parseResearch = (text: string): ResearchOutput => ({
  summary: last(text, "summary"),
  report: last(text, "report"),
  followups: Array.from(text.matchAll(/<followup\b([^>]*)>([\s\S]*?)<\/followup>/g), (m) => {
    const attributes = m[1] as string;
    const type = attribute(attributes, "type");
    return {
      type: type === "Feature" || type === "Bug" ? type : null,
      title: (attribute(attributes, "title") ?? "").trim(),
      body: (m[2] as string).trim(),
    };
  }),
});

export type ResearchRules = Pick<Config, "maxCriteria" | "featureTypeId" | "bugTypeId"> & {
  maxFollowups: number;
};

const followupIssue = (draft: Followup, typeId: number): Issue => ({
  id: 0,
  number: 0,
  key: "",
  title: draft.title,
  description: draft.body,
  priority: null,
  createdAt: "",
  columnId: 0,
  labelIds: [],
  typeId,
  subtaskCount: 0,
  blockerColumnIds: [],
  parentId: null,
});

const answers = (report: string, n: number): boolean =>
  new RegExp(`^#{1,6}\\s*问题\\s*${n}(?!\\d)`, "m").test(report);

/**
 * What is wrong with the reply, in words the loop sends back to the session as they are; empty when it may go to QA.
 * A follow-up draft must pass the same preflight as a work item of its type, so a person who later moves it to Todo
 * finds it ready.
 */
export const checkResearch = (
  output: ResearchOutput,
  questions: string[],
  rules: ResearchRules,
): string[] => {
  const findings: string[] = [];
  if (output.summary === null) findings.push("There is no <summary>...</summary> block.");
  else if (output.summary === "") findings.push("The <summary> block is empty.");
  else {
    const length = [...output.summary].length;
    if (length > MAX_SUMMARY) {
      findings.push(`The summary is ${length} characters long; it must be at most ${MAX_SUMMARY}.`);
    }
  }
  if (output.report === null) findings.push("There is no <report>...</report> block.");
  else {
    if (output.report.length > MAX_REPORT) {
      findings.push(
        `The report is ${output.report.length} characters long; it must be at most ${MAX_REPORT}.`,
      );
    }
    const report = output.report;
    const unanswered = questions.map((_, i) => i + 1).filter((n) => !answers(report, n));
    if (unanswered.length > 0) {
      findings.push(
        `The report has no section for ${unanswered.map((n) => `「问题 ${n}」`).join(", ")}. Give each question its own heading, 「## 问题 N」.`,
      );
    }
  }
  if (output.followups.length > rules.maxFollowups) {
    findings.push(
      `There are ${output.followups.length} follow-up drafts; at most ${rules.maxFollowups} are allowed. Keep the ones that matter most.`,
    );
  }
  const config: PreflightConfig = { ...rules, research: null };
  output.followups.forEach((draft, index) => {
    const label = `Follow-up ${index + 1}${draft.title === "" ? "" : ` ("${draft.title}")`}`;
    if (draft.type === null) {
      findings.push(`${label} has no type="Feature" or type="Bug".`);
    }
    if (draft.title === "") findings.push(`${label} has no title="...".`);
    if (draft.body.length > MAX_FOLLOWUP_BODY) {
      findings.push(
        `${label} is ${draft.body.length} characters long; it must be at most ${MAX_FOLLOWUP_BODY}.`,
      );
    }
    if (draft.type === null) return;
    const typeId = draft.type === "Feature" ? rules.featureTypeId : rules.bugTypeId;
    const pre = preflight(followupIssue(draft, typeId), config);
    if (!pre.ok) for (const reason of pre.reasons) findings.push(`${label}: ${reason}`);
  });
  return findings;
};

/**
 * `description` with the 「结论」 section's content replaced by `text`, its heading kept; with no such section, one is
 * added at the end. Every other character is left as it was: people edit the rest of the work item.
 */
export const replaceConclusion = (description: string, text: string): string => {
  const section = findSection(description, CONCLUSION);
  if (section === undefined) {
    const sep = description === "" ? "" : description.endsWith("\n") ? "\n" : "\n\n";
    return `${description}${sep}## ${CONCLUSION}\n\n${text.trim()}\n`;
  }
  const lines = description.split("\n");
  const before = lines.slice(0, section.heading + 1).join("\n");
  const after = lines.slice(section.end).join("\n");
  return section.end < lines.length
    ? `${before}\n\n${text.trim()}\n\n${after}`
    : `${before}\n\n${text.trim()}\n`;
};
