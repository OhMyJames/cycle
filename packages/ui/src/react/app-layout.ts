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
import { tabKind } from "../terminals.ts";
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
 * The open session's right panel (CYCL-90), and what its header's button and its own strip do with it: a blank conversation or no
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
      ? viewKey(session.locationId, session.sessionId)
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
  // A tab picked in the panel's own strip, or in its menu of tabs to open.
  const showTab = (tab: PanelTabId) => {
    if (panelKey === undefined) return;
    sidePanels.show(panelKey, tab);
    store.track("side_panel_tab_shown", { tab: tabKind(tab) });
  };
  // A view's tab closed in the strip. The strip's last tab closes the panel instead, and is there when it opens again.
  const closeTab = (tab: PanelTabKind, next: PanelTabId | undefined) => {
    if (panelKey === undefined) return;
    if (next === undefined) {
      sidePanels.setOpen(panelKey, false);
      store.track("side_panel_toggled", { open: false, via: "click", tab });
      return;
    }
    sidePanels.close(panelKey, tab, next);
    store.track("side_panel_tab_closed", { tab });
  };
  // The session's terminals are read once its daemon can open them: each is a tab of the panel.
  const canOpenTerminals = useAppState((s) =>
    session !== undefined ? s.status[session.locationId]?.capabilities?.terminal === true : false,
  );
  const terminalsConnected = useAppState((s) =>
    session !== undefined ? s.status[session.locationId]?.state === "connected" : false,
  );
  const terminalsOf = panelKey !== undefined ? session : undefined;
  const terminalsLocation = terminalsOf?.locationId;
  const terminalsSession = terminalsOf?.sessionId;
  useEffect(() => {
    if (terminalsLocation === undefined || terminalsSession === undefined) return;
    if (!canOpenTerminals || !terminalsConnected) return;
    void store.loadTerminals(terminalsLocation, terminalsSession);
  }, [store, terminalsLocation, terminalsSession, canOpenTerminals, terminalsConnected]);

  return { panelKey, sidePanel, toggleSidePanel, showTab, closeTab };
}

export type SessionPanel = ReturnType<typeof useSessionPanel>;
