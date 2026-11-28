// What a research session and its QA are told.

import {
  type Followup,
  MAX_FOLLOWUP_BODY,
  MAX_REPORT,
  MAX_SUMMARY,
  type ResearchOutput,
} from "../flows/research/output.ts";
import { ALLOWED_COMMANDS } from "../preflight.ts";
import type { Issue } from "../types.ts";
import { numbered } from "./common.ts";

export const RESEARCH_OUTPUT = (
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

// The planning node's sessions (CYC-322): triage sorts the Backlog's candidates, shaping rewrites or splits one work
// item, and shaping QA compares the result with the original. All three are read-only, like research; the loop
// checks their replies with planning.ts and writes to the tracker itself.

const NODE_OUTPUT = `End your last reply with these blocks, and nothing after them. The loop reads only your last reply and keeps what is in the blocks on the execution graph node; the Dev nodes that depend on this one are given the report.
<summary>
One paragraph: the answer, in at most ${MAX_SUMMARY} characters.
</summary>
<report>
The full report in Markdown, with the answer under the heading 「## 问题 1」, and its evidence.
</report>
Do not write <followup> blocks: nothing is drafted from a research node of a graph.`;

/** A research node of a feature's graph: read-only, its goal is the question, and the report goes to the Dev nodes after it. */
export const nodeResearchBrief = (
  issue: Issue,
  node: { id: string; title: string; goal: string; filesHint: string[] },
  bounds: { readRoots: string[] },
): string => `You are the researcher executing read-only Task Node \`${node.id}\` (${node.title}) for Level-1 work item ${issue.key}: ${issue.title}.

You are READ-ONLY. Do not edit, create, delete or move files, do not commit, do not use the network, do not read credentials (.env files, keys, tokens, git config), and do not use MCP tools. Requests outside these bounds are refused, not asked about.

Work in the current directory: it is the shared git worktree for ${issue.key}. You may also read these directories:
${bounds.readRoots.length > 0 ? bounds.readRoots.map((root) => `- ${root}`).join("\n") : "- (none)"}
You may run read-only commands: cat, ls, rg, grep, head, tail, wc, du, find (without -exec, -execdir, -ok, -delete or -fprint), stat, file, and git status, git diff, git log, git show.

The work item:
---
${issue.description}
---

Your node's goal, the question to answer:
${node.goal}
${node.filesHint.length > 0 ? `\nWhere to look first:\n${node.filesHint.map((f) => `- \`${f}\``).join("\n")}\n` : ""}
How to work:
- Back every conclusion with evidence: a file path and line number, or a command and what it printed.
- What needs a person, needs the network, or was refused, write as 「未验证」 with the reason. Do not guess.
- Never quote a secret. Name an environment variable or a key by its name alone.

${NODE_OUTPUT}`;

export const nodeResearchFixBrief = (
  node: { id: string; title: string },
  round: number,
  findings: string,
): string => `Your reply for node \`${node.id}\` (${node.title}) did not pass the checks (fix round ${round}). Fix what is listed. Stay read-only.

${findings}

Give the complete blocks again, not only what changed: the loop reads only your last reply.

${NODE_OUTPUT}`;

/** What a replacing research session is told on top of the first brief: the report that was sent back, and why. */
export const researchReworkNote = (
  report: string,
  findings: string,
): string => `An earlier report on this work item was sent back by independent review. You are a new session: you did not write it. Here it is:
---
${report === "" ? "(none)" : report}
---

What was found:
${findings}

Answer the questions again and fix what was found; do not repeat the same faults. Give the complete blocks.`;
