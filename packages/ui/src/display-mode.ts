// How much of a session's work the conversation shows: its display mode, set per session in Session settings. "normal"
// shows what the agent said and did, without its thinking; "detailed" shows the thinking too, as it was written. Normal
// unless the person chose otherwise, because thinking is long and most of the time not what they came to read.
//
// A view setting, not the agent's: it is not sent to the daemon, and stays on this machine, in the page's storage, by
// session (its view key). It replaced "Expand thinking" in Settings → Appearance, which was one switch for every session
// and only opened or closed rows that were always there. No React and no DOM here, so it can be tested with a fake
// storage.
import type { Storage } from "./code-theme.ts";

export type DisplayMode = "normal" | "detailed";

export const DISPLAY_MODES: readonly DisplayMode[] = ["normal", "detailed"];
export const DEFAULT_DISPLAY_MODE: DisplayMode = "normal";
export const DISPLAY_MODE_KEY = "cycle-display-mode";

export const isDisplayMode = (value: unknown): value is DisplayMode =>
  DISPLAY_MODES.includes(value as DisplayMode);

/** The choice of each session, and a way to hear of a change. Only sessions not in normal mode are stored. */
export const createDisplayModeStore = (storage: Storage | undefined) => {
  const listeners = new Set<() => void>();
  let chosen: Record<string, DisplayMode> = {};
  try {
    const saved: unknown = JSON.parse(storage?.getItem(DISPLAY_MODE_KEY) ?? "{}");
    if (typeof saved === "object" && saved !== null)
      for (const [key, mode] of Object.entries(saved)) if (isDisplayMode(mode)) chosen[key] = mode;
  } catch {
    // Storage that cannot be read, or holds something else: every session is in normal mode.
  }
  return {
    get: (session: string): DisplayMode => chosen[session] ?? DEFAULT_DISPLAY_MODE,
    set: (session: string, mode: DisplayMode): void => {
      if ((chosen[session] ?? DEFAULT_DISPLAY_MODE) === mode) return;
      const { [session]: _old, ...rest } = chosen;
      chosen = mode === DEFAULT_DISPLAY_MODE ? rest : { ...rest, [session]: mode };
      try {
        storage?.setItem(DISPLAY_MODE_KEY, JSON.stringify(chosen));
      } catch {
        // Not saved, but the choice holds for this run.
      }
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** The one the page uses. */
export const displayMode = createDisplayModeStore(
  typeof localStorage === "undefined" ? undefined : localStorage,
);
