// What Dev is told: the first brief, the fix rounds, a conflict, going on and a hand-over.

import type { Criterion } from "../criteria.ts";
import type { Issue } from "../types.ts";
import { criteriaTable, docBlock, PROGRESS_RULE as PROGRESS } from "./common.ts";

/** Dev's way to ask a person (CYC-494): the loop does not check, count a round or let it go on until they answer. */
const QUESTION_RULE = `If, and only if, the work item does not say enough, or doing it as written would delete or change existing features or go beyond its scope, so that a person must decide: put one <question>...</question> block in your reply with the question and the options you see. Then stop; do not decide it yourself or do that thing. Do not ask about anything else.`;
const PROGRESS_RULE = `${QUESTION_RULE}\n\n${PROGRESS}`;

/** 大档 (CYC-453): the full text of the documents a session works from; absent for a small work item. */
export type DevDocs = { design: string; plan: string };
export type FullFlowTexts = DevDocs & { spec: string };

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

/** CYC-467: a person edited the work item while it was blocked; said before whatever the turn is about. */
export const bodyChangedNotice = (
  issue: Issue,
  criteria: Criterion[],
): string => `A person edited ${issue.key} after it was blocked. What you concluded before may no longer hold: judge the work by the work item as it is now, not by what it said then. The work item now:
---
${issue.description}
---

The acceptance criteria, read again from it:
${criteriaTable(criteria, false)}

`;

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
${resumedByPerson ? "First read the latest comments and the body of the work item: the answer to your question is there.\n" : ""}Look at \`git log\` and \`git status\` to see where the work is, finish what is left, run \`bun run check\`, commit, and report.

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
