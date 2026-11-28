import { type RefObject, useEffect, useRef, useState } from "react";
import { CONNECTORS_SECTIONS, type ConnectorsSection } from "../connectors-sections.ts";
import type { SettingsSection } from "../settings-sections.ts";
import { type LoopProjectTab, type LoopView, up } from "./loop-nav.ts";
import { useAppState, useAppStore } from "./store-context.tsx";

/** Where Settings and Connectors go back to: the sessions, or the Loop they were opened from. */
export type Base = "sessions" | "loop";

/** Which Harness page Settings shows, on which location, and what led there (for `harness_settings_shown`). */
export type HarnessTarget = {
  agent: string;
  location: string | undefined;
  from: "settings" | "blank" | "other";
};

/**
 * What the window shows (CYC-530): one place at a time, all in the same shell (shell.tsx). The sessions are always
 * there, under whatever else is shown. Settings and Connectors are pages over the sessions or the Loop, and go back to
 * it. There is no history: each place comes back where it was left, and Back (or Escape) leaves a page.
 */
export type Place =
  | { id: "sessions" }
  | { id: "loop"; view: LoopView }
  | { id: "settings"; section: SettingsSection; harness: HarnessTarget; base: Base }
  | { id: "connectors"; section: ConnectorsSection; base: Base };

export type PlaceId = Place["id"];
export type PageId = "settings" | "connectors";

/** What leaving a page by hand gives the keyboard back to: the button that opened it. */
const OPENER: Record<PageId, string> = {
  settings: '[data-slot="menu-trigger"][data-kind="account-menu"]',
  connectors: '[data-page-open="connectors"]',
};

export const isPage = (place: Place): place is Extract<Place, { id: PageId }> =>
  place.id === "settings" || place.id === "connectors";

/** The sessions or the Loop: what is under a page, or what is shown when no page is. */
export const baseOf = (place: Place): Base =>
  isPage(place) ? place.base : place.id === "loop" ? "loop" : "sessions";

export function usePlaces(appRef: RefObject<HTMLElement | null>) {
  const store = useAppStore();
  const [place, setPlace] = useState<Place>({ id: "sessions" });
  // Where each place was left: it comes back there.
  const last = useRef<{
    settings: SettingsSection;
    harness: string;
    connectors: ConnectorsSection;
    loop: LoopView | undefined;
  }>({
    settings: "general",
    harness: "claude",
    connectors: CONNECTORS_SECTIONS[0],
    loop: undefined,
  });
  const placeRef = useRef(place);
  placeRef.current = place;
  const returnFocus = useRef<string | undefined>(undefined);

  /** The place a page goes back to. */
  const baseView = (base: Base): Place =>
    base === "loop" && last.current.loop !== undefined
      ? { id: "loop", view: last.current.loop }
      : { id: "sessions" };

  const go = (next: Place) => {
    if (next.id === "loop") last.current.loop = next.view;
    if (next.id === "settings") {
      last.current.settings = next.section;
      last.current.harness = next.harness.agent;
    }
    if (next.id === "connectors") last.current.connectors = next.section;
    // Two moves in one press (an agent's tab: the agent, then its section) each see the one before.
    placeRef.current = next;
    setPlace(next);
  };

  const openSettings = (via: "click" | "shortcut" = "click", section?: SettingsSection) => {
    go({
      id: "settings",
      section: section ?? last.current.settings,
      harness: { agent: last.current.harness, location: undefined, from: "settings" },
      base: baseOf(placeRef.current),
    });
    store.track("panel_opened", { panel: "settings", via });
  };
  // From a blank conversation whose agent cannot start: straight to that agent's Harness page, on that location; or,
  // when it only needs signing in, to the Subscriptions page, which lists every agent's account.
  const openHarnessSettings = (
    locationId: string,
    agentId: string,
    section: "harness" | "subscriptions" = "harness",
  ) => {
    go({
      id: "settings",
      section,
      harness: { agent: agentId, location: locationId, from: "blank" },
      base: baseOf(placeRef.current),
    });
    store.track("panel_opened", { panel: "settings", via: "click" });
  };
  const showSection = (section: SettingsSection) => {
    const now = placeRef.current;
    if (now.id !== "settings" || section === now.section) return;
    go({ ...now, section });
    store.track("settings_section_shown", { section });
  };
  const showHarnessAgent = (agent: string) => {
    const now = placeRef.current;
    if (now.id !== "settings") return;
    go({ ...now, harness: { ...now.harness, agent, from: "settings" } });
  };

  const openConnectors = () => {
    go({ id: "connectors", section: last.current.connectors, base: baseOf(placeRef.current) });
    store.track("panel_opened", { panel: "connectors", via: "click" });
  };
  const showConnectorsSection = (section: ConnectorsSection) => {
    const now = placeRef.current;
    if (now.id !== "connectors" || section === now.section) return;
    go({ ...now, section });
    store.track("connectors_section_shown", { section });
  };

  const openLoop = () => {
    const now = placeRef.current;
    if (now.id === "loop" && now.view.at === "overview") return;
    go({ id: "loop", view: { at: "overview" } });
    store.track("panel_opened", { panel: "loop", via: "click" });
  };
  const openLoopProject = (
    projectKey: string,
    tab: LoopProjectTab,
    from: "sidebar" | "overview" | "timeline" | "notification" = "sidebar",
  ) => {
    const now = placeRef.current;
    if (
      now.id === "loop" &&
      now.view.at === "project" &&
      now.view.projectKey === projectKey &&
      now.view.tab === tab
    )
      return;
    go({ id: "loop", view: { at: "project", projectKey, tab } });
    store.track("loop_project_view_opened", { view: tab, from });
  };
  // Moving inside the Loop: where it is now is where it comes back to. Under a page opened from it the Loop can still
  // move by itself: that is remembered for the way back, and the page stays.
  const showLoopView = (view: LoopView) => {
    const now = placeRef.current;
    if (isPage(now)) last.current.loop = view;
    else go({ id: "loop", view });
  };
  // Escape closes a ticket's drawer, back to its board. It goes no higher and does not leave the Loop: the sidebar does.
  const loopBack = () => {
    const now = placeRef.current;
    const parent = now.id === "loop" ? up(now.view) : undefined;
    if (parent !== undefined) showLoopView(parent);
  };
  const leaveLoop = () => go({ id: "sessions" });

  /** Left by the person (Escape, Back, the shortcut): back to what is under it, the keyboard to the page's button. */
  const leavePage = () => {
    const now = placeRef.current;
    if (!isPage(now)) return;
    returnFocus.current = OPENER[now.id];
    go(baseView(now.base));
  };
  /** Left for something else (a new session, a found one, a notification's): the sessions, and the keyboard is that thing's. */
  const closePage = () => go({ id: "sessions" });

  // A notification was pressed: its session is what the person asked for, also when it is the one already open.
  const focusRequests = useAppState((s) => s.focusRequests);
  const [shownRequests, setShownRequests] = useState(focusRequests);
  if (shownRequests !== focusRequests) {
    setShownRequests(focusRequests);
    if (place.id !== "sessions") closePage();
  }
  // A Loop notification was pressed: that Project's page, over whatever is open (the ticket is opened by the page).
  const loopRequest = useAppState((s) => s.loop.request);
  const [shownLoop, setShownLoop] = useState(loopRequest?.n);
  if (shownLoop !== loopRequest?.n) {
    setShownLoop(loopRequest?.n);
    if (loopRequest !== undefined)
      go({
        id: "loop",
        view: { at: "project", projectKey: loopRequest.projectKey, tab: "kanban" },
      });
  }
  const trackedLoopRequest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (loopRequest === undefined || trackedLoopRequest.current === loopRequest.n) return;
    trackedLoopRequest.current = loopRequest.n;
    store.track("loop_project_view_opened", { view: "kanban", from: "notification" });
  }, [loopRequest, store]);
  const pageOpen = isPage(place);
  useEffect(() => {
    const opener = returnFocus.current;
    if (pageOpen || opener === undefined) return;
    returnFocus.current = undefined;
    const root = appRef.current;
    const button = root?.querySelector<HTMLElement>(opener);
    // The button is in the sidebar: folded, it is out of reach, and the keyboard goes to the button that unfolds it.
    const target =
      button != null && button.closest("[inert]") === null
        ? button
        : root?.querySelector<HTMLElement>(
            '[data-slot="main-header"] [data-kind="sidebar-toggle"]',
          );
    target?.focus();
  }, [pageOpen, appRef]);

  // The Loop stays as it was under a page opened from it: its board, scroll and drawer are there on the way back.
  const loopView =
    place.id === "loop"
      ? place.view
      : isPage(place) && place.base === "loop"
        ? last.current.loop
        : undefined;

  return {
    place,
    base: baseOf(place),
    loopView,
    pageOpen,
    openSettings,
    openHarnessSettings,
    showSection,
    showHarnessAgent,
    openConnectors,
    showConnectorsSection,
    openLoop,
    openLoopProject,
    showLoopView,
    loopBack,
    leaveLoop,
    leavePage,
    closePage,
  };
}
