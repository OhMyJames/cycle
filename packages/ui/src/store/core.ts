// What every part of the store shares: the state and who is told of a change, main, and the boxes and panels.
import type { EventProps, UiEventName } from "@cycle/analytics/events";
import type { CycleBridge } from "../api.ts";
import { DraftStore } from "../draft.ts";
import { FilesViews } from "../files-view.ts";
import { SidePanelStore } from "../side-panel.ts";
import { type AppState, initialState } from "./state.ts";

export type StateChange = Partial<AppState> | ((state: AppState) => Partial<AppState>);

/** What a part of the store is handed: it reads and changes the one state, and asks main. */
export type StoreKit = {
  readonly bridge: CycleBridge;
  /** The state now. */
  readonly state: () => AppState;
  readonly set: (change: StateChange) => void;
  /** Runs an action, and shows what went wrong instead of throwing it into the page. */
  readonly attempt: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  readonly track: <N extends UiEventName>(name: N, props: EventProps<N>) => void;
  /** What each session's box holds, written and not sent. */
  readonly drafts: DraftStore;
  /** What each session's right panel shows (CYCL-90). */
  readonly sidePanels: SidePanelStore;
  /** Where each session's Files tab is: open folders, and the file shown (CYCL-92). */
  readonly filesViews: FilesViews;
};

export const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  // Electron wraps what main throws: "Error invoking remote method 'x': Error: the real message".
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
};

/**
 * What main threw (it lost its connection, it is too old) as an answer the page shows like the daemon's own refusals:
 * a "failed" problem with the system's words.
 */
export const answered = <T>(
  answer: Promise<T>,
): Promise<T | { problem: "failed"; message: string }> =>
  answer.catch((error: unknown) => ({ problem: "failed" as const, message: messageOf(error) }));

/**
 * The state, who is told of a change, and the kit its parts share. `AppStore` builds on it, so that its parts can be
 * made as its fields, with the kit already there.
 */
export class StoreBase {
  #state: AppState = initialState();
  readonly #listeners = new Set<() => void>();
  protected readonly bridge: CycleBridge;
  protected readonly kit: StoreKit;
  /** What each session's box holds, written and not sent. */
  readonly drafts: DraftStore;
  /** What each session's right panel shows (CYCL-90). */
  readonly sidePanels: SidePanelStore;
  /** Where each session's Files tab is: open folders, and the file shown (CYCL-92). */
  readonly filesViews = new FilesViews();

  constructor(
    bridge: CycleBridge,
    drafts: DraftStore = new DraftStore(),
    sidePanels: SidePanelStore = new SidePanelStore(),
  ) {
    this.bridge = bridge;
    this.drafts = drafts;
    this.sidePanels = sidePanels;
    this.kit = {
      bridge,
      state: () => this.#state,
      set: (change) => this.set(change),
      attempt: (action) => this.attempt(action),
      track: (name, props) => this.track(name, props),
      drafts,
      sidePanels,
      filesViews: this.filesViews,
    };
  }

  getState = (): AppState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  protected set(change: StateChange): void {
    const next = typeof change === "function" ? change(this.#state) : change;
    this.#state = { ...this.#state, ...next };
    for (const listener of [...this.#listeners]) listener();
  }

  protected async attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      this.set({ error: messageOf(error) });
      return undefined;
    }
  }

  /** Reports what only the page can see (a panel opened, a theme chosen). Never waits and never fails. */
  track = <N extends UiEventName>(name: N, props: EventProps<N>): void => {
    void this.bridge.track(name, props).catch(() => undefined);
  };
}
