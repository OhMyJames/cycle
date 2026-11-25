// What the loop says to the sessions, and how it reads what they say back. Dev and QA are different people:
// QA is told only the work item, the criteria with the loop's own evidence, and the diff. It is not told what Dev
// thought (CYC-318).

import { z } from "zod";
import type { Criterion } from "./criteria.ts";
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
${gitLog.trim() === "" ? "(none)" : gitLog.trim()}

Finish what is left, run \`bun run check\`, commit (do not push), and report.

${PROGRESS_RULE}`;

const MAX_DIFF = 120_000;

export const qaBrief = (
  issue: Issue,
  criteria: Criterion[],
  diff: string,
  checks: string,
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

The change (git diff against the base${diff.length > MAX_DIFF ? ", cut short" : ""}):
\`\`\`diff
${diff.slice(0, MAX_DIFF)}
\`\`\`

Review adversarially. Look for what the tests do not prove: a criterion met in letter and not in meaning, a rule of AGENTS.md broken, behavior not covered, a change that is more than the work item asked.

End with one block and nothing after it:
<verdict>
{"pass": true or false, "findings": [{"severity": "blocker" | "major" | "minor", "where": "file or area", "problem": "what is wrong", "fix": "what to do"}]}
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

export const formatFindings = (verdict: Verdict): string =>
  verdict.findings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.problem}\n   fix: ${f.fix}`)
    .join("\n");
