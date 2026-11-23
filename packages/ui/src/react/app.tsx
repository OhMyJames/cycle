import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import { createResizableController } from "@ui-sdk/react/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DISPLAY_MODES, displayMode, isDisplayMode } from "../display-mode.ts";
import { SOURCE_LOCALE } from "../i18n.ts";
import { resolveLanguage, translatorFor } from "../languages.ts";
import { contextOf } from "../model/conversation.ts";
import {
  currentWorkspace,
  elsewhere as elsewhereOf,
  sessionKey,
  sessionList,
  workspacesOf,
} from "../sessions.ts";
import type { PanelTabId, PanelTabKind } from "../side-panel.ts";
import { BLANK_KEY, viewKey } from "../store/index.ts";
import { tabKind, terminalOfTab } from "../terminals.ts";
import { AnalyticsNotice } from "./analytics.tsx";
import { BlankConversationView } from "./blank.tsx";
import { Composer, composerInput } from "./composer.tsx";
import { ConfigForm, mergeConfigSchema, OptionLabel, propertiesOf } from "./config-form.tsx";
import { ConnectorsDialog } from "./connectors.tsx";
import { ConversationView } from "./conversation.tsx";
import { ConfirmDialog, EnvironmentDialog, type RemoteEnvironment } from "./dialogs.tsx";
import { FormCard } from "./form.tsx";
import { I18nProvider, useI18n } from "./i18n.tsx";
import {
  DiffIcon,
  ErrorCircleIcon,
  FolderIcon,
  MoreIcon,
  OverviewIcon,
  PanelIcon,
  SidebarIcon,
  TerminalIcon,
  WarningIcon,
} from "./icons.tsx";
import { useDay, useInFront } from "./in-front.ts";
import { PermissionCard } from "./permission.tsx";
import { currentPlan } from "./plan.tsx";
import { SessionHeading } from "./rename-field.tsx";
import { SearchDialog } from "./search.tsx";
import type { Away } from "./session-list.tsx";
import { SettingsPage, type SettingsSection } from "./settings.tsx";
import { FIRST_SIZE, SidePanel, terminalToShow } from "./side-panel.tsx";
import { MOD, Sidebar, sessionTitle } from "./sidebar.tsx";
import { SplitLayout } from "./split-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { ENVIRONMENT_STATE } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { useDisplayMode } from "./thought.tsx";
import { Tip } from "./tip.tsx";
import { DaemonBanner, UpdateBanner, UpdateFooter } from "./update.tsx";

/**
 * What is drawn over a page and takes its keys first: a dialog, a menu, the choices of a select. Not every listbox: the
 * sidebar's list of sessions is one too.
 */
const OVER_THE_PAGE =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="select-content"]';

type Panel =
  | "none"
  | "add-environment"
  | "edit-environment"
  | "remove-environment"
  | "delete"
  | "settings"
  | "search"
  | "trust"
  | "connectors";

/** The word each panel has in the dictionary of events (@cycle/analytics). */
const PANEL_EVENT = {
  search: "search",
  "add-environment": "add_environment",
  "edit-environment": "edit_environment",
  "remove-environment": "remove_environment",
  settings: "session_settings",
  delete: "delete",
  trust: "trust",
  connectors: "connectors",
} as const;

/**
 * A session's settings: the agent's (model, mode, effort…), which reach it through the daemon and so only while its
 * environment is connected, and how the session is shown here, which is always there.
 */
function SessionSettings({ connected, onClose }: { connected: boolean; onClose: () => void }) {
  const store = useAppStore();
  const { t } = useI18n();
  const environment = useAppState((s) => s.selectedEnvironment);
  const sessionId = useAppState((s) => s.selectedSession);
  const sessions = useAppState((s) =>
    environment !== undefined ? s.sessions[environment] : undefined,
  );
  const agents = useAppState((s) =>
    environment !== undefined ? s.agents[environment] : undefined,
  );
  const session = sessions?.find((x) => x.sessionId === sessionId);
  const agent = agents?.find((a) => a.id === session?.agent);
  const liveConfigOptions = useAppState((s) =>
    environment !== undefined && sessionId !== undefined
      ? s.views[viewKey(environment, sessionId)]?.conversation.configOptions
      : undefined,
  );
  const schema = useMemo(
    () =>
      agent === undefined ? undefined : mergeConfigSchema(agent.configSchema, liveConfigOptions),
    [agent, liveConfigOptions],
  );
  if (session === undefined || environment === undefined) return null;
  const agentSettings = schema !== undefined && propertiesOf(schema).length > 0;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>{t("session.settings")}</DialogTitle>
        {/* What it says is of the agent's settings: when they are not here, why. */}
        {!agentSettings ? null : connected ? (
          <DialogDescription>{t("session.settingsDescription")}</DialogDescription>
        ) : (
          <DialogDescription>{t("session.settingsOffline")}</DialogDescription>
        )}
        {connected && agentSettings ? (
          <ConfigForm
            schema={schema ?? {}}
            value={session.config ?? {}}
            defaults={false}
            onChange={(next) => {
              // One setting at a time: the form hands back the whole set, and only what changed is sent.
              const before = session.config ?? {};
              for (const [key, value] of Object.entries(next)) {
                if (before[key] !== value) void store.setSessionConfig(key, value);
              }
            }}
          />
        ) : null}
        <DisplayModeField sessionKey={viewKey(environment, session.sessionId)} />
        <div data-slot="row" data-dialog-footer="">
          <DialogClose>{t("dialog.close")}</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A session's display mode, with its agent settings: normal leaves the agent's thinking out of the conversation, detailed
 * shows it. Kept on this machine and not sent to the agent (display-mode.ts), so it is drawn here, not from the agent's
 * schema, and applies at once.
 */
function DisplayModeField({ sessionKey }: { sessionKey: string }) {
  const store = useAppStore();
  const { t } = useI18n();
  const mode = useDisplayMode(sessionKey);
  const options = DISPLAY_MODES.map((value) => ({
    value,
    label: t(`session.display.${value}`),
    description: t(`session.display.${value}.description`),
  }));
  return (
    <div data-slot="config-form">
      <Field name="display">
        <FieldLabel>{t("session.display")}</FieldLabel>
        <Select
          items={options.map((o) => ({ value: o.value, label: o.label }))}
          value={mode}
          onValueChange={(next) => {
            if (!isDisplayMode(next) || next === mode) return;
            displayMode.set(sessionKey, next);
            store.track("display_mode_changed", { mode: next });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} label={o.label}>
                <OptionLabel option={o} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{t("session.display.description")}</FieldDescription>
      </Field>
    </div>
  );
}

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
  return (
    <I18nProvider translator={translatorFor(language)}>
      <AppWindow />
    </I18nProvider>
  );
}

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
  // The open session whose title is being edited in the header, by its key.
  const [renaming, setRenaming] = useState<string | undefined>();
  const [showArchived, setShowArchived] = useState(false);
  const [sent, setSent] = useState(0);
  const [showAll, setShowAll] = useState(false);
  // The workspace chosen in the switcher holds until something else is opened: it is only good for the open session it was chosen on.
  const [chosen, setChosen] = useState<{ workspace: string; on: string | undefined } | undefined>(
    undefined,
  );

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
  // The settings page, when it is what the window shows (CYCL-78): the sessions stay as they are under it.
  const [settings, setSettings] = useState<SettingsSection | undefined>(undefined);
  const lastSection = useRef<SettingsSection>("general");
  const [targetEnvironment, setTargetEnvironment] = useState<string | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);
  const connectedEnvironments = environments.filter((h) => status[h.id]?.state === "connected");
  // An environment that is not connected: its sessions are the last it gave, and are shown greyed.
  const away = useMemo(() => {
    const map = new Map<string, Away>();
    for (const h of environments) {
      const state = status[h.id]?.state ?? "closed";
      if (state !== "connected")
        map.set(h.id, { name: h.name, word: t(ENVIRONMENT_STATE[state].word) });
    }
    return map;
  }, [environments, status, t]);
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
  const environmentError =
    selectedEnvironment !== undefined ? status[selectedEnvironment]?.error : undefined;
  const environmentIncompatible =
    selectedEnvironment !== undefined ? status[selectedEnvironment]?.incompatible : undefined;
  const close = () => setPanel("none");
  // Opens a panel, and counts that it was opened (which one, and whether by a key).
  const open = (next: Exclude<Panel, "none">, via: "click" | "shortcut" = "click") => {
    setPanel(next);
    store.track("panel_opened", { panel: PANEL_EVENT[next], via });
  };
  const openSettings = (via: "click" | "shortcut" = "click") => {
    setSettings(lastSection.current);
    store.track("panel_opened", { panel: "settings", via });
  };
  const closeSettings = () => setSettings(undefined);
  // Left by the person (Escape, Back, the shortcut): the keyboard goes back to the button that opened the page. Left
  // for something else (a new session, a found one, a notification's), the keyboard is that thing's.
  const returnFocus = useRef(false);
  const leaveSettings = () => {
    returnFocus.current = true;
    setSettings(undefined);
  };
  const showSection = (section: SettingsSection) => {
    if (section === settings) return;
    lastSection.current = section;
    setSettings(section);
    store.track("settings_section_shown", { section });
  };
  const [layout] = useState(createResizableController);
  // The right panel is the open session's (CYCL-90): a blank conversation or no session has none.
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
  const overviewShown = sidePanel?.open === true && sidePanel.active === "overview";
  const filesShown = sidePanel?.open === true && sidePanel.active === "files";
  const diffShown = sidePanel?.open === true && sidePanel.active === "diff";
  // The session's terminals (CYCL-98), once its daemon can open them: the Terminal button shows one, or opens one.
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
  const toggleTerminal = () => {
    if (panelKey === undefined || sidePanel === undefined || session === undefined) return;
    if (terminalShown) {
      sidePanels.setOpen(panelKey, false);
      store.track("side_panel_toggled", { open: false, via: "tab_button", tab: "terminal" });
      return;
    }
    const tab = terminalToShow(sidePanel, sessionTerminals ?? []);
    if (tab === undefined) {
      void store.createTerminal(session.environmentId, session.sessionId, FIRST_SIZE, "header");
      return;
    }
    const wasOpen = sidePanel.open;
    sidePanels.show(panelKey, tab);
    if (wasOpen) store.track("side_panel_tab_shown", { tab: "terminal" });
    else store.track("side_panel_toggled", { open: true, via: "tab_button", tab: "terminal" });
  };
  // Files needs a daemon that reads a session's folder (docs/protocol.md §8): an older one is not offered it.
  const canShowFiles = useAppState((s) =>
    session !== undefined ? s.status[session.environmentId]?.capabilities?.fs === true : false,
  );
  // The workspaces, and the one the sidebar shows; the list on screen and the keys that walk it (Cmd+[ and Cmd+]) are one thing.
  const environmentLabels = useMemo(
    () => environments.map((h) => ({ id: h.id, name: h.name, local: h.kind === "local" })),
    [environments],
  );
  const awayEnvironments = useMemo(() => new Set(away.keys()), [away]);
  const workspaces = useMemo(
    () =>
      workspacesOf(sessions, {
        environments: environmentLabels,
        away: awayEnvironments,
        showArchived,
      }),
    [sessions, environmentLabels, awayEnvironments, showArchived],
  );
  // A blank conversation is open in place of a session: the sidebar shows its folder, if it has sessions there.
  const openKey =
    session !== undefined ? sessionKey(session) : blank !== undefined ? BLANK_KEY : undefined;
  // The folders a blank conversation offers: those its environment has sessions in that are not archived, newest first,
  // named among themselves only (one environment: no environment's name after them), whatever the sidebar shows.
  const blankEnvironment = blank?.environmentId;
  const blankRecent = useMemo(
    () =>
      blankEnvironment === undefined
        ? []
        : workspacesOf(sessions.filter((s) => s.environmentId === blankEnvironment))
            .filter((w) => w.cwd !== "")
            .slice(0, 8)
            .map((w) => ({ cwd: w.cwd, name: w.name })),
    [sessions, blankEnvironment],
  );
  const current = currentWorkspace(workspaces, {
    chosen: chosen !== undefined && chosen.on === openKey ? chosen.workspace : undefined,
    open: session ?? blank,
  });
  const [shownWorkspace, setShownWorkspace] = useState(current?.key);
  if (shownWorkspace !== current?.key) {
    setShownWorkspace(current?.key);
    if (showAll) setShowAll(false);
  }
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
  // A new session starts in the workspace that is shown, if its environment can have one started.
  const startOn =
    current !== undefined && connectedEnvironments.some((h) => h.id === current.environmentId)
      ? current
      : undefined;
  const elsewhere = useMemo(() => elsewhereOf(workspaces, current), [workspaces, current]);
  /**
   * Opens a blank conversation: a new session that is made by its first message. It starts in the workspace that is
   * shown, else on the environment that is open, else on the first that is connected.
   */
  const newSession = (via: "click" | "shortcut" = "click") => {
    closeSettings();
    // One is open already: it stays as it is, with what was chosen and written on it.
    if (blank !== undefined) return store.openBlank({ environmentId: blank.environmentId });
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
  // Whether the shown workspace's folder is trusted, when its daemon can say. Read again as a dialog closes: it may have been decided there.
  const trustEnvironment =
    current !== undefined &&
    status[current.environmentId]?.state === "connected" &&
    status[current.environmentId]?.capabilities?.trust === true
      ? current.environmentId
      : undefined;
  const trustCwd = trustEnvironment !== undefined ? current?.cwd : undefined;
  const [trust, setTrust] = useState<{ key: string; trusted: boolean | null } | undefined>();
  const [trustRevision, setTrustRevision] = useState(0);
  const trustKey =
    trustEnvironment !== undefined && trustCwd !== undefined
      ? `${trustEnvironment}\u0000${trustCwd}\u0000${trustRevision}\u0000${panel === "none"}`
      : undefined;
  useEffect(() => {
    if (trustKey === undefined || trustEnvironment === undefined || trustCwd === undefined) return;
    let live = true;
    store.readTrust(trustEnvironment, trustCwd).then(
      (read) => {
        if (live) setTrust({ key: trustKey, trusted: read.trusted });
      },
      // Not offered when it cannot be read (the folder is gone): there is nothing to decide on.
      () => {
        if (live) setTrust(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [store, trustKey, trustEnvironment, trustCwd]);
  const shownTrust = trust !== undefined && trust.key === trustKey ? trust.trusted : undefined;
  const day = useDay();
  const list = useMemo(
    () =>
      sessionList(current?.sessions ?? [], {
        showAll,
        selected: openKey,
        away: awayEnvironments,
        now: new Date(day),
      }),
    [current, showAll, openKey, awayEnvironments, day],
  );

  // What is on screen has been seen: the daemon is told, so the mark goes and stays gone (also on another client).
  // Only while the app is in front, and only for a daemon that says there is news.
  const inFront = useInFront();
  // Once for what the list says (the session, how far it goes, and whether the app is in front): a daemon that refuses it
  // would otherwise be asked again for each new list, and each ask lists again.
  const told = useRef("");
  useEffect(() => {
    if (session?.unread !== true || !inFront) return;
    if (status[session.environmentId]?.state !== "connected") return;
    const what = `${session.environmentId}/${session.sessionId}/${session.lastSeq}`;
    if (told.current === what) return;
    told.current = what;
    void store.markRead(session.environmentId, session.sessionId);
  }, [session, inFront, status, store]);
  // Leaving the app and coming back asks again.
  useEffect(() => {
    if (!inFront) told.current = "";
  }, [inFront]);

  const activity = view?.permissions.length
    ? "requires_action"
    : (view?.conversation.status ?? "idle");
  // The plan, above the input box, while some of it is still to do (DESIGN.md section 23).
  const plan = view !== undefined ? currentPlan(view.conversation) : undefined;
  const firstAllow = view?.permissions[0]?.options.find((o) => o.kind === "allow_once");

  // The sidebar slides only when it is folded or opened on purpose (`data-animate` on the split, for that one slide): a
  // drag, or a window being resized, moves it at once. Taken off when the slide ends, or at once if nothing moved.
  const endSlide = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => endSlide.current?.(), []);
  const toggleSidebar = useCallback(
    (via: "click" | "shortcut") => {
      const wasCollapsed = layout.isCollapsed("sidebar") || sidebarCollapsed;
      const split = appRef.current?.querySelector<HTMLElement>('[data-slot="split"]');
      endSlide.current?.();
      split?.setAttribute("data-animate", "");
      const moved = wasCollapsed ? layout.expand("sidebar") : layout.collapse("sidebar");
      if (split != null) {
        const done = () => {
          split.removeAttribute("data-animate");
          split.removeEventListener("transitionend", onEnd);
          window.clearTimeout(fallback);
          endSlide.current = undefined;
        };
        const onEnd = (event: TransitionEvent) => {
          if ((event.target as HTMLElement).id === "sidebar" && event.propertyName === "flex-basis")
            done();
        };
        // No transitionend when nothing moved, or with reduced motion: the attribute goes anyway.
        const fallback = window.setTimeout(done, moved ? 400 : 0);
        split.addEventListener("transitionend", onEnd);
        endSlide.current = done;
      }
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
    [layout, sidebarCollapsed, store],
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
  }, [ready]);

  // Keyboard (DESIGN.md §5.4). One handler bound once via ref, so every shortcut stays in one place.
  const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (event: KeyboardEvent) => {
    // ⌘ on a Mac (Ctrl+B and Ctrl+N are cursor keys in a text field there); Ctrl elsewhere.
    const isMac = MOD === "⌘";
    if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || panel !== "none") return;
    const key = event.key;
    const run = (action: () => void) => {
      event.preventDefault();
      action();
    };
    if (key === ",") {
      // What is open over the page (a confirmation, a list of choices) is answered first.
      if (document.querySelector(OVER_THE_PAGE) !== null) return;
      run(() => (settings === undefined ? openSettings("shortcut") : leaveSettings()));
    }
    // The settings page is over the sessions: only what leaves it (a search, a new session) is taken.
    else if (settings !== undefined && key !== "k" && key !== "n") return;
    else if (key === "k") run(() => open("search", "shortcut"));
    else if (key === "n" && connectedEnvironments.length > 0) run(() => newSession("shortcut"));
    else if (key === "b") run(() => toggleSidebar("shortcut"));
    else if (key === "\\" && panelKey !== undefined) run(() => toggleSidePanel("shortcut"));
    else if (key === "l") run(() => composerInput()?.focus());
    else if (
      key === "o" &&
      blank !== undefined &&
      document.querySelector('[role="dialog"], [role="alertdialog"]') === null
    )
      // The blank page's folder menu: what its button does when pressed.
      run(() =>
        document
          .querySelector<HTMLButtonElement>('[data-kind="blank-folder"]:not(:disabled)')
          ?.click(),
      );
    else if (key === "." && connected && activity !== "idle") run(() => void store.cancel());
    else if (
      key === "Enter" &&
      connected &&
      firstAllow !== undefined &&
      view?.permissions[0] !== undefined
    ) {
      const request = view.permissions[0];
      run(() => void store.answerPermission(request.key, firstAllow.optionId));
    } else if (key === "[" || key === "]") {
      const at = session === undefined ? -1 : list.order.indexOf(session);
      // A row on an environment that is away and was never opened cannot be opened: the walk goes past it.
      const step = key === "]" ? 1 : -1;
      // The open session is not in the workspace that is shown: the walk starts at the end it is going from.
      let to = at === -1 ? (step === 1 ? 0 : list.order.length - 1) : at + step;
      while (list.order[to] !== undefined && away.has(list.order[to]?.environmentId ?? ""))
        to += step;
      const next = list.order[to];
      if (next !== undefined)
        run(() => void store.selectSession(next.environmentId, next.sessionId));
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onKeyRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A notification was pressed: its session is what the person asked for, also when it is the one already open.
  const focusRequests = useAppState((s) => s.focusRequests);
  const [shownRequests, setShownRequests] = useState(focusRequests);
  if (shownRequests !== focusRequests) {
    setShownRequests(focusRequests);
    if (settings !== undefined) setSettings(undefined);
  }
  const settingsOpen = settings !== undefined;
  useEffect(() => {
    if (settingsOpen || !returnFocus.current) return;
    returnFocus.current = false;
    appRef.current?.querySelector<HTMLElement>('[data-kind="settings-open"]')?.focus();
  }, [settingsOpen]);

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
        <span>{typeof error === "string" ? error : t(error.key, error.params)}</span>
        <Button data-variant="ghost" onClick={store.dismissError}>
          {t("banner.dismiss")}
        </Button>
      </div>
    ) : null;

  return (
    <div data-slot="app" ref={appRef}>
      {settings !== undefined ? (
        <SettingsPage
          section={settings}
          onSection={showSection}
          onClose={leaveSettings}
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
      {/* Under the settings page the sessions are kept as they are, not drawn again: what was open and half-written is there on the way back. */}
      <div data-slot="app-body" hidden={settingsOpen} inert={settingsOpen}>
        <SplitLayout
          controller={layout}
          panel={
            panelKey !== undefined && sidePanel?.open === true
              ? {
                  content: (
                    <SidePanel
                      environmentId={session?.environmentId ?? ""}
                      sessionId={session?.sessionId ?? ""}
                      state={sidePanel}
                      onShow={(tab: PanelTabId) => {
                        sidePanels.show(panelKey, tab);
                        store.track("side_panel_tab_shown", { tab: tabKind(tab) });
                      }}
                    />
                  ),
                  onClose: () => toggleSidePanel("handle"),
                }
              : undefined
          }
          sidebar={
            <Sidebar
              toggle={sidebarCollapsed ? undefined : sidebarToggle}
              environments={environments}
              status={status}
              workspaces={workspaces}
              current={current}
              elsewhere={elsewhere}
              onChooseWorkspace={(workspace) => setChosen({ workspace, on: openKey })}
              list={list}
              selected={openKey}
              away={away}
              showArchived={showArchived}
              onSelectSession={(chosen) =>
                void store.selectSession(chosen.environmentId, chosen.sessionId)
              }
              onNewSession={() => newSession()}
              onSearch={() => open("search")}
              onConnectors={() => open("connectors")}
              onConnectEnvironment={(id) => void store.connectEnvironment(id)}
              onToggleArchived={() => setShowArchived((v) => !v)}
              onShowAll={() => setShowAll(true)}
              trust={shownTrust}
              onTrust={(trusted) => {
                if (trusted) open("trust");
                else if (trustEnvironment !== undefined && trustCwd !== undefined)
                  void store
                    .changeTrust(trustEnvironment, trustCwd, false)
                    .then(() => setTrustRevision((n) => n + 1));
              }}
            >
              <UpdateFooter onSettings={() => openSettings()} />
            </Sidebar>
          }
          main={
            <main data-slot="main">
              <UpdateBanner />
              <AnalyticsNotice />
              {settingsOpen ? null : errorBanner}
              {environmentState === "reconnecting" && environmentIncompatible === undefined ? (
                <div data-slot="banner" data-severity="warning" role="status">
                  <WarningIcon />
                  <span>{t("environment.reconnectingBanner")}</span>
                </div>
              ) : null}
              {view !== undefined &&
              environmentState !== undefined &&
              environmentState !== "connected" &&
              environmentState !== "reconnecting" ? (
                <div data-slot="banner" data-severity="warning" role="status">
                  <WarningIcon />
                  <span>
                    {t("session.awayBanner", {
                      environment:
                        environments.find((h) => h.id === selectedEnvironment)?.name ??
                        selectedEnvironment ??
                        "",
                    })}
                  </span>
                </div>
              ) : null}
              {(blank !== undefined || session === undefined) &&
              selectedEnvironment !== undefined ? (
                <DaemonBanner environmentId={selectedEnvironment} />
              ) : null}
              {blank !== undefined ? (
                <BlankConversationView
                  blank={blank}
                  environments={connectedEnvironments}
                  recent={blankRecent}
                  connected={connected}
                  follow={sent}
                  sidebarToggle={sidebarCollapsed ? sidebarToggle : undefined}
                  onSent={() => setSent((n) => n + 1)}
                />
              ) : null}
              {blank === undefined && session !== undefined ? (
                <header data-slot="session-header">
                  {sidebarCollapsed ? sidebarToggle : null}
                  <SessionHeading
                    key={sessionKey(session)}
                    session={session}
                    title={sessionTitle(session)}
                    editing={renaming === sessionKey(session)}
                    onEditingChange={(editing) =>
                      setRenaming(editing ? sessionKey(session) : undefined)
                    }
                  />
                  <div data-slot="row">
                    <Menu
                      onAction={(value) => {
                        if (value === "rename") setRenaming(sessionKey(session));
                        else if (value === "dismiss-background")
                          void store.dismissBackground(session);
                        else if (value === "settings") open("settings");
                        else if (value === "archive")
                          void store.archiveSession(session.sessionId, !session.archived);
                        else if (value === "delete") open("delete");
                      }}
                    >
                      <Tip label={t("session.actions")} side="bottom">
                        <MenuTrigger data-variant="ghost">
                          <MoreIcon />
                        </MenuTrigger>
                      </Tip>
                      <MenuContent>
                        {session.unknownBackground?.length ? (
                          <MenuItem value="dismiss-background">
                            {t("session.dismissBackground", {
                              count: session.unknownBackground.length,
                            })}
                          </MenuItem>
                        ) : null}
                        <MenuItem value="rename">{t("session.rename")}</MenuItem>
                        <MenuItem value="settings">{t("session.settings")}</MenuItem>
                        <MenuItem value="archive">
                          {t(session.archived ? "session.restore" : "session.archive")}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem value="delete" data-destructive>
                          {t("session.delete")}
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                    <Tip label={t(overviewShown ? "overview.hide" : "overview.show")} side="bottom">
                      <Button
                        data-variant="ghost"
                        data-kind="panel-toggle"
                        data-active={overviewShown || undefined}
                        onClick={() => toggleTab("overview")}
                      >
                        <OverviewIcon />
                      </Button>
                    </Tip>
                    {canShowFiles ? (
                      <Tip label={t(filesShown ? "files.hide" : "files.show")} side="bottom">
                        <Button
                          data-variant="ghost"
                          data-kind="panel-toggle"
                          data-active={filesShown || undefined}
                          onClick={() => toggleTab("files")}
                        >
                          <FolderIcon />
                        </Button>
                      </Tip>
                    ) : null}
                    {/* Diff needs no daemon: this session's edits are in its conversation. */}
                    <Tip label={t(diffShown ? "diff.hide" : "diff.show")} side="bottom">
                      <Button
                        data-variant="ghost"
                        data-kind="panel-toggle"
                        data-active={diffShown || undefined}
                        onClick={() => toggleTab("diff")}
                      >
                        <DiffIcon />
                      </Button>
                    </Tip>
                    {canOpenTerminals ? (
                      <Tip
                        label={t(terminalShown ? "terminal.hide" : "terminal.show")}
                        side="bottom"
                      >
                        <Button
                          data-variant="ghost"
                          data-kind="panel-toggle"
                          data-active={terminalShown || undefined}
                          disabled={!terminalsConnected && (sessionTerminals ?? []).length === 0}
                          onClick={toggleTerminal}
                        >
                          <TerminalIcon />
                        </Button>
                      </Tip>
                    ) : null}
                    <Tip
                      label={t(sidePanel?.open === true ? "panel.hide" : "panel.show")}
                      shortcut="mod+\\"
                      side="bottom"
                    >
                      <Button
                        data-variant="ghost"
                        data-kind="panel-toggle"
                        onClick={() => toggleSidePanel("click")}
                      >
                        <PanelIcon />
                      </Button>
                    </Tip>
                  </div>
                </header>
              ) : null}
              {blank === undefined && session !== undefined ? (
                <DaemonBanner environmentId={session.environmentId} />
              ) : null}
              {blank === undefined && session === undefined && sidebarCollapsed ? (
                <header data-slot="session-header" data-empty-header="">
                  {sidebarToggle}
                </header>
              ) : null}
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
                <div data-slot="empty">
                  {environmentState === "connected" ? (
                    <StateBlock
                      tone="empty"
                      title={t("empty.chooseOrStart")}
                      action={
                        connectedEnvironments.length > 0
                          ? { label: t("empty.startSession"), onAction: () => newSession() }
                          : undefined
                      }
                    />
                  ) : environmentState === "connecting" || environmentState === "reconnecting" ? (
                    <StateBlock tone="loading" title={t("environment.connecting")} />
                  ) : (
                    <StateBlock
                      tone="error"
                      title={t("environment.notConnected")}
                      reason={environmentError}
                      action={
                        selectedEnvironment !== undefined
                          ? {
                              label: t("environment.connectAgain"),
                              onAction: () => void store.connectEnvironment(selectedEnvironment),
                            }
                          : undefined
                      }
                    />
                  )}
                </div>
              )}
              <div data-slot="permissions">
                {(view?.permissions ?? []).map((request) =>
                  request.form !== undefined ? (
                    <FormCard
                      key={request.key}
                      request={{ ...request, form: request.form }}
                      disabled={!connected}
                      onAnswer={store.answerForm}
                    />
                  ) : (
                    <PermissionCard
                      key={request.key}
                      request={request}
                      disabled={!connected}
                      onAnswer={store.answerPermission}
                    />
                  ),
                )}
              </div>
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
        onPick={async (environmentId, sessionId) => {
          // An archived session is not in the list unless archived ones are shown: show them, or the pick would select a hidden row.
          if (
            sessionsByEnvironment[environmentId]?.find((s) => s.sessionId === sessionId)?.archived
          )
            setShowArchived(true);
          // What was found is shown with its workspace, also when it is the session that is open.
          setChosen(undefined);
          closeSettings();
          await store.selectSession(environmentId, sessionId);
        }}
        onNewSession={() => {
          close();
          newSession();
        }}
      />
      {trustEnvironment !== undefined && trustCwd !== undefined ? (
        <ConfirmDialog
          open={panel === "trust"}
          onOpenChange={(open) => !open && close()}
          title={t("trust.title")}
          description={t("trust.description", {
            environment: environments.find((h) => h.id === trustEnvironment)?.name ?? "",
          })}
          detail={trustCwd}
          confirmLabel={t("trust.confirm")}
          onConfirm={() =>
            store
              .changeTrust(trustEnvironment, trustCwd, true)
              .then(() => setTrustRevision((n) => n + 1))
          }
        />
      ) : null}
      <ConnectorsDialog
        open={panel === "connectors"}
        onOpenChange={(open) => !open && close()}
        environments={environments}
        status={status}
        environmentId={selectedEnvironment}
      />
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
      {session !== undefined ? (
        <>
          <ConfirmDialog
            open={panel === "delete"}
            onOpenChange={(open) => !open && close()}
            title={t("session.deleteTitle")}
            description={t("session.deleteDescription")}
            confirmLabel={t("session.deleteConfirm")}
            destructive
            onConfirm={() => store.deleteSession(session.sessionId)}
          />
          {panel === "settings" ? <SessionSettings connected={connected} onClose={close} /> : null}
        </>
      ) : null}
    </div>
  );
}
