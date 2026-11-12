import { scanSource, type Comment } from "./scan.ts";

/**
 * A deferral in code is one comment, `shortcut: <the limit>; upgrade when <the trigger>`, so that
 * `git grep -n "shortcut:"` lists them all and none is left without the moment to revisit it.
 */
export const DEFERRAL_FORM = "shortcut: <the limit>; upgrade when <the trigger>";

const LOOSE_MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;
const SHORTCUT = /^[\s*]*shortcut:/m;
const WITH_TRIGGER = /^[\s*]*shortcut:\s*\S[\s\S]*?\bupgrade (?:when|once|if)\s+\S/m;

/** Consecutive line comments read as one, so a deferral may wrap. */
function commentBlocks(code: string, comments: readonly Comment[]): Comment[] {
  const blocks: Comment[] = [];
  for (const comment of comments) {
    const last = blocks.at(-1);
    const adjacent =
      last?.type === "Line" &&
      comment.type === "Line" &&
      /^\s*$/.test(code.slice(last.end, comment.start));
    if (last && adjacent) {
      blocks[blocks.length - 1] = {
        ...last,
        value: `${last.value}\n${comment.value}`,
        end: comment.end,
      };
    } else {
      blocks.push(comment);
    }
  }
  return blocks;
}

const lineOf = (code: string, offset: number): number => code.slice(0, offset).split("\n").length;

/** Each message names the line of a comment that defers work in another form, or without a trigger. */
export function checkDeferrals(code: string): string[] {
  const messages: string[] = [];
  for (const block of commentBlocks(code, scanSource(code).comments)) {
    const line = lineOf(code, block.start);
    const loose = LOOSE_MARKER.exec(block.value);
    if (loose) {
      messages.push(`line ${line}: write ${loose[1]} as \`${DEFERRAL_FORM}\``);
    } else if (SHORTCUT.test(block.value) && !WITH_TRIGGER.test(block.value)) {
      messages.push(`line ${line}: a shortcut names when to upgrade: \`${DEFERRAL_FORM}\``);
    }
  }
  return messages;
}
