// One clock for every relative time on the page (a session row's, a message's), running only while one is shown. A tick
// redraws the times that read it, not the rows or the lists around them.
import { useSyncExternalStore } from "react";

/** How often the times move on. The finest they say is a minute; half of one keeps them from lagging by most of it. */
const TICK_MS = 30_000;

/** A clock that ticks every `tickMs` while anything reads it, and not at all when nothing does. */
const clock = (tickMs: number) => {
  const listeners = new Set<() => void>();
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    now = Date.now();
    timer ??= setInterval(() => {
      now = Date.now();
      for (const each of [...listeners]) each();
    }, tickMs);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  };
  return { subscribe, read: (): number => now };
};

const minutes = clock(TICK_MS);

/** Now, in epoch milliseconds, as of the clock's last tick. */
export const useNow = (): number =>
  useSyncExternalStore(minutes.subscribe, minutes.read, minutes.read);

/** Half a second: a count in seconds that moves on time. */
const seconds = clock(500);

/** Now, as of the half-second clock: one timer for every running count on the page (the step line's, each call's). */
export const useNowSeconds = (): number =>
  useSyncExternalStore(seconds.subscribe, seconds.read, seconds.read);
