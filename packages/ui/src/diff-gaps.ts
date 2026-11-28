// What a drawn change leaves out between its parts. Plain TypeScript, no React and no DOM, so it is tested without a page.
import type { DiffLine } from "./model/index.ts";

/**
 * How many lines of the file are left out before each hunk of a patch's lines, by the hunk's id: between two hunks, what
 * the new file has from the end of the one to the start of the other; before the first, what is above it. A hunk with
 * nothing left out before it, or whose marker does not say, is not in it.
 */
export const skippedLines = (lines: readonly DiffLine[]): Map<string, number> => {
  const skipped = new Map<string, number>();
  // The line of the new file that would come next.
  let next = 1;
  for (const line of lines) {
    if (line.kind === "hunk") {
      const start = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line.text)?.[1];
      if (start === undefined) continue;
      if (Number(start) > next) skipped.set(line.id, Number(start) - next);
      next = Number(start);
    } else if (line.kind !== "del") next += 1;
  }
  return skipped;
};
