/**
 * Shrink a failing command's output for the Dev session and the criteria evidence.
 * `bun test` prints assertion errors and stacks next to the failing file, then keeps
 * printing passing files, so a plain tail loses the real error. Short output is returned
 * as is; long output keeps the failure blocks plus the tail (the summary).
 */
const MARKER = /error:|AssertionError|Expected:|Received:|\(fail\)|✗|^\s+at |^\s*\^$/;
const BEFORE = 8;
const AFTER = 3;
const TAIL = 800;

export const summarizeFailure = (output: string, max = 3000): string => {
  if (output.length <= max) return output;
  const tailBudget = Math.min(TAIL, Math.floor(max / 3));
  const tailStart = output.length - tailBudget;
  const lines = output.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (!MARKER.test(line)) return;
    for (let j = Math.max(0, i - BEFORE); j <= Math.min(lines.length - 1, i + AFTER); j++)
      keep[j] = true;
  });
  const blocks: string[] = [];
  let current: string[] = [];
  lines.forEach((line, i) => {
    if ((offsets[i] ?? 0) >= tailStart) return;
    if (keep[i]) current.push(line);
    else if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  });
  if (current.length > 0) blocks.push(current.join("\n"));
  const headBudget = max - tailBudget - 8;
  let head = "";
  for (const block of blocks) {
    const next = head === "" ? block : `${head}\n…\n${block}`;
    if (next.length > headBudget) {
      if (head === "") head = block.slice(0, headBudget);
      break;
    }
    head = next;
  }
  if (head === "") return `…${output.slice(output.length - max)}`;
  return `${head}\n…\n${output.slice(tailStart).trimStart()}`;
};
