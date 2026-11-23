// Ported whole from Cycle v2 (packages/ui/src/loader/hold.ts), by the owner's decision for CYCL-215; see index.ts.
import type { LoaderState } from "./scenes.ts";

/** How long a working state stays before the next one replaces it, in milliseconds. */
export const HOLD_MS = 600;

/** The state on screen, and when it came. */
export interface Shown {
  state: LoaderState;
  since: number;
}

/** Waiting for the user and being done are what the user is looking for: they come at once, and go at once. */
const quiet = (state: LoaderState): boolean => state === "waiting" || state === "done";

/**
 * What to show at `now` when the agent is doing `target`, given what is shown. A model that makes several calls in a row
 * changes what it is doing again and again; the loader would not settle into any one move, so a working state (thinking,
 * searching, executing, responding) stays for `hold` before another replaces it. Then it goes straight to what the agent
 * is doing by then, skipping what came and went in between. `recheckIn` is when to ask again, if the answer is "not yet".
 */
export function settle(
  shown: Shown,
  target: LoaderState,
  now: number,
  hold: number = HOLD_MS,
): { shown: Shown; recheckIn: number | undefined } {
  if (target === shown.state) return { shown, recheckIn: undefined };
  const left = shown.since + hold - now;
  if (quiet(target) || quiet(shown.state) || left <= 0)
    return { shown: { state: target, since: now }, recheckIn: undefined };
  return { shown, recheckIn: left };
}

/** What the hold needs of the window: the time, and a timer. */
export interface HoldClock {
  now(): number;
  /** Calls `callback` in about `ms` (a timer may come a little early); returns how to cancel it. */
  after(ms: number, callback: () => void): () => void;
}

export interface Hold {
  /** What the agent is doing now. */
  want(target: LoaderState): void;
  stop(): void;
}

/**
 * Settles what is shown, over time: whenever the target changes, or a timer set for the end of a state's time goes off,
 * it looks again (settle) and tells `onShow` what is shown. A timer that goes off a hair early finds the time not quite
 * up, and sets another, so the state wanted is always reached.
 */
export function holdState(
  clock: HoldClock,
  initial: LoaderState,
  onShow: (state: LoaderState) => void,
): Hold {
  let shown: Shown = { state: initial, since: clock.now() };
  let target = initial;
  let cancel: (() => void) | undefined;
  const look = (): void => {
    cancel?.();
    cancel = undefined;
    const next = settle(shown, target, clock.now());
    if (next.shown !== shown) {
      shown = next.shown;
      onShow(shown.state);
    }
    if (next.recheckIn !== undefined) cancel = clock.after(next.recheckIn, look);
  };
  return {
    want(next) {
      target = next;
      look();
    },
    stop() {
      cancel?.();
      cancel = undefined;
    },
  };
}
