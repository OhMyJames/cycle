import { Button } from "@ui-sdk/react/button";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AccountStatus, SessionSummary } from "../api.ts";
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
import { ConfirmDialog, EnvironmentDialog, type RemoteEnvironment } from "./dialogs.tsx";
import { I18nProvider, useI18n } from "./i18n.tsx";
import { ErrorCircleIcon, SidebarIcon } from "./icons.tsx";
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

/** What the sign-in page shows when main has not said how the account stands (it could not be asked). */
const SIGNED_OUT: AccountStatus = { state: "signed-out", open: false, signingIn: false };

/** The dialogs the window opens over what it shows, one at a time. */
type Panel =
  | "none"
  | "add-environment"
  | "edit-environment"
  | "remove-environment"
  | "delete"
  | "settings"
  | "search"
  | "trust";

/** The word each panel has in the dictionary of events (@cycle/analytics). */
const PANEL_EVENT = {
  search: "search",
  "add-environment": "add_environment",
  "edit-environment": "edit_environment",
  "remove-environment": "remove_environment",
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
  // its shortcuts or effects runs, and nothing of the environments has been read.
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
  const environments = useAppState((s) => s.environments);
  const status = useAppState((s) => s.status);
  const selectedEnvironment = useAppState((s) => s.selectedEnvironment);
  const selectedSession = useAppState((s) => s.selectedSession);
  const sessionsByEnvironment = useAppState((s) => s.sessions);
  const agentsByEnvironment = useAppState((s) => s.agents);
  const views = useAppState((s) => s.views);
  const blank = useAppState((s) => s.blank);
  const error = useAppState((s) => s.error);
  const [panel, setPanel] = useState<Panel>("none");
  // The session Delete asks about: the open one from its header, or any from its row in the sidebar.
  const [deleting, setDeleting] = useState<SessionSummary | undefined>(undefined);
  const pinned = useSyncExternalStore(pins.subscribe, pins.all, pins.all);
  // The open session whose title is being edited in the header, by its key.
  const [renaming, setRenaming] = useState<string | undefined>();
  const [sent, setSent] = useState(0);
  const [targetEnvironment, setTargetEnvironment] = useState<string | undefined>(undefined);
  const appRef = useRef<HTMLDivElement>(null);

  // The sessions of every environment, in one list; what is open is on the environment `selectedEnvironment` names.
  const sessions = useMemo(
    () => environments.flatMap((h) => sessionsByEnvironment[h.id] ?? []),
    [environments, sessionsByEnvironment],
  );
  const agents =
    selectedEnvironment !== undefined ? (agentsByEnvironment[selectedEnvironment] ?? []) : [];
  const session = sessions.find(
    (s) => s.environmentId === selectedEnvironment && s.sessionId === selectedSession,
  );
  const agent = agents.find((a) => a.id === session?.agent);
  const connectedEnvironments = environments.filter((h) => status[h.id]?.state === "connected");
  const view =
    selectedEnvironment !== undefined && selectedSession !== undefined
      ? views[viewKey(selectedEnvironment, selectedSession)]
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
  // The account's limits, as the session's agent last told them on this environment.
  const planUsage = useAppState((s) =>
    selectedEnvironment !== undefined && session !== undefined
      ? s.planUsage[selectedEnvironment]?.[session.agent]
      : undefined,
  );
  const environmentState =
    selectedEnvironment !== undefined ? status[selectedEnvironment]?.state : undefined;
  const connected = environmentState === "connected";

  const pages = usePages(appRef);
  const { layout, sidebarCollapsed, toggleSidebar } = useSidebarFold(appRef, ready);
  const sessionPanel = useSessionPanel(session, blank);
  const { panelKey, sidePanel } = sessionPanel;
  const nav = useSessionNavigation({
    environments,
    status,
    sessions,
    session,
    blank,
    pinned,
  });
  const trust = useWorkspaceTrust(nav.current, status, panel !== "none");
  useMarkRead(session, status);

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
    open("delete");
  };
  const environmentIds = useMemo(() => new Set(environments.map((h) => h.id)), [environments]);
  const editingEnvironment = useMemo(() => {
    const found = environments.find((h) => h.id === targetEnvironment);
    return found !== undefined && found.kind === "remote"
      ? (found as RemoteEnvironment)
      : undefined;
  }, [environments, targetEnvironment]);
  const removingEnvironment = useMemo(() => {
    const found = environments.find((h) => h.id === targetEnvironment);
    return found !== undefined && found.kind !== "local" ? found : undefined;
  }, [environments, targetEnvironment]);
  /**
   * Opens a blank conversation: a new session that is made by its first message. It starts in the workspace that is
   * shown, else on the environment that is open, else on the first that is connected.
   */
  const newSession = (via: "click" | "shortcut" = "click") => {
    pages.closePage();
    // One is open already: it stays as it is, with what was chosen and written on it.
    if (blank !== undefined) return store.openBlank({ environmentId: blank.environmentId });
    const { startOn } = nav;
    const environmentId =
      startOn?.environmentId ??
      (connected ? selectedEnvironment : undefined) ??
      connectedEnvironments[0]?.id;
    if (environmentId === undefined) return;
    store.track("panel_opened", { panel: "new_session", via });
    store.openBlank({
      environmentId,
      cwd: startOn?.environmentId === environmentId ? startOn.cwd : undefined,
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
    toggleSettings: () =>
      pages.settings === undefined ? pages.openSettings("shortcut") : pages.leaveSettings(),
    search: () => open("search", "shortcut"),
    newSession: connectedEnvironments.length > 0 ? () => newSession("shortcut") : undefined,
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
      select: (next) => void store.selectSession(next.environmentId, next.sessionId),
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
      {sidebarCollapsed ? <AppNotices at="top" /> : null}
      <SessionNotices
        environmentId={selectedEnvironment}
        shows={blank !== undefined ? "blank" : view !== undefined ? "session" : "nothing"}
        errors={!pages.pageOpen}
      />
    </>
  );

  return (
    <div data-slot="app" ref={appRef}>
      {pages.settings !== undefined ? (
        <SettingsPage
          section={pages.settings}
          onSection={pages.showSection}
          onClose={pages.leaveSettings}
          banner={errorBanner}
          environments={environments}
          status={status}
          agents={agentsByEnvironment}
          environmentId={selectedEnvironment}
          onAddEnvironment={() => {
            setTargetEnvironment(undefined);
            open("add-environment");
          }}
          onEditEnvironment={(id) => {
            setTargetEnvironment(id);
            open("edit-environment");
          }}
          onRemoveEnvironment={(id) => {
            setTargetEnvironment(id);
            open("remove-environment");
          }}
        />
      ) : null}
      {pages.connectors !== undefined ? (
        <ConnectorsPage
          section={pages.connectors}
          onSection={pages.showConnectorsSection}
          onClose={pages.leaveConnectors}
          banner={errorBanner}
          environments={environments}
          status={status}
          environmentId={selectedEnvironment}
          onShowEnvironments={() => pages.openSettings("click", "environments")}
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
          panel={
            panelKey !== undefined && sidePanel?.open === true
              ? {
                  content: (
                    <SidePanel
                      environmentId={session?.environmentId ?? ""}
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
              environments={environments}
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
                void store.selectSession(chosen.environmentId, chosen.sessionId)
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
                      chosen.environmentId,
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
              onConnectEnvironment={(id) => void store.connectEnvironment(id)}
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
              {blank !== undefined ? (
                <BlankConversationView
                  blank={blank}
                  notices={notices}
                  environments={connectedEnvironments}
                  recent={nav.blankRecent}
                  connected={connected}
                  follow={sent}
                  sidebarToggle={sidebarCollapsed ? sidebarToggle : undefined}
                  onSent={() => setSent((n) => n + 1)}
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
              {blank !== undefined ? null : view !== undefined ? (
                <ConversationView
                  key={viewKey(view.environmentId, view.sessionId)}
                  sessionKey={viewKey(view.environmentId, view.sessionId)}
                  follow={sent}
                  conversation={view.conversation}
                  loading={view.loading}
                  awaitingApproval={activity === "requires_action"}
                />
              ) : (
                <NoSession
                  environmentId={selectedEnvironment}
                  state={environmentState}
                  error={
                    selectedEnvironment !== undefined
                      ? status[selectedEnvironment]?.error
                      : undefined
                  }
                  incompatible={
                    selectedEnvironment !== undefined &&
                    status[selectedEnvironment]?.incompatible !== undefined
                  }
                  onNewSession={connectedEnvironments.length > 0 ? () => newSession() : undefined}
                />
              )}
              <PendingRequest
                permissions={view?.permissions ?? []}
                conversation={conversation}
                connected={connected}
              />
              {view !== undefined ? (
                <Composer
                  key={`composer:${viewKey(view.environmentId, view.sessionId)}`}
                  environmentId={view.environmentId}
                  sessionKey={viewKey(view.environmentId, view.sessionId)}
                  canAttach={agent?.promptCapabilities?.image != null}
                  canAttachFiles={agent?.promptCapabilities?.embeddedContext != null}
                  settings={
                    sessionSchema !== undefined && session !== undefined
                      ? { schema: sessionSchema, value: session.config ?? {} }
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
            </main>
          }
        />
      </div>

      <SearchDialog
        open={panel === "search"}
        onOpenChange={(open) => !open && close()}
        environments={environments}
        status={status}
        sessions={sessionsByEnvironment}
        agents={agentsByEnvironment}
        onPick={async (environmentId, sessionId) => {
          // An archived session is not in the list unless archived ones are shown: show them, or the pick would select a hidden row.
          if (
            sessionsByEnvironment[environmentId]?.find((s) => s.sessionId === sessionId)?.archived
          )
            nav.setShowArchived(true);
          // What was found is shown with its workspace, also when it is the session that is open.
          nav.followOpen();
          pages.closePage();
          await store.selectSession(environmentId, sessionId);
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
            environment: environments.find((h) => h.id === trust.folder?.environmentId)?.name ?? "",
          })}
          detail={trust.folder.cwd}
          confirmLabel={t("trust.confirm")}
          onConfirm={() => trust.changeTrust(true)}
        />
      ) : null}
      <EnvironmentDialog
        open={panel === "add-environment" || panel === "edit-environment"}
        onOpenChange={(open) => !open && close()}
        editing={panel === "edit-environment" ? editingEnvironment : undefined}
        existingIds={environmentIds}
        onSave={store.saveEnvironment}
      />
      {removingEnvironment !== undefined ? (
        <ConfirmDialog
          open={panel === "remove-environment"}
          onOpenChange={(open) => !open && close()}
          title={t("environment.removeTitle", { name: removingEnvironment.name })}
          description={t("environment.removeDescription", { name: removingEnvironment.name })}
          confirmLabel={t("environment.removeConfirm")}
          destructive
          onConfirm={() => store.removeEnvironment(removingEnvironment.id)}
        />
      ) : null}
      {deleting !== undefined ? (
        <ConfirmDialog
          open={panel === "delete"}
          onOpenChange={(open) => !open && close()}
          title={t("session.deleteTitle")}
          description={t("session.deleteDescription")}
          confirmLabel={t("session.deleteConfirm")}
          destructive
          onConfirm={async () => {
            const failed = await store.deleteSession(deleting.sessionId, deleting.environmentId);
            if (failed === undefined) pins.set(sessionKey(deleting), false);
            return failed;
          }}
        />
      ) : null}
      {session !== undefined && panel === "settings" ? (
        <SessionSettings connected={connected} onClose={close} />
      ) : null}
    </div>
  );
}
