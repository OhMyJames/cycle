// The right panel of the open session (CYCL-90): its tabs, as that session last had them. It is in the page only while
// open, and only the tab shown is mounted, so a panel or a tab not looked at loads nothing and asks the daemon nothing.
// After the session's views come its terminals (CYCL-98), one tab each, as its daemon lists them: they are the daemon's,
// so the strip shows what is there, and closing a tab ends its shell.
import { Button } from "@ui-sdk/react/button";
import type { MessageKey } from "../messages/en-US.ts";
import type { PanelTabId, PanelTabKind, SidePanelState } from "../side-panel.ts";
import { viewKey } from "../store/store.ts";
import { type TerminalTab, tabLabels, terminalOfTab, terminalTab } from "../terminals.ts";
import { Diff } from "./diff.tsx";
import { Files } from "./files.tsx";
import { useI18n } from "./i18n.tsx";
import { PlusIcon } from "./icons.tsx";
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
}: {
  locationId: string;
  sessionId: string;
  state: SidePanelState;
  onShow: (tab: PanelTabId) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const key = viewKey(locationId, sessionId);
  const terminals = useAppState((s) => s.terminals[key]) ?? NONE;
  const canOpen = useAppState(
    (s) =>
      s.status[locationId]?.capabilities?.terminal === true &&
      s.status[locationId]?.state === "connected",
  );
  const ids: PanelTabId[] = [...state.tabs, ...terminals.map((x) => terminalTab(x.terminalId))];
  const labels = tabLabels(terminals);
  // A terminal shown last that is no longer there (closed in another window): the last tab instead.
  const active = ids.includes(state.active) ? state.active : (ids.at(-1) ?? "overview");
  return (
    <PanelTabs
      label={t("panel.tabs")}
      value={active}
      onValueChange={(id) => {
        const tab = ids.find((x) => x === id);
        if (tab !== undefined && tab !== active) onShow(tab);
      }}
      tabs={[
        ...state.tabs.map((tab) => ({ id: tab, label: t(LABEL[tab]), content: contentOf(tab) })),
        ...terminals.map((terminal, i) => ({
          id: terminalTab(terminal.terminalId),
          label: labels[i] ?? terminal.title,
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
        canOpen ? (
          <Tip label={t("terminal.new")} side="bottom">
            <Button
              data-variant="ghost"
              data-kind="panel-tab-add"
              onClick={() =>
                void store.createTerminal(locationId, sessionId, FIRST_SIZE, "tab_strip")
              }
            >
              <PlusIcon />
            </Button>
          </Tip>
        ) : null
      }
    />
  );
}

/** Which terminal the header's Terminal button shows: the one the panel showed last, or the newest. */
export const terminalToShow = (
  state: SidePanelState,
  terminals: readonly TerminalTab[],
): PanelTabId | undefined => {
  const last = terminalOfTab(state.active);
  if (last !== undefined && terminals.some((x) => x.terminalId === last)) return state.active;
  const newest = terminals.at(-1);
  return newest !== undefined ? terminalTab(newest.terminalId) : undefined;
};
