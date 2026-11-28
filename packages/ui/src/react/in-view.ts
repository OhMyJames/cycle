import { type RefObject, useEffect, useSyncExternalStore } from "react";

/**
 * Which cards of work still running are on screen now, by the id of the call that started each. The line that says what
 * runs in the background (turn.tsx) asks it: a card the person is looking at already says what it is and that it runs,
 * so the line does not name it again. A card scrolled away, folded out of the page, or under another place is not in it.
 */
const seen = new Set<string>();
const listeners = new Set<() => void>();

const set = (id: string, on: boolean) => {
  if (seen.has(id) === on) return;
  if (on) seen.add(id);
  else seen.delete(id);
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Says whether the card at `ref` is on screen, while `wanted`. */
export function useReportInView(id: string, ref: RefObject<Element | null>, wanted: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!wanted || el === null) return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last !== undefined) set(id, last.isIntersecting);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      set(id, false);
    };
  }, [id, ref, wanted]);
}

/** Whether every one of `ids` has its card on screen. Not so of none. */
export function useAllInView(ids: readonly (string | undefined)[]): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ids.length > 0 && ids.every((id) => id !== undefined && seen.has(id)),
    () => false,
  );
}
