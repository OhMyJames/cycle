// Pieces more than one role's prompts use.

import type { Criterion } from "../criteria.ts";

export const criteriaTable = (criteria: Criterion[], withEvidence: boolean): string =>
  criteria
    .map((c) => {
      const commands = c.verify.map((argv) => `\`${argv.join(" ")}\``).join(", ");
      const result = withEvidence ? ` — ${c.status}` : "";
      return `${c.id}. ${c.text}\n   checked by: ${commands}${result}`;
    })
    .join("\n");

export const PROGRESS_RULE = `End every turn with a block, and nothing after it:
<progress>
done: what you did this turn
next: what is left, or "nothing" if every criterion should now pass
</progress>`;

const MAX_DOC = 100_000;

/** `text` in a fence longer than any run of backticks inside it, so nothing in it can close the fence early. */
export const fenced = (lang: string, text: string): string => {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
};

/** A document in an adaptive fence, cut (and said so) past `MAX_DOC`. */
export const docBlock = (name: string, text: string): string => {
  const body = text.trim();
  const cut = body.length > MAX_DOC;
  const shown = cut
    ? `${body.slice(0, MAX_DOC)}\n[cut: the document goes on; read it in full if you need the rest]`
    : body;
  return `${name} (full text):\n${fenced("markdown", shown)}`;
};

export const MAX_DIFF = 120_000;

/** The diff for a prompt: cut past `MAX_DIFF`, in an adaptive fence like a document's. */
export const diffBlock = (diff: string): string => fenced("diff", diff.slice(0, MAX_DIFF));

export const numbered = (items: string[]): string =>
  items.map((q, i) => `${i + 1}. ${q}`).join("\n");

export const readOnlyBounds = (
  readRoots: string[],
): string => `You are READ-ONLY. Do not edit, create, delete or move files, do not commit, do not use the network, do not read credentials (.env files, keys, tokens, git config), and do not use MCP tools. Requests outside these bounds are refused, not asked about.

You may read the current directory (a git worktree of the base branch, made for this round) and these directories:
${readRoots.map((root) => `- ${root}`).join("\n")}
You may run read-only commands: cat, ls, rg, grep, head, tail, wc, du, find (without -exec, -execdir, -ok, -delete or -fprint), stat, file, and git status, git diff, git log, git show.`;
