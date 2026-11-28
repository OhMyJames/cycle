// The right panel of each session (CYCL-90): whether it is open, the tabs it has and the one shown. Kept by location
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

/**
 * A session whose panel was never opened: closed, with its views in the strip for when it is, the Overview first. A tab
 * is one press away, since the session's header has only the panel's own button.
 */
export const CLOSED: SidePanelState = {
  open: false,
  tabs: ["overview", "files", "diff"],
  active: "overview",
};

/** How many sessions' panels are remembered: the ones used last. */
export const REMEMBERED = 200;

const KEY = "cycle:side-panel";

/** One of the kinds the panel keeps (not a terminal). */
export const isTab = (value: unknown): value is PanelTabKind =>
  typeof value === "string" && (PANEL_TABS as readonly string[]).includes(value);

const isTerminalTab = (value: unknown): value is `terminal:${string}` =>
  typeof value === "string" && /^terminal:.{1,200}$/.test(value);

/** What storage held, as a state: anything not understood (an old tab kind, a hand-edited value) is left out. */
const parse = (value: unknown): SidePanelState | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { open?: unknown; tabs?: unknown; active?: unknown };
  if (!Array.isArray(v.tabs)) return undefined;
  // None is a state too: every view closed, the session's terminals the only tabs.
  const tabs = [...new Set(v.tabs.filter(isTab))];
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

  /** The panel of a session (`locationId:sessionId`). The same object until it changes, so that it can be watched. */
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

  /**
   * Closes a view's tab. `next` is the tab shown in its place when it was the one shown: the strip's, which has the
   * session's terminals too, so the caller says it. A tab that is put back (`show`) goes to the strip's end.
   */
  close(key: string, tab: PanelTabKind, next?: PanelTabId): void {
    const old = this.get(key);
    if (!old.tabs.includes(tab)) return;
    const tabs = old.tabs.filter((x) => x !== tab);
    const active = old.active === tab ? (next ?? tabs[0] ?? old.active) : old.active;
    this.#put(key, { open: old.open, tabs, active });
  }

  /**
   * A panel left with no view (each closed while a terminal was its tab) whose terminals have gone too starts again
   * from its views: the strip draws them, and before one of them is shown or closed they are the panel's again.
   */
  restore(key: string): void {
    const old = this.get(key);
    if (old.tabs.length > 0) return;
    this.#put(key, { ...old, tabs: CLOSED.tabs });
  }

  /** A session that is gone (deleted): its panel is forgotten too. */
  forget(key: string): void {
    const states = this.#all();
    if (!states.delete(key)) return;
    this.#save();
    this.#changed();
  }

  /** Every panel of a location that was removed. Its id has no colon, so the prefix names its sessions only. */
  forgetLocation(locationId: string): void {
    const states = this.#all();
    const prefix = `${locationId}:`;
    let gone = false;
    for (const key of [...states.keys()]) {
      if (key.startsWith(prefix)) gone = states.delete(key) || gone;
    }
    if (!gone) return;
    this.#save();
    this.#changed();
  }
}
