import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import type { ReactNode } from "react";
import type { LocationConfig, LocationStatus, SessionSummary } from "../api.ts";
import type { Elsewhere, SessionList, Workspace } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { MoreIcon, PlugIcon, PlusIcon, RefreshIcon, SearchIcon } from "./icons.tsx";
import { type Away, type RowAction, SessionListView } from "./session-list.tsx";
import { LOCATION_STATE, StatusDot } from "./status.tsx";
import { Tip } from "./tip.tsx";
import { WorkspaceSwitcher } from "./workspace-switcher.tsx";

export type SidebarProps = {
  /** The button that folds the sidebar, in its top-right corner (beside the traffic lights on a Mac). */
  toggle?: ReactNode;
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  /** Every workspace, and the one shown (sessions.ts). */
  workspaces: readonly Workspace[];
  current: Workspace | undefined;
  /** What the other workspaces have, for the switcher's badge. */
  elsewhere: Elsewhere;
  onChooseWorkspace: (workspaceKey: string) => void;
  /** What is shown, grouped and ordered (sessions.ts): the sessions of the current workspace. */
  list: SessionList;
  /** The open session, by its `sessionKey`. */
  selected: string | undefined;
  /** The locations that are not connected, whose sessions are shown greyed. */
  away: ReadonlyMap<string, Away>;
  showArchived: boolean;
  /** The pinned sessions, by `sessionKey` (pins.ts). */
  pinned: ReadonlySet<string>;
  onSelectSession: (session: SessionSummary) => void;
  /** What a row's own controls ask: pin, archive, delete. */
  onSessionAction: (session: SessionSummary, action: RowAction) => void;
  onNewSession: () => void;
  onSearch: () => void;
  /** Opens the Connectors page: what the daemons keep for every agent. */
  onConnectors?: () => void;
  /** Switches to the Loop mode: the Projects of the Loop server and their boards. */
  onLoop?: () => void;
  /** Switches back to the Sessions mode. */
  onSessions?: () => void;
  /** Which of the two the lower half shows. */
  mode?: "sessions" | "loop";
  /** The lower half in the Loop mode (loop.tsx `LoopNav`). */
  loopNav?: ReactNode;
  onConnectLocation: (locationId: string) => void;
  onToggleArchived: () => void;
  onShowAll: () => void;
  /**
   * Whether the shown workspace's folder is trusted (docs/protocol.md §8 "信任文件夹"): absent when its daemon cannot say,
   * or has not yet. With it, a menu beside the switcher offers to change it.
   */
  trust?: boolean | null | undefined;
  onTrust?: (trusted: boolean) => void;
  /** Below the rest: the update footer. */
  children?: ReactNode;
  /** What concerns the whole app (app-notices.tsx), over the footer. */
  notices?: ReactNode;
};

/** How the shortcut modifier is written here: ⌘ on a Mac, Ctrl+ elsewhere. */
export const MOD = /Mac/.test(globalThis.navigator?.userAgent ?? "") ? "⌘" : "Ctrl+";

export function Sidebar(props: SidebarProps) {
  const { t } = useI18n();
  const connected = props.locations.filter((h) => props.status[h.id]?.state === "connected");
  const loopMode = props.mode === "loop";
  const apart = props.locations.filter((h) => props.away.has(h.id));
  return (
    <nav data-slot="sidebar" aria-label={t("sessions.label")}>
      <div data-slot="titlebar">{props.toggle}</div>
      <div data-slot="sidebar-actions">
        <Button
          data-variant="ghost"
          data-kind="sidebar-action"
          disabled={connected.length === 0}
          aria-label={t("sidebar.newSession")}
          title={`${t("sidebar.newSession")}  ${MOD}N`}
          onClick={props.onNewSession}
        >
          <PlusIcon />
          {t("sidebar.newShort")}
          <kbd>{MOD}N</kbd>
        </Button>
        <Button
          data-variant="ghost"
          data-kind="sidebar-action"
          aria-label={t("search.open")}
          title={`${t("search.open")}  ${MOD}K`}
          onClick={props.onSearch}
        >
          <SearchIcon />
          {t("sidebar.searchShort")}
          <kbd>{MOD}K</kbd>
        </Button>
        {props.onConnectors !== undefined ? (
          <Button
            data-variant="ghost"
            data-kind="sidebar-action"
            data-page-open="connectors"
            onClick={props.onConnectors}
          >
            <PlugIcon />
            {t("connectors.open")}
          </Button>
        ) : null}
      </div>
      {props.onLoop !== undefined && props.onSessions !== undefined ? (
        <section data-slot="mode-switch" aria-label={t("sidebar.mode")}>
          <Button
            data-variant="ghost"
            data-kind="mode-switch"
            data-mode="sessions"
            aria-pressed={!loopMode}
            data-selected={!loopMode ? "" : undefined}
            onClick={props.onSessions}
          >
            {t("sessions.label")}
          </Button>
          <Button
            data-variant="ghost"
            data-kind="mode-switch"
            data-mode="loop"
            aria-pressed={loopMode}
            data-selected={loopMode ? "" : undefined}
            onClick={props.onLoop}
          >
            <RefreshIcon size={14} />
            {t("loop.open")}
          </Button>
        </section>
      ) : null}
      {loopMode ? (
        <div data-slot="sidebar-scroll" data-mode="loop">
          {props.loopNav}
        </div>
      ) : null}
      {loopMode ? null : (
        <>
          {/* Below the actions, above the list it chooses: the switcher names what the list shows. */}
          <div data-slot="location-bar">
            <WorkspaceSwitcher
              workspaces={props.workspaces}
              current={props.current}
              elsewhere={props.elsewhere}
              locations={props.locations}
              status={props.status}
              onChoose={props.onChooseWorkspace}
            />
            {/* What can be done with the folder that is shown. The locations themselves are in Settings. */}
            {props.trust !== undefined && props.onTrust !== undefined ? (
              <Menu
                onAction={(value) => {
                  if (value === "trust") props.onTrust?.(true);
                  else if (value === "untrust") props.onTrust?.(false);
                }}
              >
                <Tip label={t("workspace.actions")}>
                  <MenuTrigger data-variant="ghost">
                    <MoreIcon />
                  </MenuTrigger>
                </Tip>
                <MenuContent>
                  <MenuItem value={props.trust === true ? "untrust" : "trust"}>
                    {t(props.trust === true ? "trust.untrust" : "trust.trust")}
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </div>
          {apart.map((h) => {
            const state = props.status[h.id];
            const how = LOCATION_STATE[state?.state ?? "closed"];
            const line = t("location.status", { location: h.name, state: t(how.word) });
            return (
              <span
                key={h.id}
                data-slot="location-state"
                data-state={state?.state ?? "closed"}
                role="status"
              >
                <StatusDot tone={how.tone} shape={how.shape} />
                <span data-slot="location-name" title={line}>
                  {line}
                </span>
                {state?.error !== undefined && (state?.state ?? "closed") === "closed" ? (
                  <span data-slot="hint" title={state.error}>
                    {state.error}
                  </span>
                ) : null}
                {(state?.state ?? "closed") === "closed" ? (
                  <Button data-variant="ghost" onClick={() => props.onConnectLocation(h.id)}>
                    {t("location.connectAgain")}
                  </Button>
                ) : null}
              </span>
            );
          })}
          {/* Only the list scrolls: what is above it and the footer stay where the hand expects them. */}
          <div data-slot="sidebar-scroll">
            {props.list.order.length > 0 ? (
              <SessionListView
                list={props.list}
                selected={props.selected}
                away={props.away}
                pinned={props.pinned}
                onSelect={props.onSelectSession}
                onShowAll={props.onShowAll}
                onAction={props.onSessionAction}
              />
            ) : (
              <p data-slot="hint">
                {t(
                  connected.length === 0 && props.locations.length > 0
                    ? "sessions.unavailable"
                    : "sessions.empty",
                )}
              </p>
            )}
            <button type="button" data-slot="list-toggle" onClick={props.onToggleArchived}>
              {t(props.showArchived ? "sessions.hideArchived" : "sessions.showArchived")}
            </button>
          </div>
        </>
      )}
      {props.notices}
      {props.children != null ? <div data-slot="sidebar-footer">{props.children}</div> : null}
    </nav>
  );
}

export { sessionTitle } from "./session-list.tsx";
