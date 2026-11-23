// The renderer's state, and what it does about events and clicks. Plain TypeScript, no React: React
// only reads it (useSyncExternalStore) and calls its methods, so it is tested with a fake bridge.
import type { EventProps, UiEventName } from "@cycle/analytics/events";
import type {
  AgentInfo,
  AnalyticsStatus,
  AppEvent,
  ConnectorAnswer,
  ConnectorChange,
  ConnectorDraft,
  ConnectorInfo,
  ConnectorProblem,
  CycleBridge,
  EnvironmentConfig,
  EnvironmentStatus,
  FileContent,
  FileListing,
  FileSearch,
  FolderListing,
  FolderTrust,
  FormAnswer,
  PermissionRequest,
  PlanUsage,
  Preferences,
  PreferencesState,
  PromptBlock,
  SendVia,
  SessionSnapshot,
  SessionSummary,
  TerminalAttached,
  UpdateState,
  WorkspacePatch,
  WorkspaceStatus,
} from "../api.ts";
import { againBlocks, DraftStore, promptBlocks, returnedId } from "../draft.ts";
import { FilesViews } from "../files-view.ts";
import type { Params } from "../i18n.ts";
import type { MessageKey } from "../messages/en-US.ts";
import {
  applyUpdate,
  type Conversation,
  emptyConversation,
  type Resend,
  type Returned,
} from "../model/index.ts";
import { SidePanelStore } from "../side-panel.ts";
import { mergeTerminals, type TerminalTab, terminalCount, terminalTab } from "../terminals.ts";

export const viewKey = (environmentId: string, sessionId: string): string =>
  `${environmentId}:${sessionId}`;

/**
 * The folder of the open session, when the Files tab can show it (its daemon reads a session's folder): what a place the
 * conversation names must be inside to be shown there (CYCL-92). Undefined otherwise. For `useAppState`, so that a link
 * appears once the daemon has said what it can do.
 */
export const filesRootOf = (state: AppState): string | undefined => {
  const { selectedEnvironment: environmentId, selectedSession: sessionId } = state;
  if (environmentId === undefined || sessionId === undefined) return undefined;
  if (state.status[environmentId]?.capabilities?.fs !== true) return undefined;
  return state.sessions[environmentId]?.find((s) => s.sessionId === sessionId)?.cwd;
};

/**
 * The key of what the blank conversation's box holds. One for every blank conversation, whatever environment it is on:
 * what was written stays when the environment or folder is changed, and when the person goes away and comes back.
 */
export const BLANK_KEY = "blank";

/** How long a blank conversation was open before its first message, in four words: only that is reported. */
const waitedOf = (ms: number): EventProps<"blank_sent">["waited"] =>
  ms < 10_000 ? "under_10s" : ms < 60_000 ? "under_1m" : ms < 300_000 ? "under_5m" : "longer";

/**
 * A new session before its first message: only here, in the client. The daemon hears of it when that message is sent
 * (`session/new`, then `session/prompt`), and only then is it in the list (docs/protocol.md §6).
 */
export type BlankConversation = {
  environmentId: string;
  /** Where the agent will work, on the environment's machine. Empty until it is chosen. */
  cwd: string;
  /** The agent chosen; undefined: the first that is available on the environment. */
  agent: string | undefined;
  /** What the session starts with: the agent's defaults, then what was chosen here. Undefined until they are read. */
  config: Record<string, string> | undefined;
  /** The settings the person chose here: they stay over the agent's defaults when those are read again. */
  chosen?: Record<string, string>;
  /** The agent's defaults could not be read: it does not start from a form that may not be what the person set. */
  unreadable?: true;
  /** The first message, on its way: the session is being made. Nothing here can change meanwhile. */
  starting?: PromptBlock[];
  /**
   * The folder (its real path) nobody has decided whether to trust: asked when the first message is sent, before the
   * session is made (docs/protocol.md §8 "信任文件夹"). `failed`: why the answer could not be kept.
   */
  asking?: { path: string; failed?: string };
  /**
   * Whether its folder is trusted, read when the folder is chosen, so that the page can say before the first message
   * that it will be asked (`undecided`). Undefined while it is read, or when the daemon cannot say.
   */
  trust?: "trusted" | "untrusted" | "undecided";
};

export type SessionView = {
  environmentId: string;
  sessionId: string;
  conversation: Conversation;
  permissions: PermissionRequest[];
  /** The version of main's state this view is at. The next event is this plus one. */
  version: number;
  loading: boolean;
};

export type AppState = {
  ready: boolean;
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  sessions: Record<string, SessionSummary[]>;
  agents: Record<string, AgentInfo[]>;
  /** Counts changes to an agent's defaults, so a form that shows them knows to read them again. */
  defaultsRevision: Record<string, number>;
  /**
   * Each environment's connectors as last read, or why they could not be. Only for an environment the panel has asked
   * about; a change there (here or elsewhere) reads them again.
   */
  connectors: Record<string, { list?: ConnectorInfo[]; error?: string }>;
  /** Each environment's plan usage, by agent: the latest its daemon heard (docs/protocol.md §8 "套餐用量"). */
  planUsage: Record<string, Record<string, PlanUsage>>;
  selectedEnvironment: string | undefined;
  selectedSession: string | undefined;
  /** The blank conversation that is open, in place of a session: `selectedSession` is undefined while it is. */
  blank: BlankConversation | undefined;
  views: Record<string, SessionView>;
  /** The last thing that went wrong, for the user to read and dismiss. */
  /** What failed: the system's words as they came, or a message of the catalog with its parameters. */
  error: string | { key: MessageKey; params?: Params } | undefined;
  /** The app's own updating. Undefined until main has said. */
  update: UpdateState | undefined;
  /** Whether the app reports how it is used (docs/analytics.md). Undefined until main has said. */
  analytics: AnalyticsStatus | undefined;
  /** How the app looks and reads, as the person chose (main keeps it). Undefined until main has said. */
  preferences: PreferencesState | undefined;
  /**
   * Each session's terminals (by `viewKey`), as its daemon last listed them, and those that ended while the connection
   * was away. Only for a session whose terminals were asked for: a panel that showed none asks nothing.
   */
  terminals: Record<string, TerminalTab[]>;
  /** Counts the times a notification was pressed: its session is shown, over whatever page is open. */
  focusRequests: number;
  /** Counts the times something asked for the input box to take the focus (a message put back to send again). */
  composerFocus: number;
};

/** Each agent's plan usage, the newer of the two where both have one: an answer can come after a change it predates. */
const newerPlanUsage = (
  known: Record<string, PlanUsage> | undefined,
  told: Record<string, PlanUsage>,
): Record<string, PlanUsage> => {
  const next = { ...known };
  for (const [agent, usage] of Object.entries(told)) {
    const was = next[agent];
    if (was === undefined || was.at <= usage.at) next[agent] = usage;
  }
  return next;
};

const initial = (): AppState => ({
  ready: false,
  environments: [],
  status: {},
  sessions: {},
  agents: {},
  defaultsRevision: {},
  connectors: {},
  planUsage: {},
  selectedEnvironment: undefined,
  selectedSession: undefined,
  blank: undefined,
  views: {},
  terminals: {},
  error: undefined,
  update: undefined,
  analytics: undefined,
  preferences: undefined,
  focusRequests: 0,
  composerFocus: 0,
});

const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  // Electron wraps what main throws: "Error invoking remote method 'x': Error: the real message".
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
};

/** True when a live `config_option_update` reports a model list that differs from the cached agent schema. */
const hasNewModelCatalog = (
  agents: readonly AgentInfo[] | undefined,
  agentId: string | undefined,
  update: unknown,
): boolean => {
  const u = update as {
    sessionUpdate?: string;
    configOptions?: {
      configId?: string;
      options?: { value?: unknown; _meta?: Record<string, unknown> }[];
    }[];
  };
  if (u.sessionUpdate !== "config_option_update" || !Array.isArray(u.configOptions)) return false;
  const modelOpt = u.configOptions.find((o) => o.configId === "model");
  if (!Array.isArray(modelOpt?.options)) return false;
  const incoming = modelOpt.options
    .filter(
      (c): c is { value: string; _meta?: Record<string, unknown> } =>
        typeof c?.value === "string" && c.value !== "" && c._meta?.["cycle/custom"] !== true,
    )
    .map((c) => c.value);
  if (incoming.length === 0) return false;
  const agent = agentId !== undefined ? agents?.find((a) => a.id === agentId) : undefined;
  const properties = (
    agent?.configSchema as { properties?: Record<string, { oneOf?: { const?: unknown }[] }> }
  )?.properties;
  const existing = (properties?.model?.oneOf ?? [])
    .map((c) => c.const)
    .filter((v): v is string => typeof v === "string");
  if (existing.length !== incoming.length) return true;
  return incoming.some((value, index) => existing[index] !== value);
};

export class AppStore {
  readonly #bridge: CycleBridge;
  #state: AppState = initial();
  readonly #listeners = new Set<() => void>();
  /** Events about a session that is still being opened, held until its snapshot is in. */
  readonly #held = new Map<string, AppEvent[]>();
  /** In-flight `agents()` refreshes per environment, coalesced so bursts never spam the daemon. */
  readonly #loadingAgents = new Map<string, Promise<void>>();
  /**
   * How many plan-usage events each environment has had: a read's answer does not replace one told while it was
   * asked. Counted here, not by time: a remote daemon's clock is not this one's.
   */
  readonly #planEvents = new Map<string, number>();
  #stop: (() => void) | undefined;
  /** The blank conversation's folder is being looked up for trust: a second send waits for the first. */
  #checkingTrust = false;
  /** When the blank conversation now open was opened: how long it took to send its first message is reported. */
  #blankOpenedAt = 0;
  /** The latest read of the blank folder's trust, or answer to it: an older read that comes back after is not used. */
  #trustRead = 0;
  /** What each session's box holds, written and not sent. */
  readonly drafts: DraftStore;
  /** What each session's right panel shows (CYCL-90). */
  readonly sidePanels: SidePanelStore;
  /** Where each session's Files tab is: open folders, and the file shown (CYCL-92). */
  readonly filesViews = new FilesViews();
  /** Which view each session's Diff tab shows: kept while the window is open, so a tab looked away from finds it again. */
  readonly diffModes = new Map<string, "session" | "workspace">();
  readonly #acks = new WeakSet<Returned>();
  /**
   * Sessions whose box holds a message put back to send again, with what the box then held: whether it went as it was
   * is counted when it is sent. Forgotten when the box is emptied without sending it.
   */
  readonly #resending = new Map<string, { turn: number; sent: string }>();
  /** Who draws each terminal (`environmentId:terminalId`): its output and resets go there, and nowhere else. */
  readonly #terminalScreens = new Map<string, TerminalScreen>();

  constructor(
    bridge: CycleBridge,
    drafts: DraftStore = new DraftStore(),
    sidePanels: SidePanelStore = new SidePanelStore(),
  ) {
    this.#bridge = bridge;
    this.drafts = drafts;
    this.sidePanels = sidePanels;
    // A message put back to send again and then cleared away was not sent again: what is sent next is something else.
    drafts.subscribe(() => {
      for (const key of this.#resending.keys()) {
        if (promptBlocks(drafts.get(key)) === undefined) this.#resending.delete(key);
      }
    });
  }

  getState = (): AppState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(change: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
    const next = typeof change === "function" ? change(this.#state) : change;
    this.#state = { ...this.#state, ...next };
    for (const listener of [...this.#listeners]) listener();
  }

  /** Runs an action, and shows what went wrong instead of throwing it into the page. */
  async #attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      this.#set({ error: messageOf(error) });
      return undefined;
    }
  }

  dismissError = (): void => this.#set({ error: undefined });

  /** Starts listening to main and reads what it has. Call once. */
  async start(): Promise<void> {
    this.#stop = this.#bridge.onEvent((event) => this.#onEvent(event));
    void this.#attempt(async () => {
      const update = await this.#bridge.updateState();
      // An event that came while this was asked is newer than the answer.
      this.#set((s) => (s.update === undefined ? { update } : {}));
    });
    void this.#attempt(async () => this.#set({ analytics: await this.#bridge.analytics() }));
    // Read before the page is ready: its first words are already in the language that was chosen.
    const preferences = this.#bridge.preferences().then(
      (read) => this.#set({ preferences: read }),
      () => undefined,
    );
    await this.#attempt(async () => {
      const { environments, status, sessions } = await this.#bridge.environments();
      await preferences;
      this.#set({
        ready: true,
        environments,
        status: Object.fromEntries(status.map((s) => [s.environmentId, s])),
        // What main has read so far, also from an environment that has since gone away.
        sessions,
        selectedEnvironment: environments[0]?.id,
      });
      // Main connects every environment: the agents of those that already are, now; of the others, when each connects.
      await Promise.all(
        status.filter((s) => s.state === "connected").map((s) => this.#loadAgents(s.environmentId)),
      );
    });
    this.#set({ ready: true });
  }

  stop(): void {
    this.#stop?.();
  }

  // ---- what main tells us ----

  #onEvent(event: AppEvent): void {
    switch (event.type) {
      case "environments":
        this.#set({ environments: event.environments });
        return;
      case "environment-status": {
        const was = this.#state.status[event.environmentId]?.state;
        this.#set((s) => ({ status: { ...s.status, [event.environmentId]: toStatus(event) } }));
        if (event.state === "connected" && was !== "connected") {
          void this.#loadAgents(event.environmentId);
          // Terminals may have ended while the connection was away (the daemon stopped): their tabs say so.
          for (const key of Object.keys(this.#state.terminals)) {
            const [environmentId, sessionId] = splitKey(key);
            if (environmentId === event.environmentId && sessionId !== undefined)
              void this.#listTerminals(environmentId, sessionId, "kept");
          }
          // Whether its folder is trusted could not be asked before the daemon said it keeps trust.
          if (this.#state.blank?.environmentId === event.environmentId) void this.#readBlankTrust();
        }
        return;
      }
      case "sessions":
        this.#set((s) => ({ sessions: { ...s.sessions, [event.environmentId]: event.sessions } }));
        return;
      case "agent-defaults":
        this.#set((s) => ({
          defaultsRevision: {
            ...s.defaultsRevision,
            [event.environmentId]: (s.defaultsRevision[event.environmentId] ?? 0) + 1,
          },
        }));
        // A blank conversation starts from the defaults as they are now, under what was chosen on it.
        if (this.#state.blank?.environmentId === event.environmentId)
          void this.#readBlankDefaults(true);
        return;
      case "plan-usage":
        this.#planEvents.set(
          event.environmentId,
          (this.#planEvents.get(event.environmentId) ?? 0) + 1,
        );
        this.#set((s) => ({
          planUsage: {
            ...s.planUsage,
            [event.environmentId]: newerPlanUsage(s.planUsage[event.environmentId], {
              [event.agent]: event.usage,
            }),
          },
        }));
        return;
      case "connectors":
        if (this.#state.connectors[event.environmentId] !== undefined)
          void this.loadConnectors(event.environmentId);
        return;
      case "app-update":
        this.#set({ update: event.state });
        return;
      case "focus-session":
        this.#set((s) => ({ focusRequests: s.focusRequests + 1 }));
        void this.focusSession(event.environmentId, event.sessionId);
        return;
      case "session-gone":
        this.#forgetSession(event.environmentId, event.sessionId);
        return;
      case "terminals": {
        const key = viewKey(event.environmentId, event.sessionId);
        this.#set((s) => ({
          terminals: {
            ...s.terminals,
            [key]: mergeTerminals(s.terminals[key], event.terminals, "dropped"),
          },
        }));
        return;
      }
      case "terminal-output":
        this.#terminalScreens
          .get(`${event.environmentId}:${event.terminalId}`)
          ?.output(event.seq, event.data);
        return;
      case "terminal-reset":
        this.#terminalScreens
          .get(`${event.environmentId}:${event.terminalId}`)
          ?.screen(event.seq, event.screen, event.cols, event.rows);
        return;
      case "update": {
        const applied = this.#onSessionEvent(viewKey(event.environmentId, event.sessionId), event);
        if (applied && this.#state.status[event.environmentId]?.state === "connected") {
          const agentId = this.#state.sessions[event.environmentId]?.find(
            (s) => s.sessionId === event.sessionId,
          )?.agent;
          if (hasNewModelCatalog(this.#state.agents[event.environmentId], agentId, event.update)) {
            void this.#loadAgents(event.environmentId);
          }
        }
        return;
      }
      case "permission":
        this.#onSessionEvent(viewKey(event.request.environmentId, event.request.sessionId), event);
        return;
      case "permission-closed":
        this.#onSessionEvent(viewKey(event.environmentId, event.sessionId), event);
        return;
    }
  }

  #onSessionEvent(key: string, event: AppEvent & { version: number }): boolean {
    const view = this.#state.views[key];
    if (view === undefined) return false;
    if (view.loading) {
      this.#held.set(key, [...(this.#held.get(key) ?? []), event]);
      return false;
    }
    if (event.version <= view.version) return false;
    if (event.version > view.version + 1) {
      // One was missed. Ask main for the session again rather than show something wrong.
      void this.#reopen(view.environmentId, view.sessionId);
      return false;
    }
    this.#setView(key, applyToView(view, event));
    return true;
  }

  #setView(key: string, view: SessionView): void {
    this.#takeBack(key, view);
    this.#set((s) => ({ views: { ...s.views, [key]: view } }));
  }

  /**
   * What the daemon handed back (a stop, an error) goes into that session's box, whether or not it is the one in
   * view, once: a reload of the page finds the same hand-back and does not put it there again.
   */
  #takeBack(key: string, view: SessionView): void {
    const returned = view.conversation.returned;
    if (returned === undefined || view.loading) return;
    const id = returnedId(returned.prompts);
    if (!this.drafts.handled(key, id)) {
      this.drafts.restore(
        key,
        returned.prompts.map((p) => p.prompt),
        id,
      );
    }
    if (returned.returnId && !this.#acks.has(returned)) {
      this.#acks.add(returned);
      void this.#bridge
        .ackReturn(view.environmentId, view.sessionId, returned.returnId)
        .catch(() => {
          this.#acks.delete(returned);
        });
    }
  }

  async #reopen(environmentId: string, sessionId: string): Promise<void> {
    await this.#attempt(() => this.#load(environmentId, sessionId));
  }

  /** Reads a session from main whole, then applies the events that came while it was being read. */
  async #load(environmentId: string, sessionId: string): Promise<void> {
    const key = viewKey(environmentId, sessionId);
    const existing = this.#state.views[key];
    this.#held.set(key, []);
    this.#setView(key, {
      environmentId,
      sessionId,
      conversation: existing?.conversation ?? emptyConversation(),
      permissions: existing?.permissions ?? [],
      version: existing?.version ?? -1,
      loading: true,
    });
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.#bridge.openSession(environmentId, sessionId);
    } catch (error) {
      this.#held.delete(key);
      // What was read before is still what there is: a re-read that failed does not take the conversation away.
      // (Not the placeholder of a read still going: that has nothing in it.) Version -1: the next event asks again.
      if (existing !== undefined && !existing.loading)
        this.#setView(key, { ...existing, loading: false, version: -1 });
      else
        this.#set((s) => {
          const { [key]: _gone, ...views } = s.views;
          return { views };
        });
      throw error;
    }
    let view: SessionView = {
      environmentId,
      sessionId,
      conversation: snapshot.conversation,
      permissions: snapshot.permissions,
      version: snapshot.version,
      loading: false,
    };
    for (const event of this.#held.get(key) ?? []) {
      const version = (event as { version: number }).version;
      if (version === view.version + 1)
        view = applyToView(view, event as AppEvent & { version: number });
    }
    this.#held.delete(key);
    this.#setView(key, view);
  }

  // ---- what the user does ----

  /** Asks main to connect to an environment again. Why it cannot is in the environment's status, not in an error to dismiss. */
  connectEnvironment = async (environmentId: string): Promise<void> => {
    try {
      await this.#bridge.connect(environmentId);
    } catch {
      // The status says why.
    }
  };

  #loadAgents(environmentId: string): Promise<void> {
    const inflight = this.#loadingAgents.get(environmentId);
    if (inflight !== undefined) return inflight;
    const load = (async () => {
      await this.#attempt(async () => {
        const agents = await this.#bridge.agents(environmentId);
        this.#set((s) => ({ agents: { ...s.agents, [environmentId]: agents } }));
      });
      // What the daemon has of its agents' plan limits, on this connection: it replaces what was kept from before (a
      // daemon that restarted, or an agent signed in otherwise, has none), but not a change told while it was asked.
      const before = this.#planEvents.get(environmentId) ?? 0;
      void this.#bridge
        .planUsage(environmentId)
        .then((told) =>
          this.#set((s) => {
            const meanwhile = (this.#planEvents.get(environmentId) ?? 0) !== before;
            // Both come from the same daemon, so their times compare.
            const heard = meanwhile ? s.planUsage[environmentId] : undefined;
            return { planUsage: { ...s.planUsage, [environmentId]: newerPlanUsage(heard, told) } };
          }),
        )
        .catch(() => undefined);
      // A blank conversation on it was waiting to know which agent it starts.
      if (this.#state.blank?.environmentId === environmentId) void this.#readBlankDefaults();
    })().finally(() => {
      this.#loadingAgents.delete(environmentId);
    });
    this.#loadingAgents.set(environmentId, load);
    return load;
  }

  /** Reads the environment's agents again, e.g. after credentials or binaries are fixed. */
  reloadAgents = (environmentId: string): Promise<void> => this.#loadAgents(environmentId);

  // ---- the blank conversation ----

  /** The agent a blank conversation starts: the one chosen, if the environment has it, else its first available. */
  blankAgent = (blank: BlankConversation): AgentInfo | undefined => {
    const available = (this.#state.agents[blank.environmentId] ?? []).filter((a) => a.available);
    return available.find((a) => a.id === blank.agent) ?? available[0];
  };

  /**
   * Opens a blank conversation: a new session that does not exist until its first message. One already open stays as it
   * is (what was chosen on it is kept), unless another environment or folder is asked for.
   */
  openBlank = (where: { environmentId: string; cwd?: string | undefined }): void => {
    const open = this.#state.blank;
    const same =
      open !== undefined &&
      open.environmentId === where.environmentId &&
      (where.cwd === undefined || where.cwd === open.cwd);
    const blank: BlankConversation =
      same || open?.starting !== undefined
        ? open
        : {
            environmentId: where.environmentId,
            cwd: where.cwd ?? "",
            agent: undefined,
            config: undefined,
          };
    if (blank !== open) this.#blankOpenedAt = Date.now();
    this.#set({ blank, selectedEnvironment: blank.environmentId, selectedSession: undefined });
    if (blank.config === undefined && blank.unreadable === undefined)
      void this.#readBlankDefaults();
    if (blank !== open) void this.#readBlankTrust();
  };

  /** Changes what the blank conversation will start as. Not while it is starting. */
  changeBlank = (change: {
    environmentId?: string;
    cwd?: string;
    agent?: string;
    setting?: { key: string; value: string };
    /** Every setting at once, as the settings form hands them back. */
    config?: Record<string, string>;
  }): void => {
    const blank = this.#state.blank;
    if (blank === undefined || blank.starting !== undefined) return;
    let next: BlankConversation = { ...blank };
    if (change.environmentId !== undefined && change.environmentId !== blank.environmentId) {
      // A folder and an agent of one environment mean nothing on another.
      next = { environmentId: change.environmentId, cwd: "", agent: undefined, config: undefined };
    }
    if (change.cwd !== undefined && change.cwd !== next.cwd) {
      next.cwd = change.cwd;
      delete next.trust;
    }
    if (change.agent !== undefined && change.agent !== next.agent) {
      // Another agent has other settings: what was chosen for this one is not for it.
      next = { ...next, agent: change.agent, config: undefined };
      delete next.unreadable;
      delete next.chosen;
    }
    if (change.setting !== undefined && next.config !== undefined) {
      const { key, value } = change.setting;
      next.config = { ...next.config, [key]: value };
      next.chosen = { ...next.chosen, [key]: value };
    }
    if (change.config !== undefined && next.config !== undefined) {
      const before = next.config;
      const changed = Object.entries(change.config).filter(([key, value]) => before[key] !== value);
      next.config = change.config;
      next.chosen = { ...next.chosen, ...Object.fromEntries(changed) };
    }
    this.#set({ blank: next, selectedEnvironment: next.environmentId });
    if (next.config === undefined && next.unreadable === undefined) void this.#readBlankDefaults();
    if (next.cwd !== blank.cwd || next.environmentId !== blank.environmentId)
      void this.#readBlankTrust();
  };

  /**
   * Reads whether the blank conversation's folder is trusted, for the page to say so before the first message. Only a
   * hint: the first message reads it again, and asks. Nothing is said when the daemon cannot tell, or the read fails.
   */
  async #readBlankTrust(): Promise<void> {
    const blank = this.#state.blank;
    if (blank === undefined) return;
    const cwd = blank.cwd.trim();
    if (cwd === "" || this.#state.status[blank.environmentId]?.capabilities?.trust !== true) return;
    const asked = ++this.#trustRead;
    const read = await this.#bridge.readTrust(blank.environmentId, cwd).catch(() => undefined);
    const now = this.#state.blank;
    if (read === undefined || now === undefined || asked !== this.#trustRead) return;
    if (now.environmentId !== blank.environmentId || now.cwd.trim() !== cwd) return;
    const trust = read.trusted === null ? "undecided" : read.trusted ? "trusted" : "untrusted";
    if (now.trust !== trust) this.#set({ blank: { ...now, trust } });
  }

  /**
   * Answers whether to trust the blank conversation's folder, and then sends its first message. Undefined: neither, the
   * question is left and the message stays in the box. If the answer cannot be kept, nothing is started and it says why.
   */
  answerTrust = async (trusted: boolean | undefined): Promise<void> => {
    const blank = this.#state.blank;
    const asking = blank?.asking;
    if (blank === undefined || asking === undefined) return;
    const { asking: _asked, ...rest } = blank;
    if (trusted === undefined) {
      this.#set({ blank: rest });
      return;
    }
    try {
      await this.#bridge.setTrust(blank.environmentId, asking.path, trusted);
    } catch (error) {
      if (this.#state.blank === blank)
        this.#set({ blank: { ...blank, asking: { path: asking.path, failed: messageOf(error) } } });
      return;
    }
    if (this.#state.blank !== blank) return;
    // What was just decided is what the folder is now: a read still on its way is older.
    this.#trustRead++;
    const decided: BlankConversation = { ...rest, trust: trusted ? "trusted" : "untrusted" };
    this.#set({ blank: decided });
    await this.#sendBlank(decided, true);
  };

  /** Reads the agent's defaults again, after a read that failed. */
  retryBlank = (): void => {
    const blank = this.#state.blank;
    if (blank?.unreadable === undefined) return;
    const { unreadable: _failed, ...rest } = blank;
    this.#set({ blank: rest });
    void this.#readBlankDefaults();
  };

  /**
   * Reads the defaults of the agent the blank conversation starts, on its environment: what its session starts with,
   * under what was chosen on it. `again`: they have changed, and are read even though there are some already.
   */
  async #readBlankDefaults(again = false): Promise<void> {
    const blank = this.#state.blank;
    if (blank === undefined || blank.starting !== undefined) return;
    if (blank.config !== undefined && !again) return;
    const agent = this.blankAgent(blank);
    if (agent === undefined) return;
    let config: Record<string, string> | undefined;
    try {
      config = (await this.#bridge.agentDefaults(blank.environmentId, agent.id)) ?? {};
    } catch {
      config = undefined;
    }
    // Only for the conversation and agent it was read for: another may be open by now, or it may be starting.
    const now = this.#state.blank;
    if (
      now === undefined ||
      now.environmentId !== blank.environmentId ||
      now.starting !== undefined
    )
      return;
    if (now.config !== undefined && !again) return;
    if (this.blankAgent(now)?.id !== agent.id) return;
    if (config === undefined) {
      // A read again that fails leaves what was read before.
      if (now.config === undefined) this.#set({ blank: { ...now, unreadable: true } });
      return;
    }
    this.#set({ blank: { ...now, config: { ...config, ...now.chosen } } });
  }

  /**
   * Sends the blank conversation's first message, which is what makes its session: `session/new`, then `session/prompt`.
   * The message is shown in the blank conversation while that goes on. If the session cannot be made, the message comes
   * back to the box; if it is made and the message cannot go, the session is opened with the message back in its box.
   */
  async #sendBlank(blank: BlankConversation, trustAnswered = false): Promise<void> {
    const agent = this.blankAgent(blank);
    const cwd = blank.cwd.trim();
    if (
      blank.starting !== undefined ||
      blank.asking !== undefined ||
      this.#checkingTrust ||
      agent === undefined ||
      blank.config === undefined ||
      cwd === ""
    )
      return;
    if (promptBlocks(this.drafts.get(BLANK_KEY)) === undefined) return;
    const { environmentId } = blank;
    // A folder nobody has decided on is asked about before anything of its own can run. One that cannot be looked at
    // is not: making the session there fails with the daemon's reason.
    if (!trustAnswered && this.#state.status[environmentId]?.capabilities?.trust === true) {
      this.#checkingTrust = true;
      const trust = await this.#bridge.readTrust(environmentId, cwd).catch(() => undefined);
      this.#checkingTrust = false;
      const now = this.#state.blank;
      // Changed meanwhile (another folder, another environment): the person sends again.
      if (now === undefined || now.environmentId !== environmentId || now.cwd.trim() !== cwd)
        return;
      if (trust?.trusted === null) {
        this.#set({ blank: { ...now, asking: { path: trust.path } } });
        return;
      }
      blank = now;
    }
    const content = promptBlocks(this.drafts.get(BLANK_KEY));
    if (content === undefined) return;
    this.drafts.clear(BLANK_KEY);
    const starting: BlankConversation = { ...blank, cwd, starting: content };
    this.#set({ blank: starting });
    const sessionId = await this.#attempt(() =>
      this.#bridge.createSession(environmentId, {
        cwd,
        agent: agent.id,
        config: blank.config ?? {},
      }),
    );
    if (sessionId !== undefined)
      // Once, when the session is made: a start that fails and is sent again is not counted twice.
      this.track("blank_sent", { waited: waitedOf(Date.now() - this.#blankOpenedAt) });
    if (sessionId === undefined) {
      this.drafts.restore(BLANK_KEY, [content]);
      if (this.#state.blank === starting) this.#set({ blank: { ...blank, cwd } });
      return;
    }
    const sent = await this.#attempt(async () => {
      await this.#bridge.prompt(environmentId, sessionId, content);
      return true;
    });
    const stayed = this.#state.blank === starting;
    // What could not go comes back where the person can find it: the session's box if they are still here (it opens),
    // else the blank conversation's, since a session nothing was said in is not in the list.
    if (sent !== true)
      this.drafts.restore(stayed ? viewKey(environmentId, sessionId) : BLANK_KEY, [content]);
    // The person may have gone elsewhere meanwhile: nothing is taken from them.
    if (!stayed) return;
    this.#set({ blank: undefined });
    await this.selectSession(environmentId, sessionId);
  }

  /** Shows a session of any environment: a notification about it was pressed. */
  focusSession = async (environmentId: string, sessionId: string): Promise<void> => {
    if (!this.#state.sessions[environmentId]?.some((s) => s.sessionId === sessionId)) return;
    await this.selectSession(environmentId, sessionId);
  };

  /**
   * Opens a session, on the environment it is on. An environment that is away still lists its sessions, as they were: one that was
   * open before can be read again, as it was; one that was not has nothing to show, and the person is told why.
   */
  selectSession = async (environmentId: string, sessionId: string): Promise<void> => {
    const state = this.#state.status[environmentId]?.state;
    if (
      state !== "connected" &&
      this.#state.views[viewKey(environmentId, sessionId)] === undefined
    ) {
      const name =
        this.#state.environments.find((h) => h.id === environmentId)?.name ?? environmentId;
      this.#set({ error: { key: "session.awayCannotOpen", params: { environment: name } } });
      return;
    }
    this.#set({ selectedEnvironment: environmentId, selectedSession: sessionId, blank: undefined });
    if (state === "connected") await this.#attempt(() => this.#load(environmentId, sessionId));
  };

  /**
   * Sends what the selected session's box holds: its text, and the images attached to it. The box is empty from the
   * moment it goes; if it cannot go, what was in it comes back, in front of anything written since. `steer`: while the
   * agent works, into the turn that is running instead of the queue.
   */
  send = async (options: { steer?: boolean; via?: SendVia } = {}): Promise<void> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId, blank } = this.#state;
    if (blank !== undefined) return this.#sendBlank(blank);
    if (environmentId === undefined || sessionId === undefined) return;
    const key = viewKey(environmentId, sessionId);
    const content: PromptBlock[] | undefined = promptBlocks(this.drafts.get(key));
    if (content === undefined) return;
    const resending = this.#resending.get(key);
    this.#resending.delete(key);
    this.drafts.clear(key);
    const sent = await this.#attempt(async () => {
      const how = {
        ...(options.steer === true ? { steer: true } : {}),
        ...(options.via !== undefined ? { via: options.via } : {}),
      };
      if (Object.keys(how).length > 0)
        await this.#bridge.prompt(environmentId, sessionId, content, how);
      else await this.#bridge.prompt(environmentId, sessionId, content);
      return true;
    });
    if (sent !== true) {
      this.drafts.restore(key, [content]);
      if (resending !== undefined) this.#resending.set(key, resending);
    } else if (resending !== undefined) {
      this.track("turn_resent", { edited: JSON.stringify(content) !== resending.sent });
    }
  };

  /**
   * "Edit message" on a turn that failed (DESIGN.md 4.4): what was said in it goes back in front of the box, and the box takes
   * the focus. Nothing is sent: the person reads it, may change it, and sends it as any message, asked for permissions
   * afresh. Only for the session in view.
   */
  resend = (resend: Resend): void => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return;
    const key = viewKey(environmentId, sessionId);
    // Already in the box, and neither sent nor cleared away since: a second press only shows it, it does not add it again.
    if (this.#resending.get(key)?.turn !== resend.turn) {
      this.drafts.restore(key, resend.prompts);
      this.#resending.set(key, {
        turn: resend.turn,
        sent: JSON.stringify(promptBlocks(this.drafts.get(key)) ?? null),
      });
      this.track("turn_resend_opened", {
        failure: resend.failure,
        changed: resend.changed.length > 0,
      });
    }
    this.#set((s) => ({ composerFocus: s.composerFocus + 1 }));
  };

  /**
   * "Try again" on a turn that failed: what was said in it is sent again as it was, in one go (the person was asked
   * first if the turn had already run a command or changed a file; `changed` says so). Only for the session in view,
   * while its environment is connected and the agent is not at work. If it cannot go, it comes back in the box, so
   * nothing is lost. Resolves when the daemon has answered.
   */
  retry = async (resend: Resend): Promise<boolean> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined || resend.busy) return false;
    if (this.#state.status[environmentId]?.state !== "connected") return false;
    const content = againBlocks(resend.prompts);
    if (content === undefined) return false;
    const sent = await this.#attempt(async () => {
      await this.#bridge.prompt(environmentId, sessionId, content, { via: "button" });
      return true;
    });
    if (sent !== true) {
      this.drafts.restore(viewKey(environmentId, sessionId), [content]);
      return false;
    }
    // Counted once it went, like `turn_resent`: a retry that could not be sent is not one.
    this.track("turn_retried", { failure: resend.failure, changed: resend.changed.length > 0 });
    return true;
  };

  /** What fits an @ in the selected session's box. Quiet when it cannot say: a menu that is not there is enough. */
  searchFiles = async (query: string): Promise<FileSearch | undefined> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId, blank } = this.#state;
    // A blank conversation has no session yet: it looks in the folder it has chosen, if the daemon can.
    const where =
      blank !== undefined
        ? blank.cwd.trim() !== "" &&
          this.#state.status[blank.environmentId]?.capabilities?.filesInFolder === true
          ? { cwd: blank.cwd.trim() }
          : undefined
        : sessionId !== undefined
          ? { sessionId }
          : undefined;
    const on = blank?.environmentId ?? environmentId;
    if (on === undefined || where === undefined) return undefined;
    try {
      return await this.#bridge.searchFiles(on, where, query);
    } catch {
      return undefined;
    }
  };

  /** One folder of a session's folder, for the Files tab. The caller says why it failed. */
  listFiles = (environmentId: string, sessionId: string, path: string): Promise<FileListing> =>
    this.#bridge.listFiles(environmentId, sessionId, path);

  /** A file of a session's folder, text from `offset`. The caller says why it failed. */
  readFile = (
    environmentId: string,
    sessionId: string,
    path: string,
    offset?: number,
  ): Promise<FileContent> => this.#bridge.readFile(environmentId, sessionId, path, offset);

  /** A session's folder against HEAD, for the Diff tab. The caller says why it failed. */
  workspaceStatus = (environmentId: string, sessionId: string): Promise<WorkspaceStatus> =>
    this.#bridge.workspaceStatus(environmentId, sessionId);

  /** One file's patch against HEAD. The caller says why it failed. */
  workspaceFile = (
    environmentId: string,
    sessionId: string,
    path: string,
  ): Promise<WorkspacePatch> => this.#bridge.workspaceFile(environmentId, sessionId, path);

  // ---- terminals (CYCL-98) ----

  /** Asks a session's daemon for its terminals, once the panel needs them; again when the connection comes back. */
  loadTerminals = (environmentId: string, sessionId: string): Promise<void> =>
    this.#listTerminals(environmentId, sessionId, "dropped");

  async #listTerminals(
    environmentId: string,
    sessionId: string,
    gone: "kept" | "dropped",
  ): Promise<void> {
    if (this.#state.status[environmentId]?.capabilities?.terminal !== true) return;
    const key = viewKey(environmentId, sessionId);
    try {
      const told = await this.#bridge.listTerminals(environmentId, sessionId);
      this.#set((s) => ({
        terminals: { ...s.terminals, [key]: mergeTerminals(s.terminals[key], told, gone) },
      }));
    } catch {
      // Not connected, or gone meanwhile: the list stays as it was, and a connection that comes back asks again.
    }
  }

  /**
   * Opens a shell in a session's folder and shows its tab. Why it could not (a limit reached, an archived session) is
   * shown as any other failure, in the page's words.
   */
  createTerminal = async (
    environmentId: string,
    sessionId: string,
    size: { cols: number; rows: number },
    via: "header" | "tab_strip",
  ): Promise<TerminalAttached | undefined> => {
    let made: Awaited<ReturnType<CycleBridge["createTerminal"]>>;
    try {
      made = await this.#bridge.createTerminal(environmentId, sessionId, size.cols, size.rows);
    } catch (error) {
      made = { problem: "failed", message: messageOf(error) };
    }
    if ("problem" in made) {
      const { problem, message } = made;
      this.#set({
        error:
          problem === "failed" && message !== undefined
            ? message
            : { key: `terminal.problem.${problem === "failed" ? "other" : problem}` },
      });
      this.track("terminal_open_failed", {
        reason:
          problem === "limit" || problem === "archived" || problem === "cwd_missing"
            ? problem
            : "other",
      });
      return undefined;
    }
    const key = viewKey(environmentId, sessionId);
    this.#set((s) => {
      const known = s.terminals[key] ?? [];
      const has = known.some((t) => t.terminalId === made.terminal.terminalId);
      return { terminals: { ...s.terminals, [key]: has ? known : [...known, made.terminal] } };
    });
    this.sidePanels.show(key, terminalTab(made.terminal.terminalId));
    this.track("terminal_opened", {
      via,
      count: terminalCount(this.#state.terminals[key]?.filter((t) => t.ended !== true).length ?? 0),
    });
    return made;
  };

  /**
   * Closes a terminal: its shell and what runs in it end. One that already ended only loses its tab. Failing to tell the
   * daemon is shown; the tab goes either way when the daemon no longer has it.
   */
  closeTerminal = async (
    environmentId: string,
    sessionId: string,
    terminalId: string,
  ): Promise<void> => {
    const key = viewKey(environmentId, sessionId);
    const was = this.#state.terminals[key]?.find((t) => t.terminalId === terminalId);
    this.#set((s) => ({
      terminals: {
        ...s.terminals,
        [key]: (s.terminals[key] ?? []).filter((t) => t.terminalId !== terminalId),
      },
    }));
    if (was === undefined) return;
    this.track("terminal_closed", {
      state: was.ended === true ? "ended" : was.status,
      count: terminalCount(this.#state.terminals[key]?.filter((t) => t.ended !== true).length ?? 0),
    });
    if (was.ended === true) return;
    await this.#attempt(() => this.#bridge.closeTerminal(environmentId, terminalId));
  };

  /**
   * Draws a terminal: from now on its output and resets go to `screen`, until the function returned is called. Call it
   * before attaching, so that output that comes before the attach's answer is not lost.
   */
  showTerminal = (
    environmentId: string,
    terminalId: string,
    screen: TerminalScreen,
  ): (() => void) => {
    const id = `${environmentId}:${terminalId}`;
    this.#terminalScreens.set(id, screen);
    return () => {
      if (this.#terminalScreens.get(id) === screen) this.#terminalScreens.delete(id);
    };
  };

  /** The terminal's screen now. Fails as the daemon says (it has gone, the connection is down): the caller shows it. */
  attachTerminal = (environmentId: string, terminalId: string): Promise<TerminalAttached> =>
    this.#bridge.attachTerminal(environmentId, terminalId);

  /** Lets go of a terminal no longer drawn. Never fails: one that has gone, or a connection that has, is let go already. */
  detachTerminal = (environmentId: string, terminalId: string): void => {
    void this.#bridge.detachTerminal(environmentId, terminalId).catch(() => undefined);
  };

  terminalInput = (environmentId: string, terminalId: string, data: string): Promise<void> =>
    this.#bridge.terminalInput(environmentId, terminalId, data);

  resizeTerminal = (
    environmentId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void> => this.#bridge.resizeTerminal(environmentId, terminalId, cols, rows);

  /** Shows a file (or, `folder`, a folder in the tree) of the open session in its Files tab, opening the panel. */
  showInFiles = (path: string, options: { folder?: boolean } = {}): void => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return;
    const key = viewKey(environmentId, sessionId);
    if (options.folder === true) this.filesViews.reveal(key, path);
    else this.filesViews.show(key, path);
    this.sidePanels.show(key, "files");
  };

  /** The folders in a folder on an environment's machine. Not a banner when it fails: the one who asked says why. */
  listFolders = (environmentId: string, path?: string, hidden?: boolean): Promise<FolderListing> =>
    this.#bridge.listFolders(environmentId, path, hidden);

  /** Whether a folder on an environment's machine may run its own configuration's commands. The caller says why it failed. */
  readTrust = (environmentId: string, path: string): Promise<FolderTrust> =>
    this.#bridge.readTrust(environmentId, path);

  setTrust = (environmentId: string, path: string, trusted: boolean): Promise<FolderTrust> =>
    this.#bridge.setTrust(environmentId, path, trusted);

  /** Changes a folder's trust from a menu: a failure is shown, with its reason. */
  changeTrust = async (environmentId: string, path: string, trusted: boolean): Promise<void> => {
    try {
      await this.#bridge.setTrust(environmentId, path, trusted);
    } catch (error) {
      this.#set({ error: { key: "trust.changeFailed", params: { reason: messageOf(error) } } });
    }
  };

  /** Takes a queued prompt back to edit it. Undefined if it had gone to the agent, or came back, meanwhile. */
  dequeue = async (queueId: string): Promise<PromptBlock[] | undefined> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return undefined;
    const blocks = await this.#attempt(() =>
      this.#bridge.dequeue(environmentId, sessionId, queueId),
    );
    if (blocks !== undefined) this.drafts.restore(viewKey(environmentId, sessionId), [blocks]);
    return blocks;
  };

  cancel = async (): Promise<void> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return;
    await this.#attempt(() => this.#bridge.cancel(environmentId, sessionId));
  };

  setSessionConfig = async (configId: string, value: string): Promise<void> => {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#state;
    if (environmentId === undefined || sessionId === undefined) return;
    await this.#attempt(() =>
      this.#bridge.setSessionConfig(environmentId, sessionId, configId, value),
    );
  };

  /** Answers with why it failed, or nothing. A row of the sidebar names its own environment; the header is the open one's. */
  renameSession = async (
    sessionId: string,
    title: string,
    where: "header" | "sidebar" = "header",
    environmentId = this.#state.selectedEnvironment,
  ): Promise<string | undefined> => {
    if (environmentId === undefined) return undefined;
    try {
      await this.#bridge.renameSession(environmentId, sessionId, title, where);
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  };

  dismissBackground = async (session: SessionSummary): Promise<void> => {
    const ids = session.unknownBackground;
    if (ids?.length)
      await this.#attempt(() =>
        this.#bridge.dismissBackground(session.environmentId, session.sessionId, ids),
      );
  };

  archiveSession = async (sessionId: string, archived: boolean): Promise<void> => {
    const environmentId = this.#state.selectedEnvironment;
    if (environmentId === undefined) return;
    await this.#attempt(() => this.#bridge.archiveSession(environmentId, sessionId, archived));
  };

  /**
   * The person is looking at the session: tell the daemon it has been seen. Nothing to show if it cannot be told (the
   * mark stays, and is asked again when something new comes in or the app comes back to the front): a mark is not worth an error banner.
   */
  markRead = async (environmentId: string, sessionId: string): Promise<void> => {
    try {
      await this.#bridge.markRead(environmentId, sessionId);
    } catch {
      // Not worth a banner.
    }
  };

  deleteSession = async (sessionId: string): Promise<string | undefined> => {
    const environmentId = this.#state.selectedEnvironment;
    if (environmentId === undefined) return undefined;
    try {
      await this.#bridge.deleteSession(environmentId, sessionId);
      this.#forgetSession(environmentId, sessionId);
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  };

  /** A session that no longer exists: its view, its draft and its place as the selected one go. */
  #forgetSession(environmentId: string, sessionId: string): void {
    const key = viewKey(environmentId, sessionId);
    this.drafts.forget(key);
    this.sidePanels.forget(key);
    this.filesViews.forget(key);
    this.#held.delete(key);
    this.#set((s) => {
      const { [key]: _gone, ...views } = s.views;
      const { [key]: _closed, ...terminals } = s.terminals;
      return {
        views,
        terminals,
        selectedSession:
          s.selectedEnvironment === environmentId && s.selectedSession === sessionId
            ? undefined
            : s.selectedSession,
      };
    });
  }

  answerPermission = async (key: string, optionId: string | "cancelled"): Promise<void> => {
    await this.#attempt(() => this.#bridge.answerPermission(key, optionId));
  };

  answerForm = async (key: string, answer: FormAnswer): Promise<void> => {
    await this.#attempt(() => this.#bridge.answerForm(key, answer));
  };

  saveEnvironment = async (environment: EnvironmentConfig): Promise<string | undefined> => {
    try {
      await this.#bridge.saveEnvironment(environment);
    } catch (error) {
      return messageOf(error);
    }
    // An environment that is added is connected at once, as every environment is when the app starts.
    await this.connectEnvironment(environment.id);
    return undefined;
  };

  removeEnvironment = async (environmentId: string): Promise<string | undefined> => {
    try {
      await this.#bridge.removeEnvironment(environmentId);
    } catch (error) {
      return messageOf(error);
    }
    this.drafts.forgetEnvironment(environmentId);
    this.sidePanels.forgetEnvironment(environmentId);
    this.#set((s) => {
      const { [environmentId]: _sessions, ...sessions } = s.sessions;
      const { [environmentId]: _agents, ...agents } = s.agents;
      const { [environmentId]: _status, ...status } = s.status;
      const { [environmentId]: _plan, ...planUsage } = s.planUsage;
      const views = Object.fromEntries(
        Object.entries(s.views).filter(([, view]) => view.environmentId !== environmentId),
      );
      const terminals = Object.fromEntries(
        Object.entries(s.terminals).filter(([key]) => splitKey(key)[0] !== environmentId),
      );
      const open = s.selectedEnvironment === environmentId;
      return {
        terminals,
        ...(s.blank?.environmentId === environmentId ? { blank: undefined } : {}),
        sessions,
        agents,
        status,
        planUsage,
        views,
        ...(open
          ? {
              selectedEnvironment: s.environments.find((h) => h.id !== environmentId)?.id,
              selectedSession: undefined,
            }
          : {}),
      };
    });
    return undefined;
  };

  readAgentDefaults = (
    environmentId: string,
    agent: string,
  ): Promise<Record<string, string> | undefined> =>
    // A read that failed is told as one (and not as "nothing saved"): what is saved over a failed read would be the near-empty form.
    this.#bridge.agentDefaults(environmentId, agent).catch((error: unknown) => {
      this.#set({ error: messageOf(error) });
      throw error;
    });

  /** Whether they were saved: what went wrong is shown as any other error. */
  setAgentDefaults = async (
    environmentId: string,
    agent: string,
    config: Record<string, string>,
  ): Promise<boolean> =>
    (await this.#attempt(async () => {
      await this.#bridge.setAgentDefaults(environmentId, agent, config);
      return true;
    })) === true;

  // ---- connectors: the panel shows what went wrong itself, next to what it was about ----

  /** Reads the environment's connectors into the state; why it could not is kept there too. */
  loadConnectors = async (environmentId: string): Promise<void> => {
    try {
      const list = await this.#bridge.listConnectors(environmentId);
      this.#set((s) => ({ connectors: { ...s.connectors, [environmentId]: { list } } }));
    } catch (error) {
      this.#set((s) => ({
        connectors: {
          ...s.connectors,
          // What was read before stays on screen under the error: it is still the last that is known.
          [environmentId]: { ...s.connectors[environmentId], error: messageOf(error) },
        },
      }));
    }
  };

  /** One connector as an answer gave it, in place: the list is right before the change event reads it again. */
  #putConnector(environmentId: string, connector: ConnectorInfo): void {
    this.#set((s) => {
      const list = s.connectors[environmentId]?.list;
      if (list === undefined) return {};
      const at = list.findIndex((c) => c.id === connector.id);
      const next = at < 0 ? [...list, connector] : list.map((c, i) => (i === at ? connector : c));
      return { connectors: { ...s.connectors, [environmentId]: { list: next } } };
    });
  }

  async #connectorAnswer<T extends object>(
    environmentId: string,
    answer: Promise<T>,
  ): Promise<T | { problem: ConnectorProblem; message?: string }> {
    const result = await answered(answer);
    if ("connector" in result) this.#putConnector(environmentId, result.connector as ConnectorInfo);
    return result;
  }

  addConnector = (environmentId: string, draft: ConnectorDraft): Promise<ConnectorAnswer> =>
    this.#connectorAnswer(environmentId, this.#bridge.addConnector(environmentId, draft));

  updateConnector = (
    environmentId: string,
    id: string,
    change: ConnectorChange,
  ): Promise<ConnectorAnswer> =>
    this.#connectorAnswer(environmentId, this.#bridge.updateConnector(environmentId, id, change));

  /** Removes a connector and its credentials. The panel has asked the person first. */
  removeConnector = async (
    environmentId: string,
    id: string,
  ): Promise<{ removed: true } | { problem: ConnectorProblem; message?: string }> => {
    const answer = await answered(this.#bridge.removeConnector(environmentId, id));
    if ("removed" in answer)
      this.#set((s) => {
        const list = s.connectors[environmentId]?.list;
        if (list === undefined) return {};
        return {
          connectors: {
            ...s.connectors,
            [environmentId]: { list: list.filter((c) => c.id !== id) },
          },
        };
      });
    return answer;
  };

  authorizeConnector = (
    environmentId: string,
    id: string,
  ): Promise<ConnectorAnswer | { cancelled: true }> =>
    this.#connectorAnswer(environmentId, this.#bridge.authorizeConnector(environmentId, id));

  cancelConnectorAuth = (): Promise<void> =>
    this.#bridge.cancelConnectorAuth().catch(() => undefined);

  signOutConnector = (environmentId: string, id: string): Promise<ConnectorAnswer> =>
    this.#connectorAnswer(environmentId, this.#bridge.signOutConnector(environmentId, id));

  chooseDirectory = (): Promise<string | undefined> => this.#bridge.chooseDirectory();

  checkForUpdate = async (): Promise<void> => {
    await this.#attempt(async () => this.#set({ update: await this.#bridge.checkForUpdate() }));
  };

  /** The person's answer about usage statistics. */
  setAnalytics = async (enabled: boolean): Promise<void> => {
    await this.#attempt(async () =>
      this.#set({ analytics: await this.#bridge.setAnalytics(enabled) }),
    );
  };

  /** Changes how the app looks or reads. Main keeps it and applies it; what it answers is what holds. */
  setPreferences = async (change: Partial<Preferences>): Promise<void> => {
    await this.#attempt(async () =>
      this.#set({ preferences: await this.#bridge.setPreferences(change) }),
    );
  };

  /** Puts text on the clipboard, through main. Whether it did: never an error where it is used. */
  copyText = (text: string): Promise<boolean> =>
    this.#bridge.copyText(text).then(
      (done) => done,
      () => false,
    );

  /** Reports what only the page can see (a panel opened, a theme chosen). Never waits and never fails. */
  track = <N extends UiEventName>(name: N, props: EventProps<N>): void => {
    void this.#bridge.track(name, props).catch(() => undefined);
  };

  /** How it goes comes back in the environment's status. */
  upgradeDaemon = async (environmentId: string, when?: "now" | "later"): Promise<void> => {
    await this.#attempt(() => this.#bridge.upgradeDaemon(environmentId, when));
  };

  /** Main says how it goes through app-update events; an error it throws is shown as any other. */
  installUpdate = async (): Promise<void> => {
    await this.#attempt(() => this.#bridge.installUpdate());
  };
}

/** Who draws a terminal: its output, and the screen to draw again from when the app fell behind. */
export type TerminalScreen = {
  output: (seq: number, data: string) => void;
  screen: (seq: number, screen: string, cols: number, rows: number) => void;
};

/** `environmentId:sessionId` back into its two halves. An environment's id has no colon. */
const splitKey = (key: string): [string, string | undefined] => {
  const at = key.indexOf(":");
  return at < 0 ? [key, undefined] : [key.slice(0, at), key.slice(at + 1)];
};

/** What main threw (it lost its connection, it is too old) as an answer the panel shows like the others. */
const answered = <T>(
  answer: Promise<T>,
): Promise<T | { problem: ConnectorProblem; message?: string }> =>
  answer.catch((error: unknown) => ({ problem: "failed" as const, message: messageOf(error) }));

const toStatus = (event: AppEvent & { type: "environment-status" }): EnvironmentStatus => ({
  environmentId: event.environmentId,
  state: event.state,
  ...(event.error !== undefined ? { error: event.error } : {}),
  ...(event.daemon !== undefined ? { daemon: event.daemon } : {}),
  ...(event.incompatible !== undefined ? { incompatible: event.incompatible } : {}),
  ...(event.capabilities !== undefined ? { capabilities: event.capabilities } : {}),
});

const applyToView = (view: SessionView, event: AppEvent & { version: number }): SessionView => {
  if (event.type === "update") {
    return {
      ...view,
      conversation: applyUpdate(view.conversation, event.update, { at: event.at }),
      version: event.version,
    };
  }
  if (event.type === "permission") {
    const others = view.permissions.filter((p) => p.key !== event.request.key);
    return { ...view, permissions: [...others, event.request], version: event.version };
  }
  if (event.type === "permission-closed") {
    return {
      ...view,
      permissions: view.permissions.filter((p) => p.key !== event.key),
      version: event.version,
    };
  }
  return view;
};
