// 大档 (CYC-328): a work item with the 「完整流程」 label is judged by its four documents, not by its description. The
// documents are linked to the work item and found by title (`[CYC-<num>] Intent` and so on); each must be 已锁定
// (the convention for 已采纳). The criteria are the Spec's. The versions are recorded when the run starts, and a
// change while it runs sends it to Blocked for a person to say whether the plan changed or a document was touched.

import { type CriterionSpec, parseCriteria, verifyArgv } from "./criteria.ts";
import { ALLOWED_COMMANDS } from "./preflight.ts";
import type { Config, Issue, IssueDocument, Tracker } from "./types.ts";

export const FULL_FLOW_DOCS = ["Intent", "Spec", "Design", "Plan"] as const;

/** The mark on every reason and comment that says the documents, not the code, are what a person must look at. */
export const NEEDS_SPEC = "[Blocked:需规格]";

export type DocVersion = { id: number; title: string; version: number };

export type FullFlowRead =
  | { ok: true; docs: DocVersion[]; byName: Record<(typeof FULL_FLOW_DOCS)[number], DocVersion> }
  | { ok: false; reasons: string[] };

/** Whether the work item is 大档: it has the label. The loop does not judge this itself. */
export const isFullFlow = (
  issue: Pick<Issue, "labelIds">,
  config: Pick<Config, "fullFlowLabelId">,
) => config.fullFlowLabelId !== null && issue.labelIds.includes(config.fullFlowLabelId);

/** The four documents among those linked to the work item: each present once, with the exact title prefix, and locked. */
export const readFullFlowDocs = (
  issue: Pick<Issue, "key">,
  linked: IssueDocument[],
): FullFlowRead => {
  const reasons: string[] = [];
  const byName = {} as Record<(typeof FULL_FLOW_DOCS)[number], DocVersion>;
  for (const name of FULL_FLOW_DOCS) {
    const title = `[${issue.key}] ${name}`;
    const found = linked.filter((d) => !d.archived && d.title.trim() === title);
    if (found.length === 0) {
      reasons.push(`The document 「${title}」 is not linked to the work item.`);
    } else if (found.length > 1) {
      reasons.push(`${found.length} documents are titled 「${title}」; keep one.`);
    } else if (found[0]?.locked !== true) {
      reasons.push(`The document 「${title}」 is not locked (not yet adopted).`);
    } else {
      byName[name] = { id: found[0].id, title, version: found[0].version };
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, byName, docs: FULL_FLOW_DOCS.map((n) => byName[n]) };
};

export type FullFlowPreflight =
  | { ok: true; specs: CriterionSpec[]; docs: DocVersion[] }
  | { ok: false; reasons: string[] };

/** 预检 for 大档: the four documents, and the criteria in the Spec (the same rules as a description's). */
export const fullFlowPreflight = async (
  issue: Issue,
  config: Pick<Config, "maxCriteria">,
  tracker: Pick<Tracker, "listIssueDocuments" | "getDocumentContent">,
): Promise<FullFlowPreflight> => {
  const read = readFullFlowDocs(issue, await tracker.listIssueDocuments(issue));
  if (!read.ok) return { ok: false, reasons: marked(read.reasons) };
  const spec = await tracker.getDocumentContent(read.byName.Spec.id);
  const reasons: string[] = [];
  const parsed = parseCriteria(spec);
  if (parsed.length === 0) {
    reasons.push(
      "The Spec has no list of acceptance criteria (a list under a 「验收标准」 heading).",
    );
  }
  if (parsed.length > config.maxCriteria) {
    reasons.push(
      `The Spec has ${parsed.length} criteria, more than one session can finish (at most ${config.maxCriteria}).`,
    );
  }
  const specs: CriterionSpec[] = [];
  parsed.forEach((criterion, index) => {
    const label = `Spec criterion ${index + 1}`;
    if (criterion.commands.length === 0) {
      reasons.push(`${label} names no command to check it. Add 「验证：\`bun test <path>\`」.`);
      return;
    }
    const argv = verifyArgv(criterion.commands);
    if (!argv.ok) {
      reasons.push(
        `${label} names a command the loop may not run: ${argv.rejected.map((c) => `\`${c}\``).join(", ")}. Allowed: ${ALLOWED_COMMANDS}.`,
      );
      return;
    }
    specs.push({ text: criterion.text, verify: argv.argv });
  });
  return reasons.length > 0
    ? { ok: false, reasons: marked(reasons) }
    : { ok: true, specs, docs: read.docs };
};

const marked = (reasons: string[]): string[] =>
  reasons.map((r, i) => (i === 0 ? `${NEEDS_SPEC} ${r}` : r));

/**
 * What changed in the documents since the run began, in words for the Blocked comment; undefined when nothing did.
 * A document that is gone, unlocked, or at another version counts.
 */
export const docChanges = (recorded: DocVersion[], linked: IssueDocument[]): string | undefined => {
  const changes: string[] = [];
  for (const doc of recorded) {
    const now = linked.find((d) => d.id === doc.id && !d.archived);
    if (now === undefined) changes.push(`「${doc.title}」 is no longer linked`);
    else if (now.version !== doc.version)
      changes.push(`「${doc.title}」 went from version ${doc.version} to ${now.version}`);
    else if (!now.locked) changes.push(`「${doc.title}」 was unlocked`);
  }
  return changes.length === 0 ? undefined : changes.join("; ");
};

export const changedReason = (changes: string): string =>
  `${NEEDS_SPEC} 文档在运行中变了：${changes}。请确认是计划变更还是误改。`;
