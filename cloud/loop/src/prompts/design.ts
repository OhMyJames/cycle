// What a design session is told (CYC-545): the research bounds, a report that compares alternatives and recommends one.

import { ALLOWED_COMMANDS } from "../preflight.ts";
import type { Issue } from "../types.ts";
import { numbered } from "./common.ts";
import { RESEARCH_OUTPUT } from "./research.ts";

const DESIGN_REPORT = `The report must hold, besides one section per question (「## 问题 N」, each answered one by one):
- 「## 备选方案对比」: at least two real alternatives, each with what it is, what it costs and what it risks, compared on the work item's constraints.
- 「## 推荐」: which alternative to take, and why; what you would not do.
The design is a recommendation for a person to read: do not change anything yourself.`;

/** The design session's first turn: read-only like research, but it compares alternatives and recommends one. */
export const designBrief = (
  issue: Issue,
  questions: string[],
  bounds: { readRoots: string[]; maxFollowups: number; maxCriteria: number },
): string => `You are the designer for work item ${issue.key}: ${issue.title}.

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
- Stay within the work item's 「背景与约束」; read the code and documents the design touches before you compare.
- Back every claim with evidence: a file path and line number, or a command and what it printed.
- What needs a person, needs the network, or was refused, write as 「未验证」 with the reason. Do not guess.
- Never quote a secret. Name an environment variable or a key by its name alone, never as \`NAME=value\`.

${DESIGN_REPORT}

Follow-up work items, if the design shows work to be done. Each must be ready for a person to approve as written:
- A Feature has the sections 「背景与证据」, 「范围」, 「非目标」, 「涉及面」 and 「验收标准」.
- A Bug has the sections 「现象」, 「复现步骤」, 「预期与实际」, 「环境与版本」, 「严重度」 and 「验收标准」.
- 「验收标准」 is a numbered list of at most ${bounds.maxCriteria} items, and every item ends with 「验证：\`<command>\`」 naming one of: ${ALLOWED_COMMANDS}.

${RESEARCH_OUTPUT(bounds.maxFollowups)}`;
