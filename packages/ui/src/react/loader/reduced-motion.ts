// After Cycle v2's use-reduced-motion.ts (the two functions the loader takes), asked of the page when it is needed rather
// than once at import, so a module that is only imported (a test, the model's own bundle) needs no window.

const QUERY = "(prefers-reduced-motion: reduce)";

const query = (): MediaQueryList | undefined =>
  typeof matchMedia === "function" ? matchMedia(QUERY) : undefined;

/** Whether the person asked for less motion. */
export const prefersReducedMotion = (): boolean => query()?.matches ?? false;

/** Calls `notify` when that setting changes; returns how to stop. */
export const subscribeReducedMotion = (notify: () => void): (() => void) => {
  const list = query();
  list?.addEventListener("change", notify);
  return () => list?.removeEventListener("change", notify);
};
