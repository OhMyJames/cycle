import { createResizableController } from "@ui-sdk/react/resizable";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SessionSummary } from "../api.ts";
import type { PanelTabId, PanelTabKind } from "../side-panel.ts";
import { type BlankConversation, viewKey } from "../store/index.ts";
import { tabKind, terminalOfTab } from "../terminals.ts";
import { FIRST_SIZE, terminalToShow } from "./side-panel.tsx";
import { slideColumns } from "./split-layout.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/**
 * The window's columns, and the sidebar's: folded or open, by its button, its shortcut, a drag or the layout that was
 * saved. The sidebar slides only when it is folded or opened on purpose (`slideColumns`, as the panel does): a drag, or
 * a window being resized, moves it at once.
 */
export function useSidebarFold(appRef: RefObject<HTMLElement | null>, ready: boolean) {
  const store = useAppStore();
  const [layout] = useState(createResizableController);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const endSlide = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => endSlide.current?.(), []);
  const toggleSidebar = useCallback(
    (via: "click" | "shortcut") => {
      const wasCollapsed = layout.isCollapsed("sidebar") || sidebarCollapsed;
      const split = appRef.current?.querySelector<HTMLElement>('[data-slot="split"]');
      endSlide.current?.();
      const fold = () => (wasCollapsed ? layout.expand("sidebar") : layout.collapse("sidebar"));
      if (split == null) fold();
      else
        endSlide.current = slideColumns(split, "sidebar", fold, () => {
          endSlide.current = undefined;
        });
      setSidebarCollapsed(!wasCollapsed);
      // The button moves (into the sidebar's corner, or the conversation's header): focus follows it, so a keyboard
      // user is not left on the page.
      if (document.activeElement?.closest('[data-kind="sidebar-toggle"]') != null)
        requestAnimationFrame(() =>
          appRef.current
            ?.querySelector<HTMLElement>('[data-kind="sidebar-toggle"]:not([inert] *)')
            ?.focus(),
        );
      store.track("sidebar_toggled", { open: wasCollapsed, via });
    },
    [layout, sidebarCollapsed, store, appRef],
  );

  // Keep toggle button label synced with drag, double-click, keyboard and saved layout.
  useEffect(() => {
    if (!ready) return;
    const root = appRef.current;
    if (root === null) return;
    const sync = () => {
      const panel = root.querySelector('[data-slot="resizable-panel"]#sidebar');
      setSidebarCollapsed(panel?.hasAttribute("data-collapsed") === true);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-collapsed"],
    });
    return () => observer.disconnect();
  }, [ready, appRef]);

  return { layout, sidebarCollapsed, toggleSidebar };
}

/**
 * The open session's right panel (CYCL-90) and what its header's buttons do with it: a blank conversation or no
 * session has none. Its terminals (CYCL-98) are read once its daemon can open them.
 */
export function useSessionPanel(
  session: SessionSummary | undefined,
  blank: BlankConversation | undefined,
) {
  const store = useAppStore();
  const sidePanels = store.sidePanels;
  const panelKey =
    blank === undefined && session !== undefined
      ? viewKey(session.environmentId, session.sessionId)
      : undefined;
  const readPanel = () => (panelKey !== undefined ? sidePanels.get(panelKey) : undefined);
  const sidePanel = useSyncExternalStore(sidePanels.subscribe, readPanel, readPanel);
  const toggleSidePanel = (via: "click" | "shortcut" | "handle") => {
    if (panelKey === undefined || sidePanel === undefined) return;
    sidePanels.setOpen(panelKey, !sidePanel.open);
    store.track("side_panel_toggled", {
      open: !sidePanel.open,
      via,
      tab: tabKind(sidePanel.active),
    });
  };
  // A tab's own button in the header: opens the panel on that tab; on it already, closes the panel.
  const toggleTab = (tab: PanelTabKind) => {
    if (panelKey === undefined || sidePanel === undefined) return;
    if (sidePanel.open && sidePanel.active === tab) {
      sidePanels.setOpen(panelKey, false);
      store.track("side_panel_toggled", { open: false, via: "tab_button", tab });
    } else if (sidePanel.open) {
      sidePanels.show(panelKey, tab);
      store.track("side_panel_tab_shown", { tab });
    } else {
      sidePanels.show(panelKey, tab);
      store.track("side_panel_toggled", { open: true, via: "tab_button", tab });
    }
  };
  // A tab picked in the panel's own strip.
  const showTab = (tab: PanelTabId) => {
    if (panelKey === undefined) return;
    sidePanels.show(panelKey, tab);
    store.track("side_panel_tab_shown", { tab: tabKind(tab) });
  };
  // The session's terminals, once its daemon can open them: the Terminal button shows one, or opens one.
  const canOpenTerminals = useAppState((s) =>
    session !== undefined
      ? s.status[session.environmentId]?.capabilities?.terminal === true
      : false,
  );
  const terminalsConnected = useAppState((s) =>
    session !== undefined ? s.status[session.environmentId]?.state === "connected" : false,
  );
  const sessionTerminals = useAppState((s) =>
    panelKey !== undefined ? s.terminals[panelKey] : undefined,
  );
  const terminalsOf = panelKey !== undefined ? session : undefined;
  const terminalsEnvironment = terminalsOf?.environmentId;
  const terminalsSession = terminalsOf?.sessionId;
  useEffect(() => {
    if (terminalsEnvironment === undefined || terminalsSession === undefined) return;
    if (!canOpenTerminals || !terminalsConnected) return;
    void store.loadTerminals(terminalsEnvironment, terminalsSession);
  }, [store, terminalsEnvironment, terminalsSession, canOpenTerminals, terminalsConnected]);
  const terminalShown =
    sidePanel?.open === true &&
    terminalOfTab(sidePanel.active) !== undefined &&
    (sessionTerminals ?? []).some((x) => x.terminalId === terminalOfTab(sidePanel.active));
  // The header's Terminal button: on a terminal already, it closes the panel; else it shows the terminal shown last,
  // or the newest; with none, it opens one.
  const toggleTerminal = async () => {
    if (panelKey === undefined || sidePanel === undefined || session === undefined) return;
    if (terminalShown) {
      sidePanels.setOpen(panelKey, false);
      store.track("side_panel_toggled", { open: false, via: "tab_button", tab: "terminal" });
      return;
    }
    // Pressed before the list came: it is read first, so a terminal already there is shown, not another one opened.
    await store.loadTerminals(session.environmentId, session.sessionId);
    const panel = sidePanels.get(panelKey);
    const tab = terminalToShow(panel, store.getState().terminals[panelKey] ?? []);
    if (tab === undefined) {
      void store.createTerminal(session.environmentId, session.sessionId, FIRST_SIZE, "header");
      return;
    }
    sidePanels.show(panelKey, tab);
    if (panel.open) store.track("side_panel_tab_shown", { tab: "terminal" });
    else store.track("side_panel_toggled", { open: true, via: "tab_button", tab: "terminal" });
  };
  // Files needs a daemon that reads a session's folder (docs/protocol.md §8): an older one is not offered it.
  const canShowFiles = useAppState((s) =>
    session !== undefined ? s.status[session.environmentId]?.capabilities?.fs === true : false,
  );
  const shows = (tab: PanelTabKind) => sidePanel?.open === true && sidePanel.active === tab;

  return {
    panelKey,
    sidePanel,
    toggleSidePanel,
    toggleTab,
    showTab,
    shows,
    canShowFiles,
    canOpenTerminals,
    terminalsConnected,
    hasTerminals: (sessionTerminals ?? []).length > 0,
    terminalShown,
    toggleTerminal,
  };
}

export type SessionPanel = ReturnType<typeof useSessionPanel>;
