// Which blocks of a long conversation are drawn (CYC-464). Only those near the view are; the rest are a gap as tall as they
// are. A pure function of the sizes, so every rule here is tested without a page.

/** What is drawn of a list: the blocks from `start` up to, not including, `end`. */
export type Slice = { start: number; end: number };

/** How tall the blocks before `index` are, each with the gap that follows it. */
export const offsetOf = (sizes: readonly number[], gap: number, index: number): number => {
  let at = 0;
  for (let i = 0; i < index && i < sizes.length; i++) at += (sizes[i] ?? 0) + gap;
  return at;
};

/**
 * The blocks to draw for a view `height` tall scrolled `top` down: those in it, and those within `lead` above and below.
 * A `top` past the end is the end. Always at least one block when there are any.
 */
export const sliceOf = (
  sizes: readonly number[],
  gap: number,
  top: number,
  height: number,
  lead: number,
): Slice => {
  const n = sizes.length;
  if (n === 0) return { start: 0, end: 0 };
  let total = -gap;
  for (const size of sizes) total += size + gap;
  const at = Math.min(Math.max(0, top), Math.max(0, total - height));
  const from = at - lead;
  const to = at + height + lead;
  let start = n - 1;
  let end = n;
  let pos = 0;
  let found = false;
  for (let i = 0; i < n; i++) {
    const size = sizes[i] ?? 0;
    if (!found && pos + size > from) {
      start = i;
      found = true;
    }
    if (pos >= to) {
      end = Math.max(i, start + 1);
      break;
    }
    pos += size + gap;
  }
  return { start, end };
};

/** The room that stands for the blocks `from` up to `to`, so the ones drawn lie where they would with all of them. */
export const spaceOf = (
  sizes: readonly number[],
  gap: number,
  from: number,
  to: number,
): number => {
  if (to <= from) return 0;
  let space = -gap;
  for (let i = from; i < to; i++) space += (sizes[i] ?? 0) + gap;
  return Math.max(0, space);
};
