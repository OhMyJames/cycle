// The renderer's state, and what it does about events and clicks. Plain TypeScript, no React: React
// only reads it (useSyncExternalStore) and calls its methods, so it is tested with a fake bridge.
//
// `AppStore` is what the page holds. What it does is in its parts, each with its own file: the locations and their
// agents, the sessions, the blank conversation, terminals, connectors and plugins. Here are only what main tells (each
// event to the part it is about), the account, the app's own settings and updating, and the page's panes.
import type {
  AccountStatus,
  AppEvent,
  FolderListing,
  FolderTrust,
  ImageSaved,
  Preferences,
  SendVia,
} from "../api.ts";
import { MENTION_META, mentionText } from "../draft.ts";
import { sessionLabel, sessionUri } from "../mention.ts";
import { revealInDiff } from "../reveal.ts";
import { BlankSlice } from "./blank.ts";
import { ConnectorsSlice } from "./connectors.ts";
import { messageOf, StoreBase } from "./core.ts";
import { EnvironmentsSlice } from "./environments.ts";
import { LocationsSlice } from "./locations.ts";
import { LoopSlice } from "./loop.ts";
import { PluginsSlice } from "./plugins.ts";
import { ProvidersSlice } from "./providers.ts";
import { SessionsSlice } from "./sessions.ts";
import { BLANK_KEY, viewKey } from "./state.ts";
import { TerminalsSlice } from "./terminals.ts";
import { VaultSlice } from "./vault.ts";

export { blankEnvironmentOf, environmentDefaultOf } from "./environments.ts";
export * from "./state.ts";
export type { TerminalScreen } from "./terminals.ts";
export { type BlankWorktree, blankWorktreeOf } from "./worktrees.ts";

/** How long the Diff tab has to answer a request to show an edit before it lapses. */
const REVEAL_IN_DIFF_MS = 3_000;

/** Which view of its Diff tab each session shows (this session's edits, or the workspace), and who to tell of a change. */
export class DiffModes {
  readonly #modes = new Map<string, "session" | "workspace">();
  readonly #listeners = new Set<() => void>();
  get = (key: string): "session" | "workspace" | undefined => this.#modes.get(key);
  set = (key: string, mode: "session" | "workspace"): void => {
    if (this.#modes.get(key) === mode) return;
    this.#modes.set(key, mode);
    for (const listener of [...this.#listeners]) listener();
  };
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

export class AppStore extends StoreBase {
  #stop: (() => void) | undefined;
  /** Which view each session's Diff tab shows: kept while the window is open, so a tab looked away from finds it again. */
  readonly diffModes = new DiffModes();

  // The parts. Each is handed the kit; what one needs of another, it is handed too.
  readonly #sessions = new SessionsSlice(this.kit);
  readonly #environments = new EnvironmentsSlice(this.kit);
  readonly #blank = new BlankSlice(
    this.kit,
    (locationId, sessionId) => this.#sessions.select(locationId, sessionId),
    (locationId, cwd, environmentId) =>
      this.#environments.setDefault(locationId, cwd, environmentId),
  );
  readonly #locations = new LocationsSlice(this.kit, (locationId) =>
    this.#blank.agentsRead(locationId),
  );
  readonly #terminals = new TerminalsSlice(this.kit);
  readonly #connectors = new ConnectorsSlice(this.kit);
  readonly #loop = new LoopSlice(this.kit);
  readonly #vault = new VaultSlice(this.kit);
  readonly #providers = new ProvidersSlice(this.kit, (locationId) =>
    this.#locations.loadAgents(locationId),
  );
  readonly #plugins = new PluginsSlice(this.kit, this.#connectors);
  dismissError = (): void => this.set({ error: undefined });

  /** Starts listening to main and reads what it has. Call once. */
  async start(): Promise<void> {
    this.#stop = this.bridge.onEvent((event) => this.#onEvent(event));
    void this.attempt(async () => {
      const update = await this.bridge.updateState();
      // An event that came while this was asked is newer than the answer.
      this.set((s) => (s.update === undefined ? { update } : {}));
    });
    void this.attempt(async () => this.set({ analytics: await this.bridge.analytics() }));
    // Read before the page is ready: its first words are already in the language that was chosen.
    const preferences = this.bridge.preferences().then(
      (read) => this.set({ preferences: read }),
      () => undefined,
    );
    // The account first: signed out, the sign-in page is all there is, and the locations are read once it is open.
    const account = await this.bridge.account().catch(() => undefined);
    await preferences;
    this.set((s) => ({ account: s.account ?? account }));
    if (this.getState().account?.open === true)
      await Promise.all([this.#locations.load(), this.#environments.load()]);
    this.set({ ready: true });
  }

  stop(): void {
    this.#stop?.();
  }

  // ---- the account ----

  /** Opens the sign-in page in the browser; the page shows that it waits, and main says how it ended. */
  signIn = async (): Promise<void> => {
    await this.attempt(async () => this.#onAccount(await this.bridge.signIn()));
  };

  cancelSignIn = async (): Promise<void> => {
    await this.attempt(() => this.bridge.cancelSignIn());
  };

  /** After the person confirmed it. */
  signOut = async (): Promise<void> => {
    await this.attempt(() => this.bridge.signOut());
  };

  dismissSwitchNotice = (): void => this.set({ switchNoticeSeen: true });
  deferUpdate = (version: string): void => this.set({ updateDeferred: version });

  #onAccount(account: AccountStatus): void {
    const was = this.getState().account;
    this.set({
      account,
      // A new sign-in as someone else is told again.
      ...(account.switched === true && was?.switched !== true ? { switchNoticeSeen: false } : {}),
    });
    // Just opened (signed in from the sign-in page): what was not read while it was closed is read now.
    if (account.open && was?.open !== true && this.getState().ready) {
      void this.#locations.load();
      void this.#environments.load();
    }
  }

  // ---- what main tells us: each to the part it is about ----

  #onEvent(event: AppEvent): void {
    switch (event.type) {
      case "account":
        this.#onAccount(event.account);
        return;
      case "locations":
        this.set({ locations: event.locations });
        return;
      case "location-status":
        if (this.#locations.statusTold(event)) {
          void this.#terminals.relist(event.locationId);
          this.#blank.connected(event.locationId);
        }
        return;
      case "sessions":
        this.set((s) => ({ sessions: { ...s.sessions, [event.locationId]: event.sessions } }));
        return;
      case "agent-defaults":
        this.#locations.defaultsChanged(event.locationId);
        this.#blank.defaultsChanged(event.locationId);
        return;
      case "agent-setup-changed":
        this.#locations.setupChanged(event.locationId, event.agent);
        return;
      case "agent-auth-completed":
        this.#locations.authCompleted(event);
        return;
      case "plan-usage":
        this.#locations.planUsageTold(event);
        return;
      case "connectors":
        this.#connectors.changed(event.locationId);
        return;
      case "providers":
        this.#providers.changed(event.locationId);
        return;
      case "plugins":
        this.#plugins.changed(event.locationId, event.agentId);
        return;
      case "app-update":
        this.set({ update: event.state });
        return;
      case "focus-session":
        this.set((s) => ({ focusRequests: s.focusRequests + 1 }));
        void this.focusSession(event.locationId, event.sessionId);
        return;
      case "loop-runs":
        this.#loop.setRuns(event.runs);
        return;
      case "open-loop-ticket":
        this.#loop.requestTicket(event.projectKey, event.identifier);
        return;
      case "session-gone":
        this.#sessions.forget(event.locationId, event.sessionId);
        return;
      case "terminals":
      case "terminal-output":
      case "terminal-reset":
        this.#terminals.onEvent(event);
        return;
      case "update":
        if (this.#sessions.onEvent(event)) this.#locations.sessionUpdated(event);
        return;
      case "permission":
      case "permission-closed":
        this.#sessions.onEvent(event);
        return;
    }
  }

  // ---- locations and their agents ----

  connectLocation = this.#locations.connect;
  /** Reads the location's agents again, e.g. after credentials or binaries are fixed. */
  reloadAgents = this.#locations.loadAgents;
  saveLocation = this.#locations.save;
  removeLocation = this.#locations.remove;
  readAgentDefaults = this.#locations.readAgentDefaults;
  setAgentDefaults = this.#locations.setAgentDefaults;
  readAgentSetup = this.#locations.readAgentSetup;
  readStorage = this.#locations.readStorage;
  cleanStorage = this.#locations.cleanStorage;
  setAgentRuntimeSettings = this.#locations.setAgentRuntimeSettings;
  revealDaemonConfig = this.#locations.revealDaemonConfig;
  startAgentAuth = this.#locations.startAgentAuth;
  openAgentAuthUrl = this.#locations.openAgentAuthUrl;
  submitAgentAuth = this.#locations.submitAgentAuth;
  cancelAgentAuth = this.#locations.cancelAgentAuth;
  logoutAgent = this.#locations.logoutAgent;

  // ---- environments (docs/desktop.md "环境") ----

  loadEnvironments = this.#environments.load;
  saveEnvironment = this.#environments.save;
  removeEnvironment = this.#environments.remove;
  setEnvironmentDefault = this.#environments.setDefault;

  /** Runs an action of a session's environment in a new terminal of it, and shows that terminal. */
  runEnvironmentAction = (
    locationId: string,
    sessionId: string,
    actionId: string,
    size: { cols: number; rows: number },
  ): Promise<unknown> => this.#terminals.create(locationId, sessionId, size, "action", actionId);

  // ---- the blank conversation ----

  blankAgent = this.#blank.agentOf;
  openBlank = this.#blank.open;
  changeBlank = this.#blank.change;
  answerTrust = this.#blank.answerTrust;
  retryBlank = this.#blank.retry;
  chooseBlankEnvironment = this.#blank.chooseEnvironment;
  chooseBlankWorktree = this.#blank.chooseWorktree;

  /**
   * "Continue in a new session" (CYC-279): a new blank conversation in the same location, folder and agent, whose box
   * holds an @ mention of this session. Nothing is sent and no model is asked: the daemon expands the mention into a
   * record of what was said when the person sends it. Not while another blank is starting, and not for a session whose
   * daemon does not expand mentions. Returns whether the box was opened.
   */
  continueInNewSession = (locationId: string, sessionId: string, title: string): boolean => {
    const state = this.getState();
    const session = state.sessions[locationId]?.find((s) => s.sessionId === sessionId);
    if (session === undefined || state.blank?.starting !== undefined) return false;
    if (state.status[locationId]?.capabilities?.sessionMentions !== true) return false;
    this.#blank.open({ locationId, cwd: session.cwd });
    this.#blank.change({ agent: session.agent });
    // The folder is a worktree already: another one is not made inside it. Elsewhere the person's own default stands.
    if (session.worktree !== undefined) this.#blank.chooseWorktree({ on: false });
    const mention = { path: sessionLabel(title), kind: "session" as const };
    // Pressed twice, the box holds the one mention, not two.
    if (this.drafts.get(BLANK_KEY).mentions.some((m) => m.uri === sessionUri(sessionId)))
      return true;
    this.drafts.restore(BLANK_KEY, [
      [
        { type: "text", text: `${mentionText(mention)} ` },
        {
          type: "resource_link",
          name: title,
          uri: sessionUri(sessionId),
          _meta: { [MENTION_META]: mention.path },
        },
      ],
    ]);
    return true;
  };

  // ---- sessions ----

  focusSession = this.#sessions.focus;
  selectSession = this.#sessions.select;

  /**
   * Sends what the box in view holds: the blank conversation's first message, which makes its session, or a message of
   * the open session.
   */
  send = async (options: { steer?: boolean; via?: SendVia } = {}): Promise<void> => {
    const { blank } = this.getState();
    if (blank !== undefined) return this.#blank.send(blank);
    return this.#sessions.send(options);
  };

  resend = this.#sessions.resend;
  retry = this.#sessions.retry;
  searchFiles = this.#sessions.searchFiles;
  listFiles = this.#sessions.listFiles;
  readFile = this.#sessions.readFile;
  workspaceStatus = this.#sessions.workspaceStatus;
  workspaceFile = this.#sessions.workspaceFile;
  dequeue = this.#sessions.dequeue;
  cancel = this.#sessions.cancel;
  setSessionConfig = this.#sessions.setConfig;
  renameSession = this.#sessions.rename;
  dismissBackground = this.#sessions.dismissBackground;
  stopSubagent = this.#sessions.stopSubagent;
  archiveSession = this.#sessions.archive;
  markRead = this.#sessions.markRead;
  deleteSession = this.#sessions.delete;
  answerPermission = this.#sessions.answerPermission;
  answerForm = this.#sessions.answerForm;

  // ---- terminals (CYCL-98) ----

  loadTerminals = this.#terminals.load;
  createTerminal = this.#terminals.create;
  closeTerminal = this.#terminals.close;
  showTerminal = this.#terminals.show;
  attachTerminal = this.#terminals.attach;
  detachTerminal = this.#terminals.detach;
  terminalInput = this.#terminals.input;
  resizeTerminal = this.#terminals.resize;

  // ---- loop ----

  loadLoopProjects = this.#loop.loadProjects;
  loadLoopBoard = this.#loop.loadBoard;
  loadLoopRuns = this.#loop.loadRuns;
  loadLoopTicket = this.#loop.loadTicket;
  actOnLoopTicket = this.#loop.act;
  actOnLoopMany = this.#loop.actMany;
  chatAboutLoopTicket = this.#loop.chat;
  loadLoopNotices = this.#loop.loadNotices;
  takeLoopRequest = this.#loop.takeRequest;

  /** Shows the Dev session of a ticket (`[CYC-1] Dev`) in place of the Loop page; false when no session has that name. */
  joinLoopSession = (identifier: string, title?: string): boolean => {
    const wanted = title ?? `[${identifier}] Dev`;
    const sessions = Object.entries(this.getState().sessions).flatMap(([locationId, list]) =>
      list.filter((x) => !x.archived && x.title?.trim() === wanted).map((x) => ({ locationId, x })),
    );
    // One waiting on an answer first, else the first.
    const found = sessions.find((e) => e.x.state === "requires_action") ?? sessions[0];
    if (found === undefined) return false;
    this.set((s) => ({ focusRequests: s.focusRequests + 1 }));
    void this.focusSession(found.locationId, found.x.sessionId);
    this.track("loop_session_joined", {});
    return true;
  };

  // ---- connectors ----

  loadConnectors = this.#connectors.load;
  addConnector = this.#connectors.add;
  updateConnector = this.#connectors.update;
  removeConnector = this.#connectors.remove;
  authorizeConnector = this.#connectors.authorize;
  cancelConnectorAuth = this.#connectors.cancelAuth;
  signOutConnector = this.#connectors.signOut;

  // ---- model providers (docs/protocol.md §10) ----

  loadProviders = this.#providers.load;
  providerCatalog = this.#providers.catalog;
  saveProvider = this.#providers.save;
  removeProvider = this.#providers.remove;

  // ---- the vault (docs/protocol.md §6 "环境") ----

  loadVault = this.#vault.load;
  setVaultItem = this.#vault.set;
  removeVaultItem = this.#vault.remove;

  // ---- plugins (docs/protocol.md §15) ----

  loadPlugins = this.#plugins.load;
  availablePlugins = this.#plugins.available;
  installPlugin = this.#plugins.install;
  uninstallPlugin = this.#plugins.uninstall;
  updatePlugin = this.#plugins.update;
  setPluginEnabled = this.#plugins.setEnabled;
  addPluginSource = this.#plugins.addSource;
  removePluginSource = this.#plugins.removeSource;
  refreshPluginSources = this.#plugins.refreshSources;

  // ---- the panes beside the conversation ----

  /**
   * Shows a file (or, `folder`, a folder in the tree) of the open session in its Files tab, opening the panel. With
   * `line`, the file is shown at that line (to `end`, for a range), the file already shown too.
   */
  showInFiles = (
    path: string,
    options: { folder?: boolean; line?: number | undefined; end?: number | undefined } = {},
  ): void => {
    const { selectedLocation: locationId, selectedSession: sessionId } = this.getState();
    if (locationId === undefined || sessionId === undefined) return;
    const key = viewKey(locationId, sessionId);
    const { line, end } = options;
    if (options.folder === true) this.filesViews.reveal(key, path);
    else this.filesViews.show(key, path, line === undefined ? undefined : { line, end });
    this.sidePanels.show(key, "files");
  };

  /**
   * The edit a call made, in the Diff tab (CYCL-133): the panel opens on Diff, in this session's view (the one that has
   * the call's edits), and the edit opens in its list.
   */
  showInDiff = (toolId: string): boolean => {
    const { selectedLocation: locationId, selectedSession: sessionId } = this.getState();
    if (locationId === undefined || sessionId === undefined) return false;
    const key = viewKey(locationId, sessionId);
    this.diffModes.set(key, "session");
    this.sidePanels.show(key, "diff");
    const serial = revealInDiff.request(key, toolId);
    // Not answered soon (the list still loading, the person gone to another session): given up, so the row does not
    // open by itself, and take the focus, when the tab is opened later.
    setTimeout(() => revealInDiff.done(serial), REVEAL_IN_DIFF_MS);
    return true;
  };

  // ---- folders on a location's machine ----

  /** The folders in a folder on a location's machine. Not a banner when it fails: the one who asked says why. */
  listFolders = (locationId: string, path?: string, hidden?: boolean): Promise<FolderListing> =>
    this.bridge.listFolders(locationId, path, hidden);

  /** Whether a folder on a location's machine may run its own configuration's commands. The caller says why it failed. */
  readTrust = (locationId: string, path: string): Promise<FolderTrust> =>
    this.bridge.readTrust(locationId, path);

  setTrust = (locationId: string, path: string, trusted: boolean): Promise<FolderTrust> =>
    this.bridge.setTrust(locationId, path, trusted);

  /** Changes a folder's trust from a menu: a failure is shown, with its reason. */
  changeTrust = async (locationId: string, path: string, trusted: boolean): Promise<void> => {
    try {
      await this.bridge.setTrust(locationId, path, trusted);
    } catch (error) {
      this.set({ error: { key: "trust.changeFailed", params: { reason: messageOf(error) } } });
    }
  };

  chooseDirectory = (): Promise<string | undefined> => this.bridge.chooseDirectory();

  // ---- the app itself ----

  checkForUpdate = async (): Promise<void> => {
    await this.attempt(async () => this.set({ update: await this.bridge.checkForUpdate() }));
  };

  /** The person's answer about usage statistics. */
  setAnalytics = async (enabled: boolean): Promise<void> => {
    await this.attempt(async () =>
      this.set({ analytics: await this.bridge.setAnalytics(enabled) }),
    );
  };

  /** Changes how the app looks or reads. Main keeps it and applies it; what it answers is what holds. */
  setPreferences = async (change: Partial<Preferences>): Promise<void> => {
    await this.attempt(async () =>
      this.set({ preferences: await this.bridge.setPreferences(change) }),
    );
  };

  /** Puts text on the clipboard, through main. Whether it did: never an error where it is used. */
  copyText = (text: string): Promise<boolean> =>
    this.bridge.copyText(text).then(
      (done) => done,
      () => false,
    );

  /** Puts a picture on the clipboard, through main (a PNG or JPEG, as base64). Whether it did. */
  copyImage = (type: string, data: string): Promise<boolean> =>
    this.bridge.copyImage(type, data).then(
      (done) => done,
      () => false,
    );

  /** Saves a picture where the person picks, through main's save dialog. What came of it: never an error. */
  saveImage = (name: string, type: string, data: string): Promise<ImageSaved> =>
    this.bridge.saveImage(name, type, data).then(
      (saved) => saved,
      (): ImageSaved => "failed",
    );

  /** How it goes comes back in the location's status. */
  upgradeDaemon = async (locationId: string, when?: "now" | "later"): Promise<void> => {
    await this.attempt(() => this.bridge.upgradeDaemon(locationId, when));
  };

  /** Main says how it goes through app-update events; an error it throws is shown as any other. */
  installUpdate = async (): Promise<void> => {
    await this.attempt(() => this.bridge.installUpdate());
  };
}
