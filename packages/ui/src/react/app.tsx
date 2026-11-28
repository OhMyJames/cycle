import { Button } from "@ui-sdk/react/button";
import { ToastRegion } from "@ui-sdk/react/toast";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AccountStatus, SessionSummary, UnsavedWork } from "../api.ts";
import { SOURCE_LOCALE } from "../i18n.ts";
import { resolveLanguage, translatorFor } from "../languages.ts";
import { contextOf } from "../model/conversation.ts";
import { pins } from "../pins.ts";
import { sessionKey } from "../sessions.ts";
import { viewKey } from "../store/index.ts";
import { AccountMenu, SignInPage } from "./account.tsx";
import { useSessionPanel, useSidebarFold } from "./app-layout.ts";
import { NoSession, PendingRequest } from "./app-main.tsx";
import { useMarkRead, useSessionNavigation, useWorkspaceTrust } from "./app-navigation.ts";
import { AppNotices } from "./app-notices.tsx";
import { usePlaces } from "./app-pages.ts";
import { useAppShortcuts } from "./app-shortcuts.ts";
import { BlankConversationView } from "./blank.tsx";
import { Composer } from "./composer.tsx";
import { mergeConfigSchema } from "./config-form.tsx";
import { ConnectorsPage } from "./connectors.tsx";
import { ConversationView } from "./conversation.tsx";
import { ConfirmDialog, LocationDialog, type RemoteLocation } from "./dialogs.tsx";
import { I18nProvider, useI18n } from "./i18n.tsx";
import { ErrorCircleIcon, SidebarIcon } from "./icons.tsx";
import { LoopMain } from "./loop.tsx";
import { type LoopProjectTab, matchLoopProject } from "./loop-nav.ts";
import { errorText, SessionNotices } from "./notice-line.tsx";
import { currentPlan } from "./plan.tsx";
import { SearchDialog } from "./search.tsx";
import { SessionHeader } from "./session-header.tsx";
import { SessionSettings } from "./session-settings.tsx";
import { SettingsPage } from "./settings.tsx";
import { AppShell, Place, ShellNotices } from "./shell.tsx";
import { SidePanel } from "./side-panel.tsx";
import { SessionsNav, SidebarActions } from "./sidebar.tsx";
import { SplitLayout } from "./split-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";
import { WorktreeSetupNotice } from "./worktrees.tsx";

/** What the sign-in page shows when main has not said how the account stands (it could not be asked). */
const SIGNED_OUT: AccountStatus = { state: "signed-out", open: false, signingIn: false };

/** The dialogs the window opens over what it shows, one at a time. */
type Panel =
  | "none"
  | "add-location"
  | "edit-location"
  | "remove-location"
  | "delete"
  | "settings"
  | "search"
  | "trust";

/** The word each panel has in the dictionary of events (@cycle/analytics). */
const PANEL_EVENT = {
  search: "search",
  "add-location": "add_location",
  "edit-location": "edit_location",
  "remove-location": "remove_location",
  settings: "session_settings",
  delete: "delete",
  trust: "trust",
} as const;

/**
 * The app, in the language the person chose (or the system's, when it is one the interface has). The page's `lang`
 * follows, so that what reads it (a screen reader, the fonts of Chinese) knows which it is.
 */
export function App() {
  const preferences = useAppState((s) => s.preferences);
  const language = resolveLanguage(
    preferences?.language ?? "system",
    preferences?.systemLanguage ?? SOURCE_LOCALE,
  );
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const ready = useAppState((s) => s.ready);
  const account = useAppState((s) => s.account);
  // Nobody is signed in: the sign-in page is the whole window. The app's window is not mounted behind it, so none of
  // its shortcuts or effects runs, and nothing of the locations has been read.
  const signedOut = ready && (account === undefined || !account.open);
  return (
    <I18nProvider translator={translatorFor(language)}>
      {signedOut ? <SignInPage account={account ?? SIGNED_OUT} /> : <AppWindow />}
    </I18nProvider>
  );
}

/**
 * The window once someone is signed in: the sidebar, the open session (or a blank one) with its right panel, the pages
 * that take the window over them, and the dialogs. What each part does is in its own hook or component; here they are
 * put together.
 */
function AppWindow() {
  const store = useAppStore();
  const { t } = useI18n();
  const ready = useAppState((s) => s.ready);
  const locations = useAppState((s) => s.locations);
  const status = useAppState((s) => s.status);
  const selectedLocation = useAppState((s) => s.selectedLocation);
  const selectedSession = useAppState((s) => s.selectedSession);
  const sessionsByLocation = useAppState((s) => s.sessions);
  const agentsByLocation = useAppState((s) => s.agents);
  const views = useAppState((s) => s.views);
  const blank = useAppState((s) => s.blank);
  const error = useAppState((s) => s.error);
  const [panel, setPanel] = useState<Panel>("none");
  // The session Delete asks about: the open one from its header, or any from its row in the sidebar.
  const [deleting, setDeleting] = useState<SessionSummary | undefined>(undefined);
  // What the session's worktree would lose, once the daemon has refused to delete it unasked.
  const [unsaved, setUnsaved] = useState<UnsavedWork | undefined>(undefined);
  const pinned = useSyncExternalStore(pins.subscribe, pins.all, pins.all);
  // The open session whose title is being edited in the header, by its key.
  const [renaming, setRenaming] = useState<string | undefined>();
  const [sent, setSent] = useState(0);
  const [targetLocation, setTargetLocation] = useState<string | undefined>(undefined);
  const appRef = useRef<HTMLDivElement>(null);

  // The sessions of every location, in one list; what is open is on the location `selectedLocation` names.
  const sessions = useMemo(
    () => locations.flatMap((h) => sessionsByLocation[h.id] ?? []),
    [locations, sessionsByLocation],
  );
  const agents = selectedLocation !== undefined ? (agentsByLocation[selectedLocation] ?? []) : [];
  const session = sessions.find(
    (s) => s.locationId === selectedLocation && s.sessionId === selectedSession,
  );
  const agent = agents.find((a) => a.id === session?.agent);
  const connectedLocations = locations.filter((h) => status[h.id]?.state === "connected");
  const view =
    selectedLocation !== undefined && selectedSession !== undefined
      ? views[viewKey(selectedLocation, selectedSession)]
      : undefined;
  const sessionSchema = useMemo(
    () =>
      agent === undefined
        ? undefined
        : mergeConfigSchema(agent.configSchema, view?.conversation.configOptions),
    [agent, view?.conversation.configOptions],
  );
  // Rebuilt only when what it shows changes, not on every streamed chunk.
  const conversation = view?.conversation;
  const counted = conversation === undefined ? undefined : contextOf(conversation);
  const usage = counted?.usage;
  const compactions = counted?.compactions ?? 0;
  const compacting = counted?.compacting ?? false;
  const hasConversation = conversation !== undefined;
  const context = useMemo(
    () => (hasConversation ? { usage, compactions, compacting } : undefined),
    [hasConversation, usage, compactions, compacting],
  );
  // The account's limits, as the session's agent last told them on this location.
  const planUsage = useAppState((s) =>
    selectedLocation !== undefined && session !== undefined
      ? s.planUsage[selectedLocation]?.[session.agent]
      : undefined,
  );
  const locationState =
    selectedLocation !== undefined ? status[selectedLocation]?.state : undefined;
  const connected = locationState === "connected";

  const places = usePlaces(appRef);
  const { place } = places;
  const loopProjects = useAppState((s) => s.loop.projects);
  const loopConnected = useAppState((s) => s.loop.connected);
  const workspaceRepos = useAppState((s) => s.loop.workspaceRepos);
  const knownLoopSessions = useAppState((s) => s.loop.knownSessions);
  const knownLoopSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const list of Object.values(knownLoopSessions)) {
      for (const id of list) ids.add(id);
    }
    return ids;
  }, [knownLoopSessions]);
  const [timelineReturn, setTimelineReturn] = useState<
    { projectKey: string; sessionId: string } | undefined
  >(undefined);
  const loopNoticeCount = useAppState((s) =>
    s.loop.projects.reduce((sum, p) => {
      const answer = s.loop.notices[p.projectKey];
      return sum + (answer?.kind === "ok" ? answer.notices.length : 0);
    }, 0),
  );
  const { layout, sidebarCollapsed, toggleSidebar } = useSidebarFold(appRef, ready);
  const sessionPanel = useSessionPanel(session, blank);
  const { panelKey, sidePanel } = sessionPanel;
  const nav = useSessionNavigation({
    locations,
    status,
    sessions,
    session,
    blank,
    pinned,
    knownLoopSessionIds,
  });
  const trust = useWorkspaceTrust(nav.current, status, panel !== "none");
  useMarkRead(session, status, places.base === "sessions");

  // Discover Loop Projects once signed in so a matched local workspace shows Kanban and Timeline in the sidebar (CYC-533).
  useEffect(() => {
    if (!ready) return;
    void store.loadLoopProjects();
  }, [ready, store]);

  const localCwdsKey = useMemo(
    () =>
      nav.workspaces
        .filter(
          (w) => locations.find((h) => h.id === w.locationId)?.kind === "local" && w.cwd !== "",
        )
        .map((w) => w.cwd)
        .join("\n"),
    [nav.workspaces, locations],
  );
  useEffect(() => {
    if (!ready || localCwdsKey === "") return;
    for (const cwd of localCwdsKey.split("\n")) void store.loadWorkspaceRepo(cwd);
  }, [ready, store, localCwdsKey]);

  const matchedProjectOf = (workspace: { locationId: string; cwd: string } | undefined) => {
    if (workspace === undefined) return undefined;
    if (locations.find((h) => h.id === workspace.locationId)?.kind !== "local") return undefined;
    return matchLoopProject(loopProjects, workspaceRepos[workspace.cwd]);
  };
  const currentLoopProject = matchedProjectOf(nav.current);
  // Preload known Loop session IDs for the matched project so legacy pre-CYC-534 Loop sessions stay out of the sidebar.
  useEffect(() => {
    if (!ready || loopConnected !== true || currentLoopProject === undefined) return;
    if (Object.hasOwn(knownLoopSessions, currentLoopProject.projectKey)) return;
    void store.loadLoopTimeline(currentLoopProject.projectKey);
  }, [ready, loopConnected, currentLoopProject, knownLoopSessions, store]);
  const syncWorkspaceForProject = (projectKey: string) => {
    const project = loopProjects.find((p) => p.projectKey === projectKey);
    if (project === undefined) return;
    const hit = nav.workspaces.find((w) => matchedProjectOf(w)?.projectKey === project.projectKey);
    if (hit !== undefined && hit.key !== nav.current?.key) nav.chooseWorkspace(hit.key);
  };
  const loopRequest = useAppState((s) => s.loop.request);
  const lastSyncedRequest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (loopRequest === undefined || loopRequest.n === lastSyncedRequest.current) return;
    const project = loopProjects.find((p) => p.projectKey === loopRequest.projectKey);
    const localWorkspaces = nav.workspaces.filter(
      (w) => locations.find((h) => h.id === w.locationId)?.kind === "local" && w.cwd !== "",
    );
    const hit =
      project === undefined
        ? undefined
        : localWorkspaces.find(
            (w) =>
              matchLoopProject(loopProjects, workspaceRepos[w.cwd])?.projectKey ===
              project.projectKey,
          );
    if (hit !== undefined) {
      lastSyncedRequest.current = loopRequest.n;
      if (hit.key !== nav.current?.key) nav.chooseWorkspace(hit.key);
      return;
    }
    const allReposSettled = localWorkspaces.every((w) => w.cwd in workspaceRepos);
    if (loopConnected !== undefined && allReposSettled) {
      lastSyncedRequest.current = loopRequest.n;
    }
  }, [loopRequest, loopProjects, loopConnected, nav, locations, workspaceRepos]);

  const close = () => setPanel("none");
  // Opens a panel, and counts that it was opened (which one, and whether by a key).
  const open = (next: Exclude<Panel, "none">, via: "click" | "shortcut" = "click") => {
    setPanel(next);
    store.track("panel_opened", { panel: PANEL_EVENT[next], via });
  };
  // Pins or unpins a session, from a row of the sidebar or the conversation's header, and counts it.
  const pin = (chosen: SessionSummary, on: boolean, where: "sidebar" | "header") => {
    pins.set(sessionKey(chosen), on);
    store.track("session_pinned", { pinned: on, where });
  };
  // The one way to the delete confirmation: it always says which session it deletes.
  const askDelete = (chosen: SessionSummary) => {
    setDeleting(chosen);
    setUnsaved(undefined);
    open("delete");
  };
  const locationIds = useMemo(() => new Set(locations.map((h) => h.id)), [locations]);
  const editingLocation = useMemo(() => {
    const found = locations.find((h) => h.id === targetLocation);
    return found !== undefined && found.kind === "remote" ? (found as RemoteLocation) : undefined;
  }, [locations, targetLocation]);
  const removingLocation = useMemo(() => {
    const found = locations.find((h) => h.id === targetLocation);
    return found !== undefined && found.kind !== "local" ? found : undefined;
  }, [locations, targetLocation]);
  /**
   * Opens a blank conversation: a new session that is made by its first message. It starts in the workspace that is
   * shown, else on the location that is open, else on the first that is connected.
   */
  const newSession = (via: "click" | "shortcut" = "click") => {
    places.closePage();
    // One is open already: it stays as it is, with what was chosen and written on it.
    if (blank !== undefined) return store.openBlank({ locationId: blank.locationId });
    const { startOn } = nav;
    const locationId =
      startOn?.locationId ??
      (connected ? selectedLocation : undefined) ??
      connectedLocations[0]?.id;
    if (locationId === undefined) return;
    store.track("panel_opened", { panel: "new_session", via });
    store.openBlank({
      locationId,
      cwd: startOn?.locationId === locationId ? startOn.cwd : undefined,
    });
  };

  const activity = view?.permissions.length
    ? "requires_action"
    : (view?.conversation.status ?? "idle");
  // The plan, above the input box, while some of it is still to do (DESIGN.md section 23).
  const plan = view !== undefined ? currentPlan(view.conversation) : undefined;
  const firstRequest = view?.permissions[0];
  const firstAllow = firstRequest?.options.find((o) => o.kind === "allow_once");

  useAppShortcuts({
    dialogOpen: panel !== "none",
    elsewhere: place.id !== "sessions",
    toggleSettings: () =>
      place.id === "settings" ? places.leavePage() : places.openSettings("shortcut"),
    search: () => open("search", "shortcut"),
    newSession: connectedLocations.length > 0 ? () => newSession("shortcut") : undefined,
    toggleSidebar: () => toggleSidebar("shortcut"),
    toggleSidePanel:
      panelKey !== undefined ? () => sessionPanel.toggleSidePanel("shortcut") : undefined,
    blankOpen: blank !== undefined,
    stop: connected && activity !== "idle" ? () => void store.cancel() : undefined,
    allow:
      connected && firstAllow !== undefined && firstRequest !== undefined
        ? () => void store.answerPermission(firstRequest.key, firstAllow.optionId)
        : undefined,
    walk: {
      order: nav.list.order,
      open: session,
      away: nav.away,
      select: (next) => void store.selectSession(next.locationId, next.sessionId),
    },
  });

  if (!ready)
    return (
      <div data-slot="starting">
        <StateBlock tone="loading" title={t("app.starting")} />
      </div>
    );

  const sidebarToggle = (
    <Tip
      label={t(sidebarCollapsed ? "sidebar.show" : "sidebar.hide")}
      shortcut="mod+b"
      side="bottom"
    >
      <Button
        data-variant="ghost"
        data-kind="sidebar-toggle"
        onClick={() => toggleSidebar("click")}
      >
        <SidebarIcon />
      </Button>
    </Tip>
  );

  const errorBanner =
    error !== undefined ? (
      <div data-slot="banner" data-severity="error" role="alert">
        <ErrorCircleIcon />
        <span>{errorText(error, t)}</span>
        <Button data-variant="ghost" onClick={store.dismissError}>
          {t("banner.dismiss")}
        </Button>
      </div>
    ) : null;

  const sidebarLabel = t(
    place.id === "loop"
      ? "loop.title"
      : place.id === "settings"
        ? "settings.title"
        : place.id === "connectors"
          ? "connectors.title"
          : "sessions.label",
  );
  // The way back from a page says where it goes.
  const backLabel = t(places.base === "loop" ? "settings.backToLoop" : "settings.back");
  const activeProjectTab: LoopProjectTab | undefined =
    place.id === "loop" && currentLoopProject !== undefined
      ? place.view.at === "project" && place.view.projectKey === currentLoopProject.projectKey
        ? place.view.tab
        : place.view.at === "ticket" && place.view.projectKey === currentLoopProject.projectKey
          ? "kanban"
          : undefined
      : undefined;

  // The sidebar shared by the sessions and the Loop: top global actions, then the current workspace with its Loop views and session list.
  const mainSidebar = (
    <>
      <SidebarActions
        locations={locations}
        status={status}
        onNewSession={() => newSession()}
        onSearch={() => open("search")}
        onConnectors={places.openConnectors}
        onLoop={places.openLoop}
        loopOverviewActive={place.id === "loop" && place.view.at === "overview"}
        loopNoticeCount={loopNoticeCount}
      />
      <SessionsNav
        locations={locations}
        status={status}
        workspaces={nav.workspaces}
        current={nav.current}
        elsewhere={nav.elsewhere}
        onChooseWorkspace={(key) => {
          nav.chooseWorkspace(key);
          if (place.id === "loop" && place.view.at !== "overview") {
            const ws = nav.workspaces.find((w) => w.key === key);
            const matched = matchedProjectOf(ws);
            if (matched !== undefined) {
              const nextTab: LoopProjectTab =
                place.view.at === "project" ? place.view.tab : "kanban";
              places.openLoopProject(matched.projectKey, nextTab, "sidebar");
            } else {
              places.leaveLoop();
            }
          }
        }}
        loopProject={currentLoopProject}
        loopAway={loopConnected === false}
        activeProjectTab={activeProjectTab}
        onOpenProjectTab={
          currentLoopProject !== undefined
            ? (tab) => places.openLoopProject(currentLoopProject.projectKey, tab, "sidebar")
            : undefined
        }
        list={nav.list}
        selected={place.id === "sessions" ? nav.openKey : undefined}
        away={nav.away}
        showArchived={nav.showArchived}
        pinned={pinned}
        onSelectSession={(chosen) => {
          setTimelineReturn(undefined);
          const alreadyOpen =
            blank === undefined &&
            chosen.locationId === selectedLocation &&
            chosen.sessionId === selectedSession;
          if (place.id !== "sessions") places.leaveLoop();
          if (!alreadyOpen) void store.selectSession(chosen.locationId, chosen.sessionId);
        }}
        onSessionAction={(chosen, action) => {
          switch (action) {
            case "pin":
            case "unpin":
              pin(chosen, action === "pin", "sidebar");
              return;
            case "archive":
            case "restore":
              void store.archiveSession(chosen.sessionId, action === "archive", chosen.locationId);
              return;
            case "delete":
              askDelete(chosen);
              return;
            default:
              action satisfies never;
          }
        }}
        onConnectLocation={(id) => void store.connectLocation(id)}
        onToggleArchived={() => nav.setShowArchived((v) => !v)}
        onShowAll={nav.showAllSessions}
        trust={trust.trusted}
        onTrust={(trusted) => {
          if (trusted) open("trust");
          else void trust.changeTrust(false);
        }}
      />
    </>
  );
  const { loopView } = places;

  return (
    <div data-slot="app" ref={appRef}>
      <AppShell
        layout={({ sidebar, main }) => (
          <SplitLayout
            controller={layout}
            panelOf={panelKey}
            onSidebarWidth={(width) =>
              appRef.current?.style.setProperty("--cycle-sidebar-width", `${width}px`)
            }
            panelHidden={place.id !== "sessions"}
            panel={
              panelKey !== undefined && sidePanel?.open === true
                ? {
                    content: (
                      <SidePanel
                        locationId={session?.locationId ?? ""}
                        sessionId={session?.sessionId ?? ""}
                        state={sidePanel}
                        onShow={sessionPanel.showTab}
                        onClose={sessionPanel.closeTab}
                      />
                    ),
                    onClose: () => sessionPanel.toggleSidePanel("handle"),
                  }
                : undefined
            }
            sidebar={sidebar}
            main={main}
          />
        )}
        sidebarLabel={sidebarLabel}
        sidebarCollapsed={sidebarCollapsed}
        toggle={sidebarToggle}
        sidebarActions={place.id === "sessions" || place.id === "loop" ? mainSidebar : null}
        sidebarNotices={<AppNotices />}
        topNotices={<AppNotices at="top" />}
        // The sessions say what failed in their own notices, with what is the matter with the open one.
        banner={place.id === "sessions" ? null : errorBanner}
        footer={<AccountMenu onSettings={() => places.openSettings()} />}
      >
        {/* Always here, under whatever else is shown: what was open and half-written is there on the way back. */}
        <Place id="sessions" active={place.id === "sessions"}>
          <ShellNotices>
            <SessionNotices
              locationId={selectedLocation}
              shows={blank !== undefined ? "blank" : view !== undefined ? "session" : "nothing"}
            />
            {blank === undefined ? <WorktreeSetupNotice worktree={session?.worktree} /> : null}
            {blank === undefined &&
            timelineReturn !== undefined &&
            session?.sessionId === timelineReturn.sessionId ? (
              <div data-slot="loop-timeline-return">
                <span>{t("loop.timeline.viewingLoopSession")}</span>
                <Button
                  data-variant="ghost"
                  onClick={() => {
                    const back = timelineReturn.projectKey;
                    setTimelineReturn(undefined);
                    places.openLoopProject(back, "timeline", "timeline");
                  }}
                >
                  {t("loop.timeline.backToTimeline")}
                </Button>
              </div>
            ) : null}
          </ShellNotices>
          {blank !== undefined ? (
            <BlankConversationView
              blank={blank}
              locations={connectedLocations}
              recent={nav.blankRecent}
              connected={connected}
              follow={sent}
              onSent={() => setSent((n) => n + 1)}
              onOpenHarnessSettings={places.openHarnessSettings}
            />
          ) : null}
          {blank === undefined && session !== undefined ? (
            <SessionHeader
              session={session}
              renaming={renaming === sessionKey(session)}
              onRenaming={(editing) => setRenaming(editing ? sessionKey(session) : undefined)}
              pinned={pinned.has(sessionKey(session))}
              onPin={(on) => pin(session, on, "header")}
              onSettings={() => open("settings")}
              onDelete={() => askDelete(session)}
              panel={sessionPanel}
            />
          ) : null}
          {blank !== undefined ? null : view !== undefined ? (
            <ConversationView
              key={viewKey(view.locationId, view.sessionId)}
              sessionKey={viewKey(view.locationId, view.sessionId)}
              follow={sent}
              conversation={view.conversation}
              loading={view.loading}
              awaitingApproval={activity === "requires_action"}
            />
          ) : (
            <NoSession
              locationId={selectedLocation}
              state={locationState}
              error={selectedLocation !== undefined ? status[selectedLocation]?.error : undefined}
              incompatible={
                selectedLocation !== undefined &&
                status[selectedLocation]?.incompatible !== undefined
              }
              onNewSession={connectedLocations.length > 0 ? () => newSession() : undefined}
            />
          )}
          <PendingRequest
            permissions={view?.permissions ?? []}
            conversation={conversation}
            connected={connected}
          />
          {view !== undefined ? (
            <Composer
              key={`composer:${viewKey(view.locationId, view.sessionId)}`}
              locationId={view.locationId}
              sessionId={view.sessionId}
              sessionKey={viewKey(view.locationId, view.sessionId)}
              canAttach={agent?.promptCapabilities?.image != null}
              canAttachFiles={agent?.promptCapabilities?.embeddedContext != null}
              settings={
                sessionSchema !== undefined && session !== undefined
                  ? { schema: sessionSchema, value: session.config ?? {}, live: true }
                  : undefined
              }
              onSetting={(key, value) => store.setSessionConfig(key, value)}
              canSteer={agent?.steer === true}
              enabled={!view.loading}
              connected={connected}
              activity={activity}
              plan={plan}
              context={context}
              planUsage={planUsage}
              onSent={() => setSent((n) => n + 1)}
            />
          ) : null}
        </Place>
        {/* Kept under a page opened from it, as the sessions are. */}
        {loopView !== undefined ? (
          <Place id="loop" active={place.id === "loop"}>
            <LoopMain
              view={loopView}
              onView={(next) => {
                if (next.at === "ticket" && loopView.at === "overview")
                  syncWorkspaceForProject(next.projectKey);
                places.showLoopView(next);
              }}
              onOpenProject={(projectKey, tab, from) => {
                syncWorkspaceForProject(projectKey);
                places.openLoopProject(projectKey, tab, from);
              }}
              onBack={places.loopBack}
              onClose={places.leaveLoop}
              onTimelineSessionOpened={(projectKey, sessionId) =>
                setTimelineReturn({ projectKey, sessionId })
              }
              active={place.id === "loop"}
            />
          </Place>
        ) : null}
        {place.id === "settings" ? (
          <Place id="settings" active>
            <SettingsPage
              section={place.section}
              onSection={places.showSection}
              harnessAgent={place.harness.agent}
              harnessFrom={place.harness.from}
              onHarnessAgent={places.showHarnessAgent}
              onClose={places.leavePage}
              backLabel={backLabel}
              locations={locations}
              status={status}
              agents={agentsByLocation}
              locationId={place.harness.location ?? selectedLocation}
              onAddLocation={() => {
                setTargetLocation(undefined);
                open("add-location");
              }}
              onEditLocation={(id) => {
                setTargetLocation(id);
                open("edit-location");
              }}
              onRemoveLocation={(id) => {
                setTargetLocation(id);
                open("remove-location");
              }}
            />
          </Place>
        ) : null}
        {place.id === "connectors" ? (
          <Place id="connectors" active>
            <ConnectorsPage
              section={place.section}
              onSection={places.showConnectorsSection}
              onClose={places.leavePage}
              backLabel={backLabel}
              locations={locations}
              status={status}
              locationId={selectedLocation}
              onShowLocations={() => places.openSettings("click", "locations")}
            />
          </Place>
        ) : null}
      </AppShell>

      <SearchDialog
        open={panel === "search"}
        onOpenChange={(open) => !open && close()}
        locations={locations}
        status={status}
        sessions={sessionsByLocation}
        agents={agentsByLocation}
        knownLoopSessionIds={knownLoopSessionIds}
        onPick={async (locationId, sessionId) => {
          // An archived session is not in the list unless archived ones are shown: show them, or the pick would select a hidden row.
          if (sessionsByLocation[locationId]?.find((s) => s.sessionId === sessionId)?.archived)
            nav.setShowArchived(true);
          // What was found is shown with its workspace, also when it is the session that is open.
          nav.followOpen();
          places.closePage();
          await store.selectSession(locationId, sessionId);
        }}
        onNewSession={() => {
          close();
          newSession();
        }}
      />
      {trust.folder !== undefined ? (
        <ConfirmDialog
          open={panel === "trust"}
          onOpenChange={(open) => !open && close()}
          title={t("trust.title")}
          description={t("trust.description", {
            location: locations.find((h) => h.id === trust.folder?.locationId)?.name ?? "",
          })}
          detail={trust.folder.cwd}
          confirmLabel={t("trust.confirm")}
          onConfirm={() => trust.changeTrust(true)}
        />
      ) : null}
      <LocationDialog
        open={panel === "add-location" || panel === "edit-location"}
        onOpenChange={(open) => !open && close()}
        editing={panel === "edit-location" ? editingLocation : undefined}
        existingIds={locationIds}
        onSave={store.saveLocation}
      />
      {removingLocation !== undefined ? (
        <ConfirmDialog
          open={panel === "remove-location"}
          onOpenChange={(open) => !open && close()}
          title={t("location.removeTitle", { name: removingLocation.name })}
          description={t("location.removeDescription", { name: removingLocation.name })}
          confirmLabel={t("location.removeConfirm")}
          destructive
          onConfirm={() => store.removeLocation(removingLocation.id)}
        />
      ) : null}
      {deleting !== undefined ? (
        <ConfirmDialog
          open={panel === "delete"}
          onOpenChange={(open) => !open && close()}
          title={t("session.deleteTitle")}
          description={
            unsaved === undefined
              ? t("session.deleteDescription")
              : t("session.deleteUnsaved", {
                  files: unsaved.files.length,
                  commits: unsaved.commits.length,
                })
          }
          {...(unsaved !== undefined
            ? { detail: [...unsaved.files.slice(0, 8), ...unsaved.commits.slice(0, 4)].join("\n") }
            : {})}
          confirmLabel={
            unsaved === undefined ? t("session.deleteConfirm") : t("session.deleteDiscard")
          }
          destructive
          onConfirm={async () => {
            const done = await store.deleteSession(
              deleting.sessionId,
              deleting.locationId,
              unsaved !== undefined,
            );
            if (typeof done === "object") {
              // Kept open: the same button now says what it will do.
              setUnsaved(done);
              return t("session.deleteUnsavedRefused");
            }
            if (done === undefined) pins.set(sessionKey(deleting), false);
            return done;
          }}
        />
      ) : null}
      {session !== undefined && panel === "settings" ? (
        <SessionSettings connected={connected} onClose={close} />
      ) : null}
      <ToastRegion side="bottom" align="center" />
    </div>
  );
}
