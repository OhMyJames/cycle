// What the read-only graph planner is told (CYC-509).

import { PLANNER_MAX_NODES, PLANNER_MIN_NODES } from "../graph-plan.ts";
import { ALLOWED_COMMANDS } from "../preflight.ts";
import type { Issue } from "../types.ts";

const OUTPUT_RULES = `End your last reply with ONE fenced json block holding the graph, and nothing after it:
\`\`\`json
{ "nodes": [
  { "id": "n1", "title": "...", "goal": "...", "dependsOn": [], "filesHint": ["relative/path/or/dir/"], "verify": ["bun test ./path/to/a.test.ts"] }
] }
\`\`\`
Rules, all checked by the loop:
- ${PLANNER_MIN_NODES} to ${PLANNER_MAX_NODES} nodes; each is one coherent step that one Dev session can finish and verify on its own.
- \`id\` is 1–32 lowercase letters, digits, "-" or "_", unique, and does not start with "fix-".
- \`dependsOn\` lists ids of earlier steps it needs; no cycles, no unknown ids.
- \`filesHint\` entries are paths relative to the worktree root: no absolute paths, no "..".
- Every \`verify\` command is one of: ${ALLOWED_COMMANDS}. A \`bun test\` path starts with "./" and must exist or sit in a directory that does.
- Order the work so that contracts and lower layers come first; the last node leaves the whole work item's criteria satisfied.`;

/** The graph planner's first turn: read the worktree, then split the work item into 2–4 nodes. */
export const graphPlannerBrief = (
  issue: Issue,
): string => `You are the graph planner for work item ${issue.key}: ${issue.title}.

You are READ-ONLY. Do not edit, create, delete or move files, do not commit, do not use the network, do not read credentials, and do not use MCP tools. Requests outside these bounds are refused. Read AGENTS.md first, then the code the work item touches, in the current directory (a git worktree of the base branch).

The work item:
---
${issue.description}
---

Split it into an execution graph of ${PLANNER_MIN_NODES} to ${PLANNER_MAX_NODES} nodes. The loop will run the nodes one after another on the same branch, each in a fresh Dev session, then verify the whole work item.

${OUTPUT_RULES}`;

/** The correction turn, in the same session, naming what the loop rejected. */
export const graphPlannerFixBrief = (reasons: string[], turn: number, maxTurns: number): string =>
  `The loop rejected your graph (attempt ${turn} of ${maxTurns}):

${reasons.map((r) => `- ${r}`).join("\n")}

Fix exactly these and answer again. You are still read-only.

${OUTPUT_RULES}`;
