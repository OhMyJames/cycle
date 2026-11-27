// What independent QA is told.

import type { Criterion } from "../criteria.ts";
import { formatGraphTable, type TaskGraph } from "../graph.ts";
import type { Issue } from "../types.ts";
import { criteriaTable, diffBlock, docBlock, MAX_DIFF } from "./common.ts";
import type { FullFlowTexts } from "./dev.ts";

export const qaBrief = (
  issue: Issue,
  criteria: Criterion[],
  diff: string,
  checks: string,
  conflictFiles: string[] = [],
  docs?: FullFlowTexts,
  graph?: TaskGraph,
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
}${
  graph === undefined
    ? ""
    : `\nExecution Task Graph (executed sequentially on this branch; verify that all nodes fit together with no integration gaps):\n${formatGraphTable(graph, { includeCommits: true })}\n`
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
${diffBlock(diff)}

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
