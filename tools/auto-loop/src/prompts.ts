// What the loop says to the sessions, and how it reads what they say back. Dev and QA are different people:
// QA is told only the work item, the criteria with the loop's own evidence, and the diff. It is not told what Dev
// thought (CYC-318).

import { z } from "zod";
import type { Criterion } from "./criteria.ts";
import { ALLOWED_COMMANDS } from "./preflight.ts";
import {
  type Followup,
  MAX_FOLLOWUP_BODY,
  MAX_REPORT,
  MAX_SUMMARY,
  type ResearchOutput,
} from "./research.ts";
import type { Issue } from "./types.ts";

const criteriaTable = (criteria: Criterion[], withEvidence: boolean): string =>
  criteria
    .map((c) => {
      const commands = c.verify.map((argv) => `\`${argv.join(" ")}\``).join(", ");
      const result = withEvidence ? ` — ${c.status}` : "";
      return `${c.id}. ${c.text}\n   checked by: ${commands}${result}`;
    })
    .join("\n");

const PROGRESS_RULE = `End every turn with a block, and nothing after it:
<progress>
done: what you did this turn
next: what is left, or "nothing" if every criterion should now pass
</progress>`;

export const devBrief = (
  issue: Issue,
  criteria: Criterion[],
): string => `You are the developer for work item ${issue.key}: ${issue.title}.

Work in the current directory: it is a git worktree made for this work item. Do not leave it and do not switch worktrees. Read AGENTS.md first and follow it, including the notes it points to for the area you change.

The work item:
---
${issue.description}
---

The loop will check these criteria itself by running the commands; saying they pass does not make them pass:
${criteriaTable(criteria, false)}

How to work:
- Make the change and the tests it needs. Run \`bun run check\` before you finish.
- Commit as you go (\`git add -A && git commit -m "<what and why>"\`). Do not push and do not open a pull request: the loop does that.
- If the work item cannot be done as written, say so in the progress block under "next" and stop; do not guess.

${PROGRESS_RULE}`;

export const fixBrief = (
  round: number,
  findings: string,
): string => `The checks did not pass (fix round ${round}). Fix what is listed, run \`bun run check\`, commit, and report.

${findings}

${PROGRESS_RULE}`;

export const conflictBrief = (
  issue: Issue,
  baseRef: string,
  files: string[],
  theirCommits: string[],
): string => `The loop merged ${baseRef} into this branch and the merge stopped on a conflict. It is left open in the worktree for you to resolve. Work item ${issue.key}: ${issue.title}.

The work item, so you know what this branch is for:
---
${issue.description}
---

Conflicted files:
${files.map((f) => `- ${f}`).join("\n")}

What changed on ${baseRef} in those files (commit titles):
${theirCommits.length > 0 ? theirCommits.map((c) => `- ${c}`).join("\n") : "- (none found)"}

How to work:
- Resolve each conflicted file so that the intent of both sides is kept: this work item's goal and what ${baseRef} changed. Remove every conflict marker.
- Do not run \`git merge --abort\`, do not rebase, and do not push: the loop pushes.
- Finish the merge with a merge commit (\`git add\` the files, then \`git commit --no-edit\`).
- Run \`bun run check\` before you finish.
- If you cannot resolve it, say so in the progress block under "next" and stop; do not guess.

${PROGRESS_RULE}`;

export const continueBrief = (issue: Issue, resumedByPerson: boolean): string => `${
  resumedByPerson
    ? `A person looked at ${issue.key} and put it back: what they said is in this conversation. The work item may have changed; here it is now:\n---\n${issue.description}\n---\n`
    : `The loop was restarted. Carry on with ${issue.key}.\n`
}
Look at \`git log\` and \`git status\` to see where the work is, finish what is left, run \`bun run check\`, commit, and report.

${PROGRESS_RULE}`;

/** For a new session that takes over from one that could not be continued. */
export const handoffBrief = (
  issue: Issue,
  criteria: Criterion[],
  progress: string,
  gitLog: string,
  findings?: string | null,
): string => `You take over work item ${issue.key}: ${issue.title}. The developer before you could not be continued. Work in the current directory (a git worktree that already holds their commits). Read AGENTS.md first.

The work item:
---
${issue.description}
---

Criteria and where they stand:
${criteriaTable(criteria, true)}

What the developer reported so far:
${progress.trim() === "" ? "(nothing)" : progress.trim().slice(-6000)}

Commits so far:
${gitLog.trim() === "" ? "(none)" : gitLog.trim()}${
  findings != null && findings.trim() !== ""
    ? `\n\nLatest findings to fix:\n${findings.trim()}`
    : ""
}

Finish what is left, run \`bun run check\`, commit (do not push), and report.

${PROGRESS_RULE}`;

const MAX_DIFF = 120_000;

export const qaBrief = (
  issue: Issue,
  criteria: Criterion[],
  diff: string,
  checks: string,
  conflictFiles: string[] = [],
): string => `You are an independent reviewer for work item ${issue.key}: ${issue.title}. You did not write this change and you are not told how it was made.

You are READ-ONLY. Do not edit, create, delete or commit anything, and do not run the test suites: the loop already ran them and its results are below. You may read files in the current directory (a git worktree holding the change) and use git status, git diff, git log, rg and ls.

Read AGENTS.md and check the change against its rules (protocol first, analytics that report behavior and never content, the red lines), and against the work item and its criteria.

The work item:
---
${issue.description}
---

The loop ran these checks, and these are their results:
${checks}

The criteria, each run by the loop, with its result:
${criteriaTable(criteria, true)}

${
  conflictFiles.length > 0
    ? `The branch merged the base after a merge conflict, which the developer resolved by hand in these files. Look at them with care: the resolution must keep the intent of both sides.\n${conflictFiles.map((f) => `- ${f}`).join("\n")}\n\n`
    : ""
}The change (git diff against the base${diff.length > MAX_DIFF ? ", cut short" : ""}):
\`\`\`diff
${diff.slice(0, MAX_DIFF)}
\`\`\`

The change is already committed, so \`git status\` showing nothing is expected; use \`git diff\` and \`git log\` against the base to see it.

Verify before you judge; do not conclude from the diff above alone. Open every changed file in full, and the code it touches or is tested against (the module under test, its callers, the neighbouring tests and how they are written). Confirm for yourself that each criterion is met in meaning, not only that its command passed: for a test, that it would fail if the behavior broke; for a change, that it does what the work item says and nothing more. A pass you did not check is a failure of this review.

Run the code-review skill on this change at effort level "high" (the Skill tool, skill "code-review", args "high"), against the base given above. Review only: never pass --fix or --comment, and do not edit, commit or post anything. If the skill is not available to you, say so in "What I checked" and do the review by hand. Map what it reports onto the verdict: a finding it calls important is "major" (or "blocker" if it breaks correctness or security), a nit is "minor". A finding that was already in the code before this change is not this change's fault: report it as "minor".

Then review adversarially yourself. Look for what the tests do not prove: a criterion met in letter and not in meaning, a rule of AGENTS.md broken, behavior not covered, a change that is more than the work item asked.

Before the verdict, write a short "What I checked" list: the files you opened and the commands you ran. A verdict with no such list is not accepted.

End with one block and nothing after it:
<verdict>
{"pass": true or false, "findings": [{"severity": "blocker" | "major" | "minor", "where": "file or area", "problem": "what is wrong", "fix": "what to do"}]}
</verdict>
"pass": true only when there is no blocker or major finding.`;

/**
 * Independent PR review prompt run after a PR is open and CI has finished (CYC-332). Read-only, references
 * `REVIEW.md`, and requires one of three structured `<review>` JSON conclusions (`merge`, `reject`, or `escalate`).
 */
export const reviewBrief = (
  issue: Issue,
  prUrl: string,
  criteria: Criterion[],
  diff: string,
  ciChecks: readonly string[],
  retryNote?: string,
  resolvedFiles: readonly string[] = [],
): string => `You are an independent PR reviewer for pull request ${prUrl} (${issue.key}: ${issue.title}). You did not write this change and you are not told how it was made.

You are READ-ONLY. Do not edit, create, delete, commit, push, merge, or comment on GitHub yourself: the loop will post your conclusion as a PR comment and act on it. You may read files in the current directory (a git worktree holding the PR commit) and use git status, git diff, git log, rg, and ls.

Read REVIEW.md and AGENTS.md in full first. Judge this PR strictly against REVIEW.md (and the rules and red lines in AGENTS.md). There is no path-based floor in code: evaluate changes to any file—including tools/auto-loop/, .github/, AGENTS.md, or REVIEW.md—on their actual risk per REVIEW.md.

The work item:
---
${issue.description}
---

Required CI checks that passed on this PR: ${ciChecks.length > 0 ? ciChecks.join(", ") : "(none)"}
${resolvedFiles.length > 0 ? `\nThe base branch was merged into this branch and the loop's Dev resolved conflicts in: ${resolvedFiles.join(", ")}. The merge commit is not a change of the work item: read how each of those files was resolved (both sides kept where they should be, nothing of the base or of the work item lost) and judge the merged result.\n` : ""}
The criteria, each run by the loop, with its result:
${criteriaTable(criteria, true)}

The change (git diff against the base${diff.length > MAX_DIFF ? ", cut short" : ""}):
\`\`\`diff
${diff.slice(0, MAX_DIFF)}
\`\`\`

Verify before you judge; do not conclude from the diff above alone. Open the changed files and relevant callers/tests in full, confirm the change matches REVIEW.md and the work item in meaning, and choose exactly ONE of the three decisions:
- "merge": every requirement in REVIEW.md is satisfied, there is no blocker or major finding, and no human judgment is needed. When CI is all green, the loop enables GitHub auto-merge (squash).
- "reject": there is at least one blocker or major issue that Dev should fix (bugs, missing tests, broken criteria, fixable AGENTS.md violations, or out-of-scope edits). The loop posts your review and sends the work item back to Dev to fix, re-run CI, and re-review. List concrete issues in "findings" and/or "reasons".
- "escalate": human judgment is required (weakened security/CI/review boundaries, irreversible data changes, unauthorized architectural/product trade-offs, business ambiguity, or risk that cannot be verified read-only). The loop moves the work item to In Review without enabling auto-merge. List concrete reasons in "reasons".
${retryNote != null && retryNote.trim() !== "" ? `\nNote from previous review attempt: ${retryNote.trim()}\n` : ""}
Before your conclusion, write a short "What I checked" list: the files you opened and the commands you ran. A "merge" decision without this list is not accepted.

End with one structured JSON block and nothing after it:
<review>
{"decision": "merge" | "reject" | "escalate", "summary": "one-sentence conclusion", "reasons": ["concrete reason 1", "..."], "findings": [{"severity": "blocker" | "major" | "minor", "where": "file or area", "problem": "what is wrong", "fix": "what to do"}]}
</review>
You MUST choose one of "merge", "reject", or "escalate"; leaving no conclusion is not allowed. Use "merge" only when every requirement in REVIEW.md is satisfied, there is no blocker or major finding, and no human judgment is needed.`;

const numbered = (items: string[]): string => items.map((q, i) => `${i + 1}. ${q}`).join("\n");

const RESEARCH_OUTPUT = (
  maxFollowups: number,
): string => `End your last reply with these blocks, and nothing after them. The loop reads only your last reply, and publishes what is in the blocks: the report as a document, the summary into the work item's 「结论」 section, each follow-up as a new work item in Backlog for a person to approve.
<summary>
One paragraph for a person: the answer, in at most ${MAX_SUMMARY} characters.
</summary>
<report>
The full report in Markdown, one section per question headed 「## 问题 N」 (N as numbered above), each answer with its evidence.
</report>
<followup type="Feature" title="...">
The follow-up work item's description, in Markdown.
</followup>
Write zero to ${maxFollowups} <followup> blocks, each once; type is "Feature" or "Bug". Write each follow-up in Chinese, like the work items of this project: the title says the action and what it acts on (「Loop 清理已取消工单留下的 worktree」), with no type prefix and no work item number, and the description opens with two or three sentences for a person (what, why, what done looks like) before its sections. The report must be at most ${MAX_REPORT} characters, each follow-up at most ${MAX_FOLLOWUP_BODY}.`;

/**
 * The research session's first turn (CYC-447). It may only read: the policy denies everything else without asking, so
 * the session is told the bounds up front rather than finding them by being refused.
 */
export const researchBrief = (
  issue: Issue,
  questions: string[],
  bounds: { readRoots: string[]; maxFollowups: number; maxCriteria: number },
): string => `You are the researcher for work item ${issue.key}: ${issue.title}.

You are READ-ONLY. Do not edit, create, delete or move files, do not commit, do not use the network, do not read credentials (.env files, keys, tokens, git config), and do not use MCP tools. Requests outside these bounds are refused, not asked about.

You may read the current directory (a git worktree of the base branch, made for this work item) and these directories:
${bounds.readRoots.map((root) => `- ${root}`).join("\n")}
You may run read-only commands: cat, ls, rg, grep, head, tail, wc, du, find (without -exec, -execdir, -ok, -delete or -fprint), stat, file, and git status, git diff, git log, git show.

The work item:
---
${issue.description}
---

The questions to answer:
${numbered(questions)}

How to work:
- Stay within the work item's 「方法与范围」.
- Back every conclusion with evidence: a file path and line number, or a command and what it printed.
- What needs a person, needs the network, or was refused, write as 「未验证」 with the reason. Do not guess.
- Never quote a secret. Name an environment variable or a key by its name alone, never as \`NAME=value\`, not even with a placeholder value: the loop does not publish a report that looks like it holds a credential.

Follow-up work items, if the research shows work to be done. Each must be ready for a person to approve as written:
- A Feature has the sections 「背景与证据」, 「范围」, 「非目标」, 「涉及面」 and 「验收标准」.
- A Bug has the sections 「现象」, 「复现步骤」, 「预期与实际」, 「环境与版本」, 「严重度」 and 「验收标准」.
- 「验收标准」 is a numbered list of at most ${bounds.maxCriteria} items, and every item ends with 「验证：\`<command>\`」 naming one of: ${ALLOWED_COMMANDS}.
- The title is an action and its object (as in "Loop: record a person's answer that arrives after its turn ended").

${RESEARCH_OUTPUT(bounds.maxFollowups)}`;

export const researchFixBrief = (
  round: number,
  findings: string,
  maxFollowups: number,
): string => `Your reply did not pass the checks (fix round ${round}). Fix what is listed. Stay read-only.

${findings}

Give the complete blocks again, not only what changed: the loop reads only your last reply.

${RESEARCH_OUTPUT(maxFollowups)}`;

export const researchContinueBrief = (
  issue: Issue,
  resumedByPerson: boolean,
  maxFollowups: number,
): string => `${
  resumedByPerson
    ? `A person looked at ${issue.key} and put it back: what they said is in this conversation.`
    : `The loop was restarted. Carry on with ${issue.key}.`
} The work item may have changed; here it is now:
---
${issue.description}
---

Stay read-only. Finish the research and give the complete blocks again.

${RESEARCH_OUTPUT(maxFollowups)}`;

const followupsList = (followups: Followup[]): string =>
  followups.length === 0
    ? "(none)"
    : followups
        .map((f, i) => `### Follow-up ${i + 1}: ${f.type ?? "?"} — ${f.title}\n\n${f.body}`)
        .join("\n\n");

/**
 * The research QA session: a second reader of the same rights, told the work item, the report and the drafts, and not
 * how the researcher got there. Its verdict is read by `parseVerdict` and `listsWhatWasChecked`, as for Dev's QA.
 */
export const researchQaBrief = (
  issue: Issue,
  questions: string[],
  output: ResearchOutput,
  readRoots: string[],
): string => `You are an independent reviewer of the research for work item ${issue.key}: ${issue.title}. You did not do this research and you are not told how it was done.

You are READ-ONLY, with the same rights as the researcher: read files in the current directory (a git worktree of the base branch) and these directories, and run read-only commands (cat, ls, rg, grep, head, tail, wc, du, find, stat, file, git status, git diff, git log, git show). The evidence may point anywhere in them:
${readRoots.map((root) => `- ${root}`).join("\n")}
Do not edit, create or delete anything, do not use the network and do not use MCP tools. Requests outside these bounds are refused, not asked about.

The work item:
---
${issue.description}
---

The questions:
${numbered(questions)}

The summary:
${output.summary ?? "(none)"}

The report:
${output.report ?? "(none)"}

The follow-up drafts:
${followupsList(output.followups)}

Check four things:
1. Every question has an answer.
2. Every answer has evidence: a file path (with a line), or a command and its output.
3. What was not confirmed is marked 「未验证」, with a reason.
4. Nothing goes beyond the work item's 「方法与范围」.

Verify before you judge: pick at least three pieces of evidence from the report and check them yourself (open the file at that line, run the command). Evidence that does not hold is a "major" finding. Also check that each follow-up draft follows from the report.

Before the verdict, write a short "What I checked" list: the files you opened and the commands you ran. A verdict with no such list is not accepted.

End with one block and nothing after it:
<verdict>
{"pass": true or false, "findings": [{"severity": "blocker" | "major" | "minor", "where": "question, section or follow-up", "problem": "what is wrong", "fix": "what to do"}]}
</verdict>
"pass": true only when there is no blocker or major finding.`;

export const parseProgress = (text: string): string | undefined => {
  const matches = Array.from(text.matchAll(/<progress>([\s\S]*?)<\/progress>/g));
  const last = matches.at(-1);
  return last === undefined ? undefined : (last[1] as string).trim();
};

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
  const last = Array.from(text.matchAll(/<verdict>([\s\S]*?)<\/verdict>/g)).at(-1);
  if (last === undefined) return undefined;
  try {
    const verdict = VerdictSchema.parse(JSON.parse((last[1] as string).trim()));
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
  const last = Array.from(text.matchAll(/<review>([\s\S]*?)<\/review>/g)).at(-1);
  if (last === undefined) return undefined;
  try {
    const verdict = ReviewVerdictSchema.parse(JSON.parse((last[1] as string).trim()));
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
