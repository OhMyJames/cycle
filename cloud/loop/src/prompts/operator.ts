// The operator agent's sessions (CYC-486): woken, read-only, one session at a time. It reads the Loop's exported state
// and the repository, and answers with a diagnosis; the loop writes it as a Notice. This work item gives advice only:
// any <action> the session writes is ignored (see `parseOperatorReply`).

import type { Stats } from "../stats.ts";

export type OperatorWake =
  | { reason: "stuck"; key: string; detail: string }
  | { reason: "blocked"; keys: string[] }
  | { reason: "inspect"; sinceMinutes: number; stats: Stats };

/** The numbers of a stats block that tell an operator whether something is off, as lines of text. */
export const statsSummary = (stats: Stats): string => {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const stages = Object.entries(stats.reworkByStage)
    .filter(([, v]) => v.events > 0)
    .map(([stage, v]) => `${stage} ${v.events} (${v.runs} runs)`);
  return [
    `runs started: ${stats.runs}, delivered: ${stats.delivered}, auto-merged: ${stats.autoMerged}`,
    `rework rate: ${pct(stats.reworkRate)}, intervention rate: ${pct(stats.interventionRate)}, first-pass rate: ${pct(stats.firstPassRate)}`,
    `rework by stage: ${stages.length === 0 ? "none" : stages.join(", ")}`,
    `Dev asked a person: ${stats.devAsked.asked} times in ${stats.devAsked.runs} runs`,
    `restarts: ${stats.restarts}, stuck escalations: ${stats.stuck}, operator wakes: ${stats.operatorWakes}`,
  ].join("\n");
};

const wakeText = (wake: OperatorWake): string => {
  switch (wake.reason) {
    case "stuck":
      return `You were woken because ${wake.key} was reported stuck by the supervisor:\n${wake.detail}\nDiagnose why it is stuck.`;
    case "blocked":
      return `You were woken because ${wake.keys.length} work items are Blocked: ${wake.keys.join(", ")}.\nDiagnose why they are blocked and whether they share a cause.`;
    case "inspect":
      return `This is a scheduled inspection, ${wake.sinceMinutes} minutes after the last time you were woken. Nothing was reported. Look for what no threshold catches: a rise in rework, the same kind of failure repeating, runs that are slow or idle for no reason.\n\nStats for the last ${wake.sinceMinutes} minutes:\n${statsSummary(wake.stats)}`;
  }
};

export const OPERATOR_OUTPUT = `End your last reply with this block, and nothing after it. The loop reads only your last reply and shows what is in the block to a person.
<diagnosis>
One paragraph in Chinese: what is wrong, the evidence (a file path, a run key, an event), and what you suggest a person do. Suggest only; you cannot act.
</diagnosis>
For a scheduled inspection with nothing to report, write an empty <diagnosis></diagnosis>.
Do not write <action> blocks: this version ignores them.`;

export const operatorBrief = (
  wake: OperatorWake,
  bounds: { exportDir: string; readRoots: string[] },
): string => `You are the operator of this Loop project. You advise; you do not act.

You are READ-ONLY. Do not edit, create, delete or move files, do not commit, do not use the network, do not read credentials (.env files, keys, tokens, git config), and do not use MCP tools. You have no tracker or GitHub access. Requests outside these bounds are refused, not asked about.

The Loop's state was exported just now as JSON, in ${bounds.exportDir}: board.json, runs.json, notices.json, and events/<key>.json for each run involved. Read it first. You may also read the current directory and these directories:
${bounds.readRoots.map((root) => `- ${root}`).join("\n")}
You may run read-only commands: cat, ls, rg, grep, head, tail, wc, du, find (without -exec, -execdir, -ok, -delete or -fprint), stat, file, and git status, git diff, git log, git show.

${wakeText(wake)}

Back every claim with evidence from the export or the repository. What you could not confirm, write as 「未验证」. Never quote a secret.

${OPERATOR_OUTPUT}`;
