import { type RefObject, useEffect, useRef, useState } from "react";
import { CONNECTORS_SECTIONS, type ConnectorsSection } from "../connectors-sections.ts";
import type { SettingsSection } from "../settings-sections.ts";
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
  const [loop, setLoop] = useState<{ projectKey: string | undefined } | undefined>(undefined);
  const lastLoopProject = useRef<string | undefined>(undefined);
  const pageOpen = settings !== undefined || connectors !== undefined || loop !== undefined;

  // Settings, from wherever it is asked for: over the sessions, or in place of the Connectors page.
  const openSettings = (via: "click" | "shortcut" = "click", section?: SettingsSection) => {
    if (section !== undefined) lastSection.current = section;
    setHarnessFrom("settings");
    setHarnessLocation(undefined);
    setConnectors(undefined);
    setLoop(undefined);
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
    setLoop(undefined);
    setSettings(section);
    store.track("panel_opened", { panel: "settings", via: "click" });
  };
  const showHarnessAgent = (agentId: string) => {
    setHarnessAgent(agentId);
    setHarnessFrom("settings");
  };
  const openConnectors = () => {
    setLoop(undefined);
    setConnectors(lastConnectorsSection.current);
    store.track("panel_opened", { panel: "connectors", via: "click" });
  };
  const openLoop = () => {
    setSettings(undefined);
    setConnectors(undefined);
    setLoop({ projectKey: lastLoopProject.current });
    store.track("panel_opened", { panel: "loop", via: "click" });
  };
  const showLoopProject = (projectKey: string) => {
    lastLoopProject.current = projectKey;
    setLoop({ projectKey });
  };
  const leaveLoop = () => {
    returnFocus.current = '[data-page-open="loop"]';
    setLoop(undefined);
  };
  // Whichever page is over the sessions is left: they are what is asked for.
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
    if (pageOpen) closePage();
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
    showLoopProject,
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
