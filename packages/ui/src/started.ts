// When the page first saw a step or a call at work. The agent gives no start time, so it is the page's own; kept by key
// rather than in a component, so a line drawn again (a card opened, an approval answered, the step line that moves back
// to a call) goes on counting from where it was. A page opened mid-run counts from then. The rule is old-cycle's
// (`content/tool-start.ts`).

const started = new Map<string, number>();

/** How many are kept: far more than a turn has going at once; the oldest go first. */
const KEPT = 200;

/** When `key` was first asked about, in epoch milliseconds. */
export const startedAt = (key: string, now: number = Date.now()): number => {
  const known = started.get(key);
  if (known !== undefined) return known;
  started.set(key, now);
  if (started.size > KEPT) {
    const oldest = started.keys().next().value;
    if (oldest !== undefined) started.delete(oldest);
  }
  return now;
};
