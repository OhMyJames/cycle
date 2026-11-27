// What the planning node's triage, shaping and QA sessions are told.

import {
  CATEGORIES,
  type Category,
  MAX_BODY,
  type PartType,
  PRIORITIES,
  type ShapeOutput,
} from "../planning.ts";
import { ALLOWED_COMMANDS, UI_CRITERIA_GUIDE } from "../preflight.ts";
import { type Issue, type IssueComment, MAX_QUESTIONS, type Priority } from "../types.ts";
import { readOnlyBounds } from "./common.ts";

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
- 能做: it can be made into one ready Level-1 work item (1 work item = 1 complete PR) from what its body, its comments and the code say: what is wanted is clear, and each criterion can be checked by an allowed command. A full-stack or cross-module requirement that ships cleanly in 1 PR belongs under 能做 (Loop breaks it into internal Level-2 Task Graph nodes on one branch; do not split technical layers like API vs UI into separate tickets). Example: 「Loop 清理已取消工单留下的 worktree」, with the cases named in its body.
- 要拆: worth doing and clear enough, and ONLY when it exceeds what one PR can reasonably carry OR consists of parts that can be scheduled and shipped independently as separate Level-1 work items. Do not mark a single 1-PR full-stack requirement as 要拆 just because it spans multiple modules or needs multiple Dev sessions.
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

2. A split, ONLY when the work exceeds one PR's capacity or can be scheduled and shipped independently: 2 to ${f.maxSplit} parts, each an independently shippable Level-1 work item (1 item = 1 PR, with its own opening paragraph, sections and 「验收标准」) of type "Feature" or "Bug". Do not split a single 1-PR full-stack requirement into technical-layer sub-tickets (use Form 1 rewrite instead; Loop executes internal layers via its Level-2 Task Graph).
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
    ? `${f.key} has no parent. Keep it as one Level-1 work item (Form 1 rewrite) whenever it can ship in 1 PR—do not turn a 1-PR requirement into an Epic of technical sub-tickets. Only when it genuinely must be split into multiple independently shippable Level-1 work items (each 1 PR), a split turns ${f.key} into an Epic container and every part becomes its child. Give its body as an Epic: an opening paragraph, then 「目标」, 「范围」, 「非目标」 and 「完成标准」, without listing the parts:
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
- Each work item is one Level-1 business unit (1 item = 1 complete PR): one goal and one end-to-end set of criteria. Keep a 1-PR full-stack requirement as one work item (Loop handles internal multi-step execution with its Level-2 Task Graph); only split when it exceeds one PR or parts can ship independently. A Feature has 「非目标」.
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
4. Nothing can be read two ways; each work item is one Level-1 unit deliverable in 1 PR (do not require splitting a 1-PR full-stack requirement into technical sub-tickets); each Feature has 「非目标」.
5. What only a person can see is under 「合并后由人验收（不进 Loop）」, not in 「验收标准」.
6. Each title follows the rules: an action and its object, in words a user sees, no type prefix, no work item number.

Verify before you judge: check at least three of the claims about the code yourself (open the file, run the command).

Before the verdict, write a short "What I checked" list: the files you opened and the commands you ran. A verdict with no such list is not accepted.

End with one block and nothing after it:
<verdict>
{"pass": true or false, "findings": [{"severity": "blocker" | "major" | "minor", "where": "title, section, part or criterion", "problem": "what is wrong", "fix": "what to do"}]}
</verdict>
"pass": true only when there is no blocker or major finding.`;
