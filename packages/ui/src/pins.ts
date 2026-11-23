// The sessions the person pinned to the top of the sidebar's list. A view setting, not the agent's: it is not sent to
// the daemon, and stays on this machine, in the page's storage, by session (its `sessionKey`, environment and session).
// No React and no DOM here, so it can be tested with a fake storage.
import type { Storage } from "./code-theme.ts";

export const PINS_KEY = "cycle-pinned-sessions";

/** The pinned sessions, and a way to hear of a change. */
export const createPinStore = (storage: Storage | undefined) => {
  const listeners = new Set<() => void>();
  let pinned: ReadonlySet<string> = new Set();
  try {
    const saved: unknown = JSON.parse(storage?.getItem(PINS_KEY) ?? "[]");
    if (Array.isArray(saved)) pinned = new Set(saved.filter((key) => typeof key === "string"));
  } catch {
    // Storage that cannot be read, or holds something else: nothing is pinned.
  }
  const save = (next: ReadonlySet<string>): void => {
    pinned = next;
    try {
      storage?.setItem(PINS_KEY, JSON.stringify([...next]));
    } catch {
      // Not saved, but the pin holds for this run.
    }
    for (const listener of [...listeners]) listener();
  };
  return {
    /** The same set until something changes, so it can be read with `useSyncExternalStore`. */
    all: (): ReadonlySet<string> => pinned,
    set: (key: string, pin: boolean): void => {
      if (pinned.has(key) === pin) return;
      const next = new Set(pinned);
      if (pin) next.add(key);
      else next.delete(key);
      save(next);
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** The one the page uses. */
export const pins = createPinStore(typeof localStorage === "undefined" ? undefined : localStorage);
