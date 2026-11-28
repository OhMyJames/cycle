// The right panel of the open session (CYCL-90): its tabs, as that session last had them. It is in the page only while
// open, and only the tab shown is mounted, so a panel or a tab not looked at loads nothing and asks the daemon nothing.
// After the session's views come its terminals (CYCL-98), one tab each, as its daemon lists them: they are the daemon's,
// so the strip shows what is there, and closing a tab ends its shell.
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import type { ReactNode } from "react";
import type { MessageKey } from "../messages/en-US.ts";
import {
  CLOSED,
  isTab,
  type PanelTabId,
  type PanelTabKind,
  type SidePanelState,
} from "../side-panel.ts";
import { viewKey } from "../store/store.ts";
import { neighbourOf, type TerminalTab, tabLabels, terminalTab } from "../terminals.ts";
import { Diff } from "./diff.tsx";
import { Files } from "./files.tsx";
import { useI18n } from "./i18n.tsx";
import { DiffIcon, FolderIcon, OverviewIcon, PlusIcon, TerminalIcon } from "./icons.tsx";
import { Overview } from "./overview.tsx";
import { PanelTabs } from "./panel-tabs.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { TerminalView } from "./terminal.tsx";
import { Tip } from "./tip.tsx";

const LABEL: Record<PanelTabKind, MessageKey> = {
  overview: "panel.tab.overview",
  files: "panel.tab.files",
  diff: "panel.tab.diff",
};

const ICON: Record<PanelTabKind, ReactNode> = {
  overview: <OverviewIcon size={14} />,
  files: <FolderIcon size={14} />,
  diff: <DiffIcon size={14} />,
};

const contentOf = (tab: PanelTabKind) => {
  switch (tab) {
    case "overview":
      return <Overview />;
    case "files":
      return <Files />;
    case "diff":
      return <Diff />;
  }
};

const NONE: readonly TerminalTab[] = [];

/** A new shell's size until its tab has measured the panel: it is told the real one as soon as it is shown. */
export const FIRST_SIZE = { cols: 80, rows: 24 };

export function SidePanel({
  locationId,
  sessionId,
  state,
  onShow,
  onClose,
}: {
  locationId: string;
  sessionId: string;
  state: SidePanelState;
  onShow: (tab: PanelTabId) => void;
  /** A view's tab was closed: `next` is the tab to show in its place, none when it was the strip's last. */
  onClose: (tab: PanelTabKind, next: PanelTabId | undefined) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const key = viewKey(locationId, sessionId);
  const listed = useAppState((s) => s.terminals[key]);
  const terminals = listed ?? NONE;
  const canOpen = useAppState(
    (s) =>
      s.status[locationId]?.capabilities?.terminal === true &&
      s.status[locationId]?.state === "connected",
  );
  // Files needs a daemon that reads a session's folder (docs/protocol.md §8): an older one is not offered it.
  const canShowFiles = useAppState((s) => s.status[locationId]?.capabilities?.fs === true);
  const offered = (tab: PanelTabKind) => tab !== "files" || canShowFiles;
  const kept = state.tabs.filter(offered);
  // Every view closed and no terminal left: the strip starts again from its views. Not while the session's terminals
  // are still to come from a daemon that has them: they are its tabs, and the views would show only to go.
  const known = listed !== undefined || !canOpen;
  const again = kept.length === 0 && terminals.length === 0 && known;
  const views = again ? CLOSED.tabs.filter(offered) : kept;
  // What is drawn is then the panel's own, before anything is done with it: the strip and what is kept agree.
  const settle = () => {
    if (again) store.sidePanels.restore(key);
  };
  const ids: PanelTabId[] = [...views, ...terminals.map((x) => terminalTab(x.terminalId))];
  const labels = tabLabels(terminals);
  // A tab shown last that is no longer there (a terminal closed in another window, Files on an older daemon): the last.
  const active = ids.includes(state.active) ? state.active : (ids.at(-1) ?? "overview");
  return (
    <PanelTabs
      label={t("panel.tabs")}
      value={active}
      onValueChange={(id) => {
        const tab = ids.find((x) => x === id);
        if (tab === undefined || tab === active) return;
        settle();
        onShow(tab);
      }}
      tabs={[
        ...views.map((tab) => ({
          id: tab,
          label: t(LABEL[tab]),
          icon: ICON[tab],
          content: contentOf(tab),
          onClose: () => {
            settle();
            onClose(tab, neighbourOf(ids, tab));
          },
        })),
        ...terminals.map((terminal, i) => ({
          id: terminalTab(terminal.terminalId),
          label: labels[i] ?? terminal.title,
          icon: <TerminalIcon size={14} />,
          quiet: terminal.status === "exited" || terminal.ended === true,
          onClose: () => void store.closeTerminal(locationId, sessionId, terminal.terminalId),
          content: (
            <TerminalView
              key={terminal.terminalId}
              locationId={locationId}
              sessionId={sessionId}
              terminal={terminal}
            />
          ),
        })),
      ]}
      actions={
        // Every kind of tab the panel has: a view already in the strip is shown, one that was closed is put back.
        <Menu
          onAction={(value) => {
            if (value === "terminal")
              void store.createTerminal(locationId, sessionId, FIRST_SIZE, "tab_strip");
            // The one shown already: nothing to do, and nothing to count.
            else if (isTab(value) && value !== active) {
              settle();
              onShow(value);
            }
          }}
        >
          <Tip label={t("panel.open")} side="bottom">
            <MenuTrigger data-variant="ghost" data-kind="panel-tab-add">
              <PlusIcon />
            </MenuTrigger>
          </Tip>
          <MenuContent>
            {CLOSED.tabs.filter(offered).map((tab) => (
              <MenuItem key={tab} value={tab}>
                {ICON[tab]}
                {t(LABEL[tab])}
              </MenuItem>
            ))}
            {canOpen ? (
              <>
                <MenuSeparator />
                <MenuItem value="terminal">
                  <TerminalIcon size={14} />
                  {t("terminal.new")}
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      }
    />
  );
}
