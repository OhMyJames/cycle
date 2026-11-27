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
import { usePages } from "./app-pages.ts";
import { useAppShortcuts } from "./app-shortcuts.ts";
import { BlankConversationView } from "./blank.tsx";
import { Composer } from "./composer.tsx";
import { mergeConfigSchema } from "./config-form.tsx";
import { ConnectorsPage } from "./connectors.tsx";
import { ConversationView } from "./conversation.tsx";
import { ConfirmDialog, LocationDialog, type RemoteLocation } from "./dialogs.tsx";
import { I18nProvider, useI18n } from "./i18n.tsx";
import { ErrorCircleIcon, SidebarIcon } from "./icons.tsx";
import { LoopMain, LoopNav } from "./loop.tsx";
import { errorText, SessionNotices } from "./notice-line.tsx";
import { currentPlan } from "./plan.tsx";
import { SearchDialog } from "./search.tsx";
import { SessionHeader } from "./session-header.tsx";
import { SessionSettings } from "./session-settings.tsx";
import { SettingsPage } from "./settings.tsx";
import { SidePanel } from "./side-panel.tsx";
import { Sidebar } from "./sidebar.tsx";
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

  const pages = usePages(appRef);
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
  });
  const trust = useWorkspaceTrust(nav.current, status, panel !== "none");
  useMarkRead(session, status, pages.loop === undefined);

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
    pages.closePage();
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
    pageOpen: pages.pageOpen,
    loopOpen: pages.loop !== undefined,
    toggleSettings: () =>
      pages.settings === undefined ? pages.openSettings("shortcut") : pages.leaveSettings(),
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

  // Under the title bar of what is shown: what is the matter with it. The pages over it say their errors themselves.
  const notices = (
    <>
      {/* With the sidebar put away, what concerns the whole app comes first under the title bar. */}
      {sidebarCollapsed && pages.loop === undefined ? <AppNotices at="top" /> : null}
      <SessionNotices
        locationId={selectedLocation}
        shows={blank !== undefined ? "blank" : view !== undefined ? "session" : "nothing"}
        errors={!pages.pageOpen && pages.loop === undefined}
      />
    </>
  );

  return (
    <div data-slot="app" ref={appRef}>
      {pages.settings !== undefined ? (
        <SettingsPage
          section={pages.settings}
          onSection={pages.showSection}
          harnessAgent={pages.harnessAgent}
          harnessFrom={pages.harnessFrom}
          onHarnessAgent={pages.showHarnessAgent}
          onClose={pages.leaveSettings}
          banner={errorBanner}
          locations={locations}
          status={status}
          agents={agentsByLocation}
          locationId={pages.harnessLocation ?? selectedLocation}
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
      ) : null}
      {pages.connectors !== undefined ? (
        <ConnectorsPage
          section={pages.connectors}
          onSection={pages.showConnectorsSection}
          onClose={pages.leaveConnectors}
          banner={errorBanner}
          locations={locations}
          status={status}
          locationId={selectedLocation}
          onShowLocations={() => pages.openSettings("click", "locations")}
        />
      ) : null}
      {/* Under a page the sessions are kept as they are, not drawn again: what was open and half-written is there on the way back. */}
      <div data-slot="app-body" hidden={pages.pageOpen} inert={pages.pageOpen}>
        <SplitLayout
          controller={layout}
          panelOf={panelKey}
          onSidebarWidth={(width) =>
            appRef.current?.style.setProperty("--cycle-sidebar-width", `${width}px`)
          }
          panelHidden={pages.loop !== undefined}
          panel={
            panelKey !== undefined && sidePanel?.open === true
              ? {
                  content: (
                    <SidePanel
                      locationId={session?.locationId ?? ""}
                      sessionId={session?.sessionId ?? ""}
                      state={sidePanel}
                      onShow={sessionPanel.showTab}
                    />
                  ),
                  onClose: () => sessionPanel.toggleSidePanel("handle"),
                }
              : undefined
          }
          sidebar={
            <Sidebar
              toggle={sidebarCollapsed ? undefined : sidebarToggle}
              locations={locations}
              status={status}
              workspaces={nav.workspaces}
              current={nav.current}
              elsewhere={nav.elsewhere}
              onChooseWorkspace={nav.chooseWorkspace}
              list={nav.list}
              selected={nav.openKey}
              away={nav.away}
              showArchived={nav.showArchived}
              pinned={pinned}
              onSelectSession={(chosen) =>
                void store.selectSession(chosen.locationId, chosen.sessionId)
              }
              onSessionAction={(chosen, action) => {
                switch (action) {
                  case "pin":
                  case "unpin":
                    pin(chosen, action === "pin", "sidebar");
                    return;
                  case "archive":
                  case "restore":
                    void store.archiveSession(
                      chosen.sessionId,
                      action === "archive",
                      chosen.locationId,
                    );
                    return;
                  case "delete":
                    askDelete(chosen);
                    return;
                  default:
                    action satisfies never;
                }
              }}
              onNewSession={() => newSession()}
              onSearch={() => open("search")}
              onConnectors={pages.openConnectors}
              onLoop={pages.openLoop}
              onSessions={() => {
                if (pages.loop === undefined) return;
                store.track("sessions_mode_shown", {});
                pages.leaveLoop();
              }}
              mode={pages.loop !== undefined ? "loop" : "sessions"}
              loopNav={
                pages.loop !== undefined ? (
                  <LoopNav view={pages.loop} onView={pages.showLoopView} />
                ) : undefined
              }
              onConnectLocation={(id) => void store.connectLocation(id)}
              onToggleArchived={() => nav.setShowArchived((v) => !v)}
              onShowAll={nav.showAllSessions}
              trust={trust.trusted}
              onTrust={(trusted) => {
                if (trusted) open("trust");
                else void trust.changeTrust(false);
              }}
              notices={sidebarCollapsed ? null : <AppNotices />}
            >
              <AccountMenu onSettings={() => pages.openSettings()} />
            </Sidebar>
          }
          main={
            <main data-slot="main">
              {pages.loop !== undefined ? (
                <LoopMain
                  view={pages.loop}
                  onView={pages.showLoopView}
                  onBack={pages.loopBack}
                  onClose={pages.leaveLoop}
                  banner={
                    <>
                      {sidebarCollapsed ? <AppNotices at="top" /> : null}
                      {errorBanner}
                    </>
                  }
                  sidebarToggle={sidebarCollapsed ? sidebarToggle : undefined}
                  active={!pages.pageOpen}
                />
              ) : null}
              {/* Under the Loop the sessions are kept as they are, not drawn again: scroll and what was half-written stay. */}
              <div
                data-slot="session-body"
                hidden={pages.loop !== undefined}
                inert={pages.loop !== undefined}
              >
                {blank !== undefined ? (
                  <BlankConversationView
                    blank={blank}
                    notices={notices}
                    locations={connectedLocations}
                    recent={nav.blankRecent}
                    connected={connected}
                    follow={sent}
                    sidebarToggle={sidebarCollapsed ? sidebarToggle : undefined}
                    onSent={() => setSent((n) => n + 1)}
                    onOpenHarnessSettings={pages.openHarnessSettings}
                  />
                ) : null}
                {blank === undefined && session !== undefined ? (
                  <SessionHeader
                    session={session}
                    sidebarToggle={sidebarCollapsed ? sidebarToggle : null}
                    renaming={renaming === sessionKey(session)}
                    onRenaming={(editing) => setRenaming(editing ? sessionKey(session) : undefined)}
                    pinned={pinned.has(sessionKey(session))}
                    onPin={(on) => pin(session, on, "header")}
                    onSettings={() => open("settings")}
                    onDelete={() => askDelete(session)}
                    panel={sessionPanel}
                  />
                ) : null}
                {blank === undefined && session === undefined && sidebarCollapsed ? (
                  <header data-slot="session-header" data-empty-header="">
                    {sidebarToggle}
                  </header>
                ) : null}
                {/* Under whichever title bar is drawn; the blank page draws its own, with these under it. */}
                {blank === undefined ? notices : null}
                {blank === undefined ? <WorktreeSetupNotice worktree={session?.worktree} /> : null}
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
                    error={
                      selectedLocation !== undefined ? status[selectedLocation]?.error : undefined
                    }
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
              </div>
            </main>
          }
        />
      </div>

      <SearchDialog
        open={panel === "search"}
        onOpenChange={(open) => !open && close()}
        locations={locations}
        status={status}
        sessions={sessionsByLocation}
        agents={agentsByLocation}
        onPick={async (locationId, sessionId) => {
          // An archived session is not in the list unless archived ones are shown: show them, or the pick would select a hidden row.
          if (sessionsByLocation[locationId]?.find((s) => s.sessionId === sessionId)?.archived)
            nav.setShowArchived(true);
          // What was found is shown with its workspace, also when it is the session that is open.
          nav.followOpen();
          pages.closePage();
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
