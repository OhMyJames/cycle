// What the loop says to the sessions, and how it reads what they say back. Dev and QA are different people:
// QA is told only the work item, the criteria with the loop's own evidence, and the diff. It is not told what Dev
// thought (CYC-318).

import { z } from "zod";
import type { Criterion } from "./criteria.ts";
import {
  CATEGORIES,
  type Category,
  MAX_BODY,
  type PartType,
  PRIORITIES,
  type ShapeOutput,
} from "./planning.ts";
import { ALLOWED_COMMANDS, UI_CRITERIA_GUIDE } from "./preflight.ts";
import {
  type Followup,
  MAX_FOLLOWUP_BODY,
  MAX_REPORT,
  MAX_SUMMARY,
  type ResearchOutput,
} from "./research.ts";
import { type Issue, type IssueComment, MAX_QUESTIONS, type Priority } from "./types.ts";

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

/** 大档 (CYC-453): the full text of the documents a session works from; absent for a small work item. */
export type DevDocs = { design: string; plan: string };
export type FullFlowTexts = DevDocs & { spec: string };

const MAX_DOC = 100_000;

/** A document in a fence longer than any run of backticks inside it, cut (and said so) past `MAX_DOC`. */
const docBlock = (name: string, text: string): string => {
  const body = text.trim();
  const cut = body.length > MAX_DOC;
  const shown = cut
    ? `${body.slice(0, MAX_DOC)}\n[cut: the document goes on; read it in full if you need the rest]`
    : body;
  const longest = Math.max(2, ...Array.from(shown.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${name} (full text):\n${fence}markdown\n${shown}\n${fence}`;
};

const DEV_DOCS_RULE = `- This is a 完整流程 work item: build it by the Design and the Plan above, in the order the Plan gives. If you must depart from the Plan (a step done differently, skipped, added or reordered), say what and why in the progress block, under "done" for that turn. A departure with no reason written there is a defect.`;

const devDocs = (docs: DevDocs | undefined): string =>
  docs === undefined
    ? ""
    : `\nThe work item is judged by its documents. The Design and the Plan were adopted by a person:\n${docBlock("Design", docs.design)}\n\n${docBlock("Plan", docs.plan)}\n`;

export const devBrief = (
  issue: Issue,
  criteria: Criterion[],
  docs?: DevDocs,
): string => `You are the developer for work item ${issue.key}: ${issue.title}.

Work in the current directory: it is a git worktree made for this work item. Do not leave it and do not switch worktrees. Read AGENTS.md first and follow it, including the notes it points to for the area you change.

The work item:
---
${issue.description}
---
${devDocs(docs)}
The loop will check these criteria itself by running the commands; saying they pass does not make them pass:
${criteriaTable(criteria, false)}

How to work:
- Make the change and the tests it needs. Run \`bun run check\` before you finish.
- Commit as you go (\`git add -A && git commit -m "<what and why>"\`). Do not push and do not open a pull request: the loop does that.
- If the work item cannot be done as written, say so in the progress block under "next" and stop; do not guess.${docs === undefined ? "" : `\n${DEV_DOCS_RULE}`}

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
  docs?: DevDocs,
): string => `You take over work item ${issue.key}: ${issue.title}. The developer before you could not be continued. Work in the current directory (a git worktree that already holds their commits). Read AGENTS.md first.

The work item:
---
${issue.description}
---
${devDocs(docs)}${docs === undefined ? "" : `${DEV_DOCS_RULE}\n`}
Criteria and where they stand:
${criteriaTable(criteria, true)}

What the developer reported so far:
${progress.trim() === "" ? "(nothing)" : progress.trim().slice(docs === undefined ? -6000 : -20000)}

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
  docs?: FullFlowTexts,
): string => `You are an independent reviewer for work item ${issue.key}: ${issue.title}. You did not write this change and you are not told how it was made.

You are READ-ONLY. Do not edit, create, delete or commit anything, and do not run the test suites: the loop already ran them and its results are below. You may read files in the current directory (a git worktree holding the change) and use git status, git diff, git log, rg and ls.

Read AGENTS.md and check the change against its rules (protocol first, analytics that report behavior and never content, the red lines), and against the work item and its criteria.

The work item:
---
${issue.description}
---
${
  docs === undefined
    ? ""
    : `\nThis is a 完整流程 work item. A person adopted these documents; judge the change against them, not only the description:\n${docBlock("Spec", docs.spec)}\n\n${docBlock("Design", docs.design)}\n\n${docBlock("Plan", docs.plan)}\n\nReport every place where the change departs from the Plan (a step not done, done differently, added, or out of order) as a finding, even when the code works. You are not told why the developer departed: judge by effect. A departure that changes behavior the Spec or Design asks for, or leaves a Plan step undone, is "major"; one that reaches the same result by another way is "minor". Also check it still follows the Design and meets the Spec.\n`
}
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

Read REVIEW.md and AGENTS.md in full first. Judge this PR strictly against REVIEW.md (and the rules and red lines in AGENTS.md). There is no path-based floor in code: evaluate changes to any file—including cloud/loop/, .github/, AGENTS.md, or REVIEW.md—on their actual risk per REVIEW.md.

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

// The planning node's sessions (CYC-322): triage sorts the Backlog's candidates, shaping rewrites or splits one work
// item, and shaping QA compares the result with the original. All three are read-only, like research; the loop
// checks their replies with planning.ts and writes to the tracker itself.

/** One candidate as triage sees it in the table; its full body is a file in the round's bodies directory. */
export type CandidateSummary = {
  key: string;
  title: string;
  type: PartType;
  priority: Priority | null;
  /** The parent's key and title, or null for a top-level work item. */
  parent: string | null;
  /** Its links, as words (「blocks CYC-12」). */
  links: string[];
  opening: string;
  /** Characters in the body. */
  length: number;
};

/** The rest of the board, for triage to weigh the candidates against. */
export type BoardView = {
  todo: string[];
  inProgress: string[];
  /** Work items waiting for a person's approval (待批准). */
  pending: string[];
  epics: { key: string; title: string; opening: string }[];
};

const readOnlyBounds = (
  readRoots: string[],
): string => `You are READ-ONLY. Do not edit, create, delete or move files, do not commit, do not use the network, do not read credentials (.env files, keys, tokens, git config), and do not use MCP tools. Requests outside these bounds are refused, not asked about.

You may read the current directory (a git worktree of the base branch, made for this round) and these directories:
${readRoots.map((root) => `- ${root}`).join("\n")}
You may run read-only commands: cat, ls, rg, grep, head, tail, wc, du, find (without -exec, -execdir, -ok, -delete or -fprint), stat, file, and git status, git diff, git log, git show.`;

/** How criteria must be written: for triage, what can be written; for shaping, how to write it. */
const commandRules = (
  maxCriteria: number,
): string => `「验收标准」 is a numbered list of at most ${maxCriteria} items, and every item ends with 「验证：\`<command>\`」 naming one of: ${ALLOWED_COMMANDS}. A \`bun test\` path starts with \`./\` (\`bun test ./cloud/loop/test/planning.test.ts\`): without it bun reads the path as a name filter and may find nothing. The path, or the directory a new test goes in, must already exist. \`bun run test:integration <suite>\` must name a suite in scripts/integration-suites.ts. What only a person can see goes under 「## 合并后由人验收（不进 Loop）」, never in 「验收标准」.

How to write what the UI shows as criteria the loop can check:
${UI_CRITERIA_GUIDE}`;

const candidateTable = (list: CandidateSummary[]): string =>
  list
    .map(
      (c) =>
        `### ${c.key} — ${c.type}, ${c.priority ?? "no priority"}: ${c.title}\n` +
        `parent: ${c.parent ?? "none"}; links: ${c.links.length === 0 ? "none" : c.links.join(", ")}; ${c.length} characters\n` +
        `${c.opening === "" ? "(no opening paragraph)" : c.opening}`,
    )
    .join("\n\n");

const titles = (items: string[]): string =>
  items.length === 0 ? "(none)" : items.map((t) => `- ${t}`).join("\n");

const TRIAGE_OUTPUT = `End your last reply with these two blocks, and nothing after them. The loop reads only your last reply.
<triage>
{"key": "CYC-1", "category": "能做", "priority": "high", "reason": "一句话理由"}
{"key": "CYC-2", "category": "要问", "priority": "medium", "reason": "一句话理由", "questions": ["要问的问题？"]}
</triage>
<order>
CYC-1 CYC-3
</order>
In <triage>, one line per candidate, each a JSON object on a line of its own, every candidate exactly once. "category" is one of ${CATEGORIES.join(", ")}; "priority" is one of ${PRIORITIES.join(", ")}, for every candidate; "reason" is one sentence; "questions" is only for 要问, a list of at least one. In <order>, the keys of every 能做 and 要拆 candidate and of nothing else, separated by spaces, the one most worth shaping first; leave it empty when there is none. Write the reasons and questions in Chinese: they go into comments a person reads.`;

/**
 * The triage session's first turn: the candidates in summary (their full bodies are files in `bodiesDir`), the rest
 * of the board, and what each category means.
 */
export const triageBrief = (input: {
  candidates: CandidateSummary[];
  board: BoardView;
  bodiesDir: string;
  readRoots: string[];
  maxCriteria: number;
}): string => `You are the planner's triage for this project's Backlog. When the loop has nothing approved to build, it makes Backlog work items ready for a person to approve: you sort the candidates, and the loop acts on your answer. A person approves every work item before it is built; you never change one yourself.

${readOnlyBounds(input.readRoots)}

Each candidate's full body is the file <key>.md in ${input.bodiesDir}. The table has only the first paragraph: read the body, and the code it points to, before you decide.

The candidates:

${candidateTable(input.candidates)}

The rest of the board.
Todo (approved, waiting to be built):
${titles(input.board.todo)}
In Progress:
${titles(input.board.inProgress)}
Waiting for a person's approval (待批准):
${titles(input.board.pending)}
Epics:
${titles(input.board.epics.map((e) => `${e.key} ${e.title}: ${e.opening === "" ? "(no opening paragraph)" : e.opening}`))}

Put each candidate in one category:
- 能做: it can be made into one ready work item from what its body, its comments and the code say: what is wanted is clear, and each criterion can be checked by an allowed command. Example: 「Loop 清理已取消工单留下的 worktree」, with the cases named in its body.
- 要拆: worth doing and clear enough, but more than one session's work, or its criteria belong to different parts of the product. It will be split into two or more work items.
- 要问: rare. Only when a decision that only a person can make (what the product should do, what is in or out of scope) changes what gets built, and nothing settles it: not the body, its comments, the parent epic, linked work items, the code, nor a sensible default. A detail with a sensible default is not a question: put it under 能做 or 要拆, and shaping writes the default down marked 「待确认」. Open points the body already lists as 「待确认」 are not questions either, unless one of them blocks the whole work item. At most ${MAX_QUESTIONS} questions, each answerable in a sentence. Of all candidates, ask about only the few whose answers unblock the most valuable work; the loop writes at most a handful of questions per round, highest priority first, and the rest wait for a later round.
- 不适合: not for the loop: it needs a real account, a real model or an outside system, or what it must do can only be judged by a person and cannot be written as the commands below. Being about the UI is not enough to be 不适合.

How criteria must be written, which decides between 能做 and 不适合:
${commandRules(input.maxCriteria)}

Suggest a priority for every candidate: what it is worth to the people using Cycle, what it unblocks or waits for, and how it relates to the work in Todo and In Progress. Keep the current priority unless you have a reason: a change is written to the work item with your reason.

${TRIAGE_OUTPUT}`;

export const triageFixBrief = (
  round: number,
  findings: string[],
): string => `Your reply did not pass the checks (fix round ${round}). Fix what is listed. Stay read-only.

${findings.map((f) => `- ${f}`).join("\n")}

Give both blocks again, complete, not only what changed: the loop reads only your last reply.

${TRIAGE_OUTPUT}`;

/** What the shaping answer looks like for one work item: the split form depends on whether it has a parent. */
export type ShapeFormat = { key: string; type: PartType; standalone: boolean; maxSplit: number };

const SHAPE_OUTPUT = (
  f: ShapeFormat,
): string => `End your last reply with exactly one of these three forms, and nothing after it. The loop reads only your last reply.

1. A rewrite, when it stays one work item:
<title>the title, which may be the one it has now</title>
<description>
the whole new description, in Markdown
</description>
<notes>
what you changed, on what grounds (the original, a comment, a file), and what is 「待确认」
</notes>

2. A split, when it is more than one work item: 2 to ${f.maxSplit} parts, each a complete work item (its own opening paragraph, sections and 「验收标准」) of type "Feature" or "Bug".
<split>
<part type="${f.type}" title="...">
the part's description
</part>
<part type="Feature" title="...">
...
</part>
</split>
${
  f.standalone
    ? `${f.key} has no parent, so a split turns it into an Epic and every part becomes its child. Give its body as an Epic: an opening paragraph, then 「目标」, 「范围」, 「非目标」 and 「完成标准」, without listing the parts:
<epic title="...">
the Epic's description
</epic>`
    : `The first part replaces ${f.key} itself, narrowed, and keeps its type (${f.type}); the others become its siblings under the same parent, each blocking the next. Do not give <epic>.`
}
<notes>
what you changed, how you split it and why, and what is 「待确认」
</notes>

3. Questions, when it cannot be made ready without a person's answer:
<questions>
1. one question per line
</questions>

Write titles, descriptions, notes and questions in Chinese, like the work items of this project. Every description is at most ${MAX_BODY} characters.`;

const commentsList = (comments: IssueComment[]): string =>
  comments.length === 0
    ? "(none)"
    : comments
        .map((c) => `- ${c.authorName}, ${c.createdAt}:\n  ${c.body.replace(/\n/g, "\n  ")}`)
        .join("\n");

/**
 * The shaping session's first turn: one work item in full, what is around it, its template and the project's rules
 * for work items, and the three ways to answer.
 */
export const shapeBrief = (
  issue: Issue,
  input: {
    format: ShapeFormat;
    comments: IssueComment[];
    /** The parent's key, title and body, or null for a top-level work item. */
    parent: { key: string; title: string; description: string } | null;
    /** Links and siblings, as words (「blocks CYC-12 …」). */
    related: string[];
    template: string;
    /** What triage decided and why. */
    triage: { category: Category; reason: string };
    /** The sections of the work item rules (`workflowRules`). */
    rules: string;
    maxCriteria: number;
    readRoots: string[];
    /** A work item of this project written well, to follow in form (not in content); left out when there is none. */
    example?: { key: string; title: string; description: string };
  },
): string => `You are shaping work item ${issue.key}: ${issue.title}, a ${input.format.type} in Backlog, so that a person can approve it as written and the loop can then build it. You only write text: the loop checks it, an independent reviewer compares it with the original, and only then does the loop write it to the work item, keep the original in a comment and mark it 待批准 for a person.

${readOnlyBounds(input.readRoots)}

The work item now:
---
${issue.description}
---

Its comments, oldest first:
${commentsList(input.comments)}

${
  input.parent === null
    ? "It has no parent."
    : `Its parent, ${input.parent.key}: ${input.parent.title}\n---\n${input.parent.description}\n---`
}

Related work items:
${titles(input.related)}

Triage put it as ${input.triage.category}: ${input.triage.reason}

The ${input.format.type} template:
---
${input.template}
---

The project's rules for work items (from the cycle-workflow skill):
---
${input.rules}
---
${
  input.example === undefined
    ? ""
    : `
A work item of this project written well (${input.example.key}: ${input.example.title}). Follow its form: the opening paragraph, the evidence, the scope, the non-goals and how each criterion names its command. Not its content.
---
${input.example.description}
---
`
}
Rules you must keep:
- Every sentence of the original lands somewhere in what you write (in a split, in one of the parts). Drop nothing.
- Add nothing without grounds in the original, its comments or the code (name the file). What you cannot ground, write under 「待确认」, not as fact.
- Each work item is atomic: one goal, one set of criteria, one session's work. A Feature has 「非目标」.
- Every description opens with two or three sentences for a person, before its first heading.
- A title is an action and its object, in words a user sees; no type prefix (feat(...), fix(...), Epic：, 调研：) and no work item number.
- If the answer needs a person (what is wanted is unclear, or two readings lead to different work), ask instead of guessing.

How to write 「验收标准」:
${commandRules(input.maxCriteria)}

${SHAPE_OUTPUT(input.format)}`;

/** Sends the loop's findings, or QA's (`formatFindings`), back to the shaping session. */
export const shapeFixBrief = (
  round: number,
  findings: string,
  format: ShapeFormat,
): string => `Your reply did not pass the checks (fix round ${round}). Fix what is listed. Stay read-only, and keep every rule of the first message.

${findings}

Give the complete form again, not only what changed: the loop reads only your last reply.

${SHAPE_OUTPUT(format)}`;

const shapedResult = (output: ShapeOutput): string => {
  const parts: string[] = [];
  if (output.split !== null) {
    if (output.epic !== null) {
      parts.push(
        `### The work item becomes an Epic: ${output.epic.title}\n\n${output.epic.description}`,
      );
    }
    output.split.forEach((part, i) => {
      parts.push(`### Part ${i + 1}: ${part.type ?? "?"} — ${part.title}\n\n${part.description}`);
    });
  } else {
    parts.push(
      `### Title\n\n${output.title ?? "(none)"}\n\n### Description\n\n${output.description ?? "(none)"}`,
    );
  }
  parts.push(`### Notes (posted as a comment)\n\n${output.notes ?? "(none)"}`);
  return parts.join("\n\n");
};

/**
 * The shaping QA session: a second reader of the same rights, told the original, its comments and the result, and
 * not how the shaper got there. Its verdict is read by `parseVerdict` and `listsWhatWasChecked`, as for Dev's QA.
 */
export const shapeQaBrief = (
  issue: Issue,
  input: { comments: IssueComment[]; output: ShapeOutput; rules: string; readRoots: string[] },
): string => `You are an independent reviewer of how work item ${issue.key} was rewritten for a person to approve. You did not write it and you are not told how it was written.

${readOnlyBounds(input.readRoots)}

The original title: ${issue.title}

The original description:
---
${issue.description}
---

Its comments, oldest first:
${commentsList(input.comments)}

The result:

${shapedResult(input.output)}

The project's rules for work items:
---
${input.rules}
---

Check, against the original and the code:
1. Nothing is lost: every piece of information in the original and its comments is in the result (in a split, in one of the parts).
2. Nothing is invented: what was added has grounds in the original, the comments or the code; what has none is marked 「待确认」.
3. Each criterion's command really checks what the criterion says: open the test file or directory it names, and the code under test. A criterion its command cannot fail is a "major" finding.
4. Nothing can be read two ways; each work item is one atomic piece of work; each Feature has 「非目标」.
5. What only a person can see is under 「合并后由人验收（不进 Loop）」, not in 「验收标准」.
6. Each title follows the rules: an action and its object, in words a user sees, no type prefix, no work item number.

Verify before you judge: check at least three of the claims about the code yourself (open the file, run the command).

Before the verdict, write a short "What I checked" list: the files you opened and the commands you ran. A verdict with no such list is not accepted.

End with one block and nothing after it:
<verdict>
{"pass": true or false, "findings": [{"severity": "blocker" | "major" | "minor", "where": "title, section, part or criterion", "problem": "what is wrong", "fix": "what to do"}]}
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
