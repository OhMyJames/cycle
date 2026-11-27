import { type RefObject, useEffect, useRef, useState } from "react";
import { CONNECTORS_SECTIONS, type ConnectorsSection } from "../connectors-sections.ts";
import type { SettingsSection } from "../settings-sections.ts";
import { enter, type LoopView, up } from "./loop-nav.ts";
import { useAppState, useAppStore } from "./store-context.tsx";

/**
 * The pages that take the whole window over the sessions: Settings (CYCL-78) and Connectors (CYCL-82), one at a time.
 * The sessions stay as they are under them. Each page comes back on the section it was left on.
 */
export function usePages(appRef: RefObject<HTMLElement | null>) {
  const store = useAppStore();
  const [settings, setSettings] = useState<SettingsSection | undefined>(undefined);
  const lastSection = useRef<SettingsSection>("general");
  // Which Harness page is shown, on which location, and what led there (for `harness_settings_shown`).
  const [harnessAgent, setHarnessAgent] = useState<string>("claude");
  const [harnessLocation, setHarnessLocation] = useState<string | undefined>(undefined);
  const [harnessFrom, setHarnessFrom] = useState<"settings" | "blank" | "other">("settings");
  const [connectors, setConnectors] = useState<ConnectorsSection | undefined>(undefined);
  const lastConnectorsSection = useRef<ConnectorsSection>(CONNECTORS_SECTIONS[0]);
  // The Loop page: open or not, and which Project it was left on (the Projects are its sections).
  const [loop, setLoop] = useState<LoopView | undefined>(undefined);
  const lastLoopView = useRef<LoopView | undefined>(undefined);
  // The Loop is a mode of the sidebar and the main area, not a page over the window: it is not in `pageOpen`.
  const pageOpen = settings !== undefined || connectors !== undefined;

  // Settings, from wherever it is asked for: over the sessions, or in place of the Connectors page.
  const openSettings = (via: "click" | "shortcut" = "click", section?: SettingsSection) => {
    if (section !== undefined) lastSection.current = section;
    setHarnessFrom("settings");
    setHarnessLocation(undefined);
    setConnectors(undefined);
    setSettings(lastSection.current);
    store.track("panel_opened", { panel: "settings", via });
  };
  // From a blank conversation whose agent cannot start: straight to that agent's Harness page, on that location; or,
  // when it only needs signing in, to the Subscriptions page, which lists every agent's account.
  const openHarnessSettings = (
    locationId: string,
    agentId: string,
    section: "harness" | "subscriptions" = "harness",
  ) => {
    lastSection.current = section;
    setHarnessAgent(agentId);
    setHarnessLocation(locationId);
    setHarnessFrom("blank");
    setConnectors(undefined);
    setSettings(section);
    store.track("panel_opened", { panel: "settings", via: "click" });
  };
  const showHarnessAgent = (agentId: string) => {
    setHarnessAgent(agentId);
    setHarnessFrom("settings");
  };
  const openConnectors = () => {
    setConnectors(lastConnectorsSection.current);
    store.track("panel_opened", { panel: "connectors", via: "click" });
  };
  const openLoop = () => {
    if (loop !== undefined) return;
    setSettings(undefined);
    setConnectors(undefined);
    setLoop(enter(lastLoopView.current));
    store.track("panel_opened", { panel: "loop", via: "click" });
  };
  // Moving inside the Loop: where it is now is where it comes back to.
  const showLoopView = (view: LoopView) => {
    lastLoopView.current = view;
    setLoop(view);
  };
  // Escape closes a ticket's drawer, back to its board. It goes no higher and does not leave the Loop: the sidebar's
  // Overview and Sessions do.
  const loopBack = () => {
    const parent = loop === undefined ? undefined : up(loop);
    if (parent !== undefined) showLoopView(parent);
  };
  const leaveLoop = () => {
    setLoop(undefined);
  };
  // Whichever page is over the sessions, and the Loop mode, is left: the sessions are what is asked for.
  const closePage = () => {
    setSettings(undefined);
    setConnectors(undefined);
    setLoop(undefined);
  };
  // Left by the person (Escape, Back, the shortcut): the keyboard goes back to the button that opened the page. Left
  // for something else (a new session, a found one, a notification's), the keyboard is that thing's.
  const returnFocus = useRef<string | undefined>(undefined);
  const leaveSettings = () => {
    returnFocus.current = '[data-slot="menu-trigger"][data-kind="account-menu"]';
    setSettings(undefined);
  };
  const leaveConnectors = () => {
    returnFocus.current = '[data-page-open="connectors"]';
    setConnectors(undefined);
  };
  const showSection = (section: SettingsSection) => {
    if (section === settings) return;
    lastSection.current = section;
    setSettings(section);
    store.track("settings_section_shown", { section });
  };
  const showConnectorsSection = (section: ConnectorsSection) => {
    if (section === connectors) return;
    lastConnectorsSection.current = section;
    setConnectors(section);
    store.track("connectors_section_shown", { section });
  };

  // A notification was pressed: its session is what the person asked for, also when it is the one already open.
  const focusRequests = useAppState((s) => s.focusRequests);
  const [shownRequests, setShownRequests] = useState(focusRequests);
  if (shownRequests !== focusRequests) {
    setShownRequests(focusRequests);
    if (pageOpen || loop !== undefined) closePage();
  }
  // A Loop notification was pressed: that Project's page, over whatever is open (the ticket is opened by the page).
  const loopRequest = useAppState((s) => s.loop.request);
  const [shownLoop, setShownLoop] = useState(loopRequest?.n);
  if (shownLoop !== loopRequest?.n) {
    setShownLoop(loopRequest?.n);
    if (loopRequest !== undefined) {
      setSettings(undefined);
      setConnectors(undefined);
      showLoopView({ at: "project", projectKey: loopRequest.projectKey, tab: "kanban" });
    }
  }
  useEffect(() => {
    const opener = returnFocus.current;
    if (pageOpen || opener === undefined) return;
    returnFocus.current = undefined;
    appRef.current?.querySelector<HTMLElement>(opener)?.focus();
  }, [pageOpen, appRef]);

  return {
    settings,
    connectors,
    loop,
    openLoop,
    showLoopView,
    loopBack,
    leaveLoop,
    pageOpen,
    openSettings,
    openHarnessSettings,
    harnessAgent,
    harnessLocation,
    harnessFrom,
    showHarnessAgent,
    openConnectors,
    closePage,
    leaveSettings,
    leaveConnectors,
    showSection,
    showConnectorsSection,
  };
}
