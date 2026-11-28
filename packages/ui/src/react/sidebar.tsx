import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import type { LocationConfig, LocationStatus, LoopProjectInfo, SessionSummary } from "../api.ts";
import type { Elsewhere, SessionList, Workspace } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import {
  ConsoleIcon,
  KanbanIcon,
  MoreIcon,
  PlugIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TimelineIcon,
} from "./icons.tsx";
import type { LoopProjectTab } from "./loop-nav.ts";
import { type Away, type RowAction, SessionListView } from "./session-list.tsx";
import { LOCATION_STATE, StatusDot } from "./status.tsx";
import { Tip } from "./tip.tsx";
import { WorkspaceSwitcher } from "./workspace-switcher.tsx";

/** The sidebar's top global actions: new session, search, Connectors, and Loop Overview (CYC-533). */
export type SidebarActionsProps = {
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  onNewSession: () => void;
  onSearch: () => void;
  /** Opens the Connectors page: what the daemons keep for every agent. */
  onConnectors?: () => void;
  /** Opens the Loop Overview: cross-project Notices and all Loop Projects. */
  onLoop?: () => void;
  /** True while the main area shows the Loop Overview. */
  loopOverviewActive?: boolean;
  /** How many Loop Notices currently need the person, for the badge on the Loop action. */
  loopNoticeCount?: number;
};

/** What the sidebar shows under its global actions: the workspace switcher, its Loop views, and the sessions. */
export type SessionsNavProps = {
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  /** Every workspace, and the one shown (sessions.ts). */
  workspaces: readonly Workspace[];
  current: Workspace | undefined;
  /** What the other workspaces have, for the switcher's badge. */
  elsewhere: Elsewhere;
  onChooseWorkspace: (workspaceKey: string) => void;
  /** The Loop Project matched to `current` by git repo, if any (CYC-533). */
  loopProject?: LoopProjectInfo | undefined;
  /** True when the Loop server was seen before and is currently unreachable. */
  loopAway?: boolean | undefined;
  /** Which project-level Loop view is open for `loopProject`, if any. */
  activeProjectTab?: LoopProjectTab | undefined;
  onOpenProjectTab?: ((tab: LoopProjectTab) => void) | undefined;
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
  onConnectLocation: (locationId: string) => void;
  onToggleArchived: () => void;
  onShowAll: () => void;
  /**
   * Whether the shown workspace's folder is trusted (docs/protocol.md §8 "信任文件夹"): absent when its daemon cannot say,
   * or has not yet. With it, a menu beside the switcher offers to change it.
   */
  trust?: boolean | null | undefined;
  onTrust?: (trusted: boolean) => void;
};

/** How the shortcut modifier is written here: ⌘ on a Mac, Ctrl+ elsewhere. */
export const MOD = /Mac/.test(globalThis.navigator?.userAgent ?? "") ? "⌘" : "Ctrl+";

export function SidebarActions(props: SidebarActionsProps) {
  const { t } = useI18n();
  const connected = props.locations.filter((h) => props.status[h.id]?.state === "connected");
  const loopActive = props.loopOverviewActive === true;
  return (
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
      {props.onLoop !== undefined ? (
        <Button
          data-variant="ghost"
          data-kind="sidebar-action"
          data-page-open="loop"
          aria-current={loopActive ? "page" : undefined}
          data-selected={loopActive ? "" : undefined}
          aria-description={
            props.loopNoticeCount !== undefined && props.loopNoticeCount > 0
              ? t("loop.notices.count", { count: props.loopNoticeCount })
              : undefined
          }
          onClick={props.onLoop}
        >
          <RefreshIcon />
          <span>{t("loop.open")}</span>
          {props.loopNoticeCount !== undefined && props.loopNoticeCount > 0 ? (
            <span data-slot="loop-nav-badge" aria-hidden="true">
              {props.loopNoticeCount}
            </span>
          ) : null}
        </Button>
      ) : null}
    </div>
  );
}

export function SessionsNav(props: SessionsNavProps) {
  const { t } = useI18n();
  const connected = props.locations.filter((h) => props.status[h.id]?.state === "connected");
  const apart = props.locations.filter((h) => props.away.has(h.id));
  const loopAway = props.loopAway === true;
  return (
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
      {props.loopProject !== undefined && props.onOpenProjectTab !== undefined ? (
        <section data-slot="project-nav" aria-label={t("loop.projectNav")}>
          <button
            type="button"
            data-slot="project-nav-item"
            data-kind="project-nav-console"
            aria-current={props.activeProjectTab === "console" ? "page" : undefined}
            disabled={loopAway}
            onClick={() => props.onOpenProjectTab?.("console")}
          >
            <ConsoleIcon />
            <span>{t("loop.tab.console")}</span>
            {loopAway ? <span data-slot="loop-nav-note">{t("loop.offline.note")}</span> : null}
          </button>
          <button
            type="button"
            data-slot="project-nav-item"
            data-kind="project-nav-kanban"
            aria-current={props.activeProjectTab === "kanban" ? "page" : undefined}
            disabled={loopAway}
            onClick={() => props.onOpenProjectTab?.("kanban")}
          >
            <KanbanIcon />
            <span>{t("loop.tab.kanban")}</span>
            {loopAway ? <span data-slot="loop-nav-note">{t("loop.offline.note")}</span> : null}
          </button>
          <button
            type="button"
            data-slot="project-nav-item"
            data-kind="project-nav-timeline"
            aria-current={props.activeProjectTab === "timeline" ? "page" : undefined}
            disabled={loopAway}
            onClick={() => props.onOpenProjectTab?.("timeline")}
          >
            <TimelineIcon />
            <span>{t("loop.tab.timeline")}</span>
            {loopAway ? <span data-slot="loop-nav-note">{t("loop.offline.note")}</span> : null}
          </button>
        </section>
      ) : null}
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
  );
}

export { sessionTitle } from "./session-list.tsx";
