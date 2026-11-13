import type { ReviewTarget } from "@cycle/protocol";

/** `/review` and what follows it in the composer, or null when the text is something else. */
export function reviewArgument(text: string): string | null {
  const found = /^\/review(?:\s+([\s\S]*))?$/.exec(text.trim());
  return found ? (found[1] ?? "").trim() : null;
}

/**
 * What `/review <argument>` reviews: nothing after it, the uncommitted changes; one word that is a
 * branch, everything since that branch; one word of a hash, that commit; anything else, what it says.
 */
export function reviewTarget(argument: string, branches: readonly string[]): ReviewTarget {
  if (!argument) return { kind: "uncommitted" };
  if (!/\s/.test(argument)) {
    if (branches.includes(argument)) return { kind: "branch", branch: argument };
    if (/^[0-9a-f]{7,40}$/i.test(argument)) return { kind: "commit", sha: argument };
  }
  return { kind: "custom", instructions: argument };
}
