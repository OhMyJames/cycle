// The right panel of each session (CYCL-90): whether it is open, the tabs it has and the one shown. Kept by environment
// and session, as drafts are, so that each session's panel is set out for that session and a restart finds it again
// (.agents/notes/2026-11-21-right-panel-layout.md). Its width is the window's, not the session's: SplitLayout keeps it.
// Plain TypeScript, no React and no DOM, so the rules are tested without a page.
import { browserStorage, type DraftStorage } from "./draft.ts";

/**
 * The kinds of tab the panel keeps. Overview, Files and Diff are views of the session, one of each at most, and the id
 * of each is its kind. A fixed word: the analytics name it.
 */
export const PANEL_TABS = ["overview", "files", "diff"] as const;
export type PanelTabKind = (typeof PANEL_TABS)[number];

/**
 * A tab of the panel: one of the kinds above, or a terminal (CYCL-98), `terminal:` and its id. Terminal tabs are not
 * kept here: they are the session's terminals, as the daemon lists them. Only which one was shown is.
 */
export type PanelTabId = PanelTabKind | `terminal:${string}`;

export type SidePanelState = {
  readonly open: boolean;
  readonly tabs: readonly PanelTabKind[];
  readonly active: PanelTabId;
};

/** A session whose panel was never opened: closed, with the Overview ready for when it is. */
export const CLOSED: SidePanelState = { open: false, tabs: ["overview"], active: "overview" };

/** How many sessions' panels are remembered: the ones used last. */
export const REMEMBERED = 200;

const KEY = "cycle:side-panel";

const isTab = (value: unknown): value is PanelTabKind =>
  typeof value === "string" && (PANEL_TABS as readonly string[]).includes(value);

const isTerminalTab = (value: unknown): value is `terminal:${string}` =>
  typeof value === "string" && /^terminal:.{1,200}$/.test(value);

/** What storage held, as a state: anything not understood (an old tab kind, a hand-edited value) is left out. */
const parse = (value: unknown): SidePanelState | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { open?: unknown; tabs?: unknown; active?: unknown };
  const tabs = Array.isArray(v.tabs) ? [...new Set(v.tabs.filter(isTab))] : [];
  if (tabs.length === 0) return undefined;
  const active =
    (isTab(v.active) && tabs.includes(v.active)) || isTerminalTab(v.active)
      ? v.active
      : (tabs[0] ?? "overview");
  return { open: v.open === true, tabs, active };
};

export class SidePanelStore {
  readonly #storage: DraftStorage | undefined;
  /** Oldest first: a Map keeps the order things were put in, and a change puts its session last. */
  #states: Map<string, SidePanelState> | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(storage: DraftStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #all(): Map<string, SidePanelState> {
    if (this.#states !== undefined) return this.#states;
    const states = new Map<string, SidePanelState>();
    try {
      const raw = this.#storage?.getItem(KEY);
      const saved: unknown = raw == null ? [] : JSON.parse(raw);
      if (Array.isArray(saved)) {
        for (const entry of saved) {
          if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
          const state = parse(entry[1]);
          if (state !== undefined) states.set(entry[0], state);
        }
      }
    } catch {
      // Unreadable: every panel starts closed, and the next change writes over it.
    }
    this.#states = states;
    return states;
  }

  #save(): void {
    try {
      const states = this.#all();
      if (states.size === 0) this.#storage?.removeItem(KEY);
      else this.#storage?.setItem(KEY, JSON.stringify([...states]));
    } catch {
      // Full, or not allowed: the panels are remembered until the window closes.
    }
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** The panel of a session (`environmentId:sessionId`). The same object until it changes, so that it can be watched. */
  get(key: string): SidePanelState {
    return this.#all().get(key) ?? CLOSED;
  }

  #put(key: string, state: SidePanelState): void {
    const states = this.#all();
    states.delete(key);
    states.set(key, state);
    for (const old of states.keys()) {
      if (states.size <= REMEMBERED) break;
      states.delete(old);
    }
    this.#save();
    this.#changed();
  }

  /** Opens or closes a session's panel; opening it shows what it showed last. */
  setOpen(key: string, open: boolean): void {
    const old = this.get(key);
    if (old.open === open) return;
    this.#put(key, { ...old, open });
  }

  /**
   * Shows a tab of a session's panel, adding it if the panel does not have it, and opens the panel. A terminal's tab is
   * the terminal's: only that it is the one shown is kept.
   */
  show(key: string, tab: PanelTabId): void {
    const old = this.get(key);
    if (old.open && old.active === tab) return;
    const tabs = !isTab(tab) || old.tabs.includes(tab) ? old.tabs : [...old.tabs, tab];
    this.#put(key, { open: true, tabs, active: tab });
  }

  /** A session that is gone (deleted): its panel is forgotten too. */
  forget(key: string): void {
    const states = this.#all();
    if (!states.delete(key)) return;
    this.#save();
    this.#changed();
  }

  /** Every panel of an environment that was removed. Its id has no colon, so the prefix names its sessions only. */
  forgetEnvironment(environmentId: string): void {
    const states = this.#all();
    const prefix = `${environmentId}:`;
    let gone = false;
    for (const key of [...states.keys()]) {
      if (key.startsWith(prefix)) gone = states.delete(key) || gone;
    }
    if (!gone) return;
    this.#save();
    this.#changed();
  }
}
