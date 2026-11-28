import { type RefObject, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Which cards of work still running are on screen now, by the id of the call that started each. The line that says what
 * runs in the background (turn.tsx) asks it: a card the person is looking at already says what it is and that it runs,
 * so the line does not name it again. A card scrolled away, folded out of the page, or under another place is not in it.
 *
 * A session can be drawn twice at once (under a page, and in the Loop timeline's panel), so each card that reports is
 * counted by itself: one of them going out of sight does not speak for the other.
 */
const seen = new Map<string, Set<symbol>>();
const listeners = new Set<() => void>();

const set = (id: string, who: symbol, on: boolean) => {
  const by = seen.get(id);
  if ((by?.has(who) ?? false) === on) return;
  if (on) seen.set(id, (by ?? new Set()).add(who));
  else {
    by?.delete(who);
    if (by?.size === 0) seen.delete(id);
  }
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Says whether the card at `ref` is on screen, while `wanted`. What is watched is its head (its first button: the line
 * that names it), and most of that line must show: a card's last pixel under the edge of the view names nothing.
 */
export function useReportInView(id: string, ref: RefObject<Element | null>, wanted: boolean): void {
  // Before the first paint, so the line that asks is drawn right from its first frame: the observer answers a frame late.
  useLayoutEffect(() => {
    const card = ref.current;
    if (!wanted || card === null) return;
    const head = card.querySelector(":scope > button") ?? card;
    const who = Symbol(id);
    const box = head.getBoundingClientRect();
    set(
      id,
      who,
      box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight,
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last !== undefined) set(id, who, last.isIntersecting);
      },
      { threshold: 0.6 },
    );
    observer.observe(head);
    return () => {
      observer.disconnect();
      set(id, who, false);
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
