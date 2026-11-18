import {
  type AccountInfo,
  type AccountLogin,
  type AgentCapabilities,
  type AgentFeatures,
  type ApprovalResponse,
  type DaemonEvent,
  type DaemonInfo,
  type DayUsage,
  type Delivery,
  type EventFrame,
  type AgentInfo,
  type HookSettings,
  type McpServerInfo,
  type McpServerInput,
  type MethodName,
  type ModeInfo,
  type ModelInfo,
  type ModelProvider,
  type SandboxEnvironment,
  type Params,
  type PluginCatalog,
  type PromptDocument,
  type Result,
  type ReviewTarget,
  type Schedule,
  type ScheduleInput,
  type Session,
  type PermissionMode,
  type SessionState,
  type SkillInfo,
  type SubagentInfo,
  type Settings,
  type SlashCommand,
  type TerminalInfo,
  harnessLabel,
  reduceSession,
} from "@cycle/protocol";
import {
  type LastDraft,
  canSandbox,
  draftModel,
  draftEnvironment,
  draftStart,
  lastDraftFrom,
} from "../lib/draft.ts";
import { Connection, type ConnectionStatus, DaemonError } from "./connection.ts";
import { type UpdateState, host } from "./host.ts";
import { type RemoteView, UNREACHABLE, isRemote } from "../lib/remote.ts";
import { Store } from "./store.ts";
import { draftKey, opening } from "../lib/opening.ts";
import { plainMentions } from "../lib/suggest.ts";
import { attentionLabel } from "../lib/attention.ts";
import { type Attachments, givenBack, keepAccepted } from "../lib/attach.ts";

export type PanelId = "changes" | "files" | "terminal" | "overview";
export type Theme = "system" | "light" | "dark";
export type PageId = "thread" | "settings" | "connector" | "automatic";

/** A session being set up: it exists once its first prompt is sent. */
export interface Draft {
  /** The agent it starts on, which it stays with. Its models and where it can run follow. */
  harness: string;
  cwd: string;
  worktree: boolean;
  branch: string;
  /**
   * The environment its agent runs in, by id, or null to run on this machine. Only
   * what the chosen agent can do is sent.
   */
  environment: string | null;
  model: string | null;
  effort: string | null;
  mode: PermissionMode;
  /** Folders beyond `cwd` its agent may reach, sent only when the agent can and not with a sandbox. */
  directories: string[];
}

/** A sign-in the owner is finishing in a browser, and whose account it is for. */
export type PendingLogin = AccountLogin & { harness: string };

/** What an agent nobody has described yet is taken to do: what every agent does, and no more. */
export const NO_CAPABILITIES: AgentCapabilities = {
  attachments: ["image"],
  rewindFiles: false,
  commands: false,
  directories: false,
  connector: "read",
  login: false,
  features: false,
  mcpReconnect: false,
  subagents: false,
  tags: false,
  hooks: false,
};

export type SettingsSection =
  | "general"
  | "account"
  | "providers"
  | "sandboxes"
  | "remotes"
  | "about";

export interface ViewState {
  /** Which part of Settings shows; the sidebar lists them while Settings is open. */
  settingsSection: SettingsSection;
  sessionId: string | null;
  draft: Draft | null;
  page: PageId;
  panel: PanelId | null;
  panelWidth: number;
  sidebar: boolean;
  sidebarWidth: number;
  palette: boolean;
  folderPicker: boolean;
  /** The project the list shows, or null for every project. */
  project: string | null;
  /** The file the Files panel shows. */
  file: { path: string; line: number | null } | null;
  showReasoning: boolean;
  theme: Theme;
}

export interface Conversation {
  state: SessionState | null;
  loading: boolean;
  error: string | null;
}

export interface Toast {
  id: number;
  level: "info" | "error";
  message: string;
}

export interface SessionsState {
  byId: Record<string, Session>;
  loaded: boolean;
}

const PREFS_KEY = "cycle.prefs";
const DRAFT_PREFIX = "cycle.draft.";
/** Sessions kept followed after the owner moves on, so going back is instant. */
const FOLLOWED = 4;

type Prefs = Pick<
  ViewState,
  "panel" | "panelWidth" | "sidebar" | "sidebarWidth" | "showReasoning" | "theme" | "project"
>;

const LAST_KEY = "cycle.last-draft";

function readLast(): LastDraft {
  try {
    return lastDraftFrom(localStorage.getItem(LAST_KEY));
  } catch {
    return lastDraftFrom(null);
  }
}

/** Keeps what a new session chose, so the next one starts the same way. */
function keepLast(harness: string, environment: string | null): void {
  const last = readLast();
  try {
    localStorage.setItem(
      LAST_KEY,
      JSON.stringify({ harness, environment: { ...last.environment, [harness]: environment } }),
    );
  } catch {
    // A choice that cannot be kept is made again next time.
  }
}

function readPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
  } catch {
    return {};
  }
}

/** The folder a session belongs to in the list: its repository, not its worktree. */
export function projectOf(info: Session): string {
  return info.worktree?.repo ?? info.cwd;
}

export function sessionTitle(info: Session): string {
  return info.title || plainMentions(info.preview).split("\n")[0]?.slice(0, 80) || "New session";
}

/**
 * Everything the page knows, and everything it can ask the daemon to do.
 * State lives in stores by owner, so a streamed chunk redraws the
 * conversation it belongs to and nothing else.
 */
export class CycleApp {
  readonly connection = new Store<ConnectionStatus>("connecting");
  readonly daemon = new Store<DaemonInfo | null>(null);
  readonly sessions = new Store<SessionsState>({ byId: {}, loaded: false });
  readonly archived = new Store<Session[] | null>(null);
  readonly settings = new Store<Settings | null>(null);
  readonly models = new Store<ModelInfo[]>([]);
  /** Every agent's modes. A session can be in those of the agent it runs on. */
  readonly modes = new Store<ModeInfo[]>([]);
  /** The agents the daemon runs, the main one first, and what each can do. */
  readonly harnesses = new Store<AgentInfo[]>([]);
  /** Each agent's account, by the agent's name, once read. */
  readonly accounts = new Store<Record<string, AccountInfo>>({});
  /** A sign-in the owner is finishing in a browser. */
  readonly login = new Store<PendingLogin | null>(null);
  /** The commands each session's prompt can begin with, as its agent last said. */
  readonly commands = new Store<Record<string, SlashCommand[]>>({});
  /** What each session's agent guesses its owner sends next. */
  readonly nextPrompts = new Store<Record<string, string>>({});
  readonly providers = new Store<ModelProvider[]>([]);
  /** The owner's sandbox environments, and whether a sandbox can be made on the daemon's machine. */
  readonly sandboxes = new Store<{ available: boolean; environments: SandboxEnvironment[] }>({
    available: false,
    environments: [],
  });
  readonly usage = new Store<DayUsage | null>(null);
  readonly terminals = new Store<Record<string, TerminalInfo[]>>({});
  /** Null until read: the Connector reads them when it opens, since asking starts the servers. */
  readonly mcp = new Store<McpServerInfo[] | null>(null);
  readonly plugins = new Store<PluginCatalog | null>(null);
  /** Whose Connector the page shows: null for the main agent's. */
  readonly connectorAgent = new Store<string | null>(null);
  /** The shown agent's skills, and the hooks Cycle keeps for it, when it has them. */
  readonly skills = new Store<SkillInfo[] | null>(null);
  /** The helper agents the shown agent can start in a folder; null until read. */
  readonly subagents = new Store<SubagentInfo[] | null>(null);
  readonly hooks = new Store<HookSettings | null>(null);
  /** Null until read: Settings reads them when it opens. */
  readonly features = new Store<AgentFeatures | null>(null);
  readonly schedules = new Store<Schedule[] | null>(null);
  readonly toasts = new Store<Toast[]>([]);
  /** The desktop app's own updates. Null in a browser, and in an app that cannot replace itself. */
  readonly update = new Store<UpdateState | null>(null);
  /** The desktop app's remote servers. Null in a browser, and in an app that has none. */
  readonly remote = new Store<RemoteView | null>(null);
  readonly view: Store<ViewState>;

  private readonly link: Connection;
  private readonly conversations = new Map<string, Store<Conversation>>();
  private readonly followed: string[] = [];
  private readonly frames: EventFrame[] = [];
  private flushing = false;
  private toastIds = 0;
  private readonly terminalListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  private folderChosen: ((folder: string | null) => void) | null = null;

  constructor(url: string) {
    const prefs = readPrefs();
    this.view = new Store<ViewState>({
      sessionId: null,
      draft: null,
      page: "thread",
      settingsSection: "general",
      panel: prefs.panel ?? null,
      panelWidth: prefs.panelWidth ?? 460,
      sidebar: prefs.sidebar ?? true,
      sidebarWidth: prefs.sidebarWidth ?? 248,
      palette: false,
      folderPicker: false,
      project: prefs.project ?? null,
      file: null,
      showReasoning: prefs.showReasoning ?? false,
      theme: prefs.theme ?? "system",
    });
    this.applyTheme();
    this.view.subscribe(() => {
      const { panel, panelWidth, sidebar, sidebarWidth, showReasoning, theme, project } =
        this.view.get();
      const next: Prefs = {
        panel,
        panelWidth,
        sidebar,
        sidebarWidth,
        showReasoning,
        theme,
        project,
      };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // Preferences that cannot be kept still work until the page closes.
      }
    });
    this.link = new Connection(url, {
      onStatus: (status) => {
        this.connection.set(status);
        if (status === "open") void this.bootstrap();
      },
      onFrame: (frame) => this.receiveFrame(frame),
      onPush: (event) => this.receivePush(event),
    });
  }

  start(): void {
    host.watchUpdate((state) => this.update.set(state));
    this.watchRemote();
    this.link.connect();
  }

  /**
   * Reads the remote servers and where the window is: it may have been navigated to a remote
   * daemon's page, which starts here again. Any call of the bridge may reject.
   */
  private watchRemote(): void {
    const bridge = host.remote();
    if (!bridge) return;
    this.remote.set({ servers: [], state: { status: "idle" }, problem: null });
    try {
      bridge.onState((state) => this.remote.update((view) => view && { ...view, state }));
    } catch {
      // The state is read again below, and by Settings.
    }
    void this.refreshRemote();
  }

  async refreshRemote(): Promise<void> {
    const bridge = host.remote();
    if (!bridge) return;
    try {
      const [servers, state] = await Promise.all([bridge.list(), bridge.state()]);
      this.remote.set({ servers, state, problem: null });
    } catch {
      this.remote.update((view) => view && { ...view, problem: UNREACHABLE });
    }
  }

  stop(): void {
    this.link.close();
  }

  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.link.request(method, params);
  }

  /** Runs something the owner asked for, and says so when it fails. */
  async attempt<T>(work: Promise<T>): Promise<T | null> {
    try {
      return await work;
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), "error");
      return null;
    }
  }

  toast(message: string, level: Toast["level"] = "info"): void {
    const id = ++this.toastIds;
    this.toasts.update((toasts) => [...toasts.slice(-3), { id, level, message }]);
    setTimeout(() => this.dismissToast(id), level === "error" ? 8000 : 3500);
  }

  dismissToast(id: number): void {
    this.toasts.update((toasts) => toasts.filter((toast) => toast.id !== id));
  }

  // View

  setView(patch: Partial<ViewState>): void {
    this.view.update((view) => ({ ...view, ...patch }));
    if (patch.theme) this.applyTheme();
  }

  togglePanel(panel: PanelId): void {
    this.view.update((view) => ({ ...view, panel: view.panel === panel ? null : panel }));
  }

  openFile(path: string, line: number | null = null): void {
    this.setView({ panel: "files", file: { path, line } });
  }

  private applyTheme(): void {
    const theme = this.view.get().theme;
    const dark =
      theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset["theme"] = dark ? "dark" : "light";
  }

  conversation(sessionId: string): Store<Conversation> {
    let store = this.conversations.get(sessionId);
    if (!store) {
      store = new Store<Conversation>({ state: null, loading: false, error: null });
      this.conversations.set(sessionId, store);
    }
    return store;
  }

  draftText(key: string): string {
    try {
      return localStorage.getItem(DRAFT_PREFIX + key) ?? "";
    } catch {
      return "";
    }
  }

  saveDraftText(key: string, text: string): void {
    try {
      if (text) localStorage.setItem(DRAFT_PREFIX + key, text);
      else localStorage.removeItem(DRAFT_PREFIX + key);
    } catch {
      // A draft that cannot be kept is still in the field.
    }
  }

  // Sessions

  selectSession(sessionId: string | null): void {
    this.setView({ sessionId, draft: null, page: "thread", palette: false });
    if (sessionId) void this.follow(sessionId);
  }

  /** Starts setting up a session in `cwd`, or asks for a folder when there is none. */
  newSession(cwd?: string): void {
    const settings = this.settings.get();
    const view = this.view.get();
    const active = view.sessionId ? this.sessions.get().byId[view.sessionId] : undefined;
    const folder = cwd ?? view.project ?? (active ? projectOf(active) : settings?.projects[0]);
    if (!folder) {
      void this.pickFolder();
      return;
    }
    const models = this.models.get();
    const last = readLast();
    const harness = draftStart(models, settings?.model ?? null, last);
    this.setView({
      sessionId: null,
      page: "thread",
      palette: false,
      draft: {
        harness,
        cwd: folder,
        worktree: settings?.worktree ?? false,
        branch: "",
        environment: draftEnvironment(models, this.sandboxes.get().environments, harness, last),
        model: draftModel(models, harness, settings?.model ?? null),
        effort: settings?.effort ?? null,
        mode: settings?.modes[harness] ?? "",
        directories: [],
      },
    });
  }

  /** What the agent of this name can do. */
  capabilities(harness: string | null | undefined): AgentCapabilities {
    return (
      this.harnesses.get().find((each) => each.name === harness)?.capabilities ?? NO_CAPABILITIES
    );
  }

  /** The main agent's name: whose machine, Connector and features they are. */
  mainHarness(): string {
    return this.daemon.get()?.harness ?? "codex";
  }

  /**
   * Takes the models on offer. A session set up before any were known started on a guess: it is
   * set up again, now that the agent and where the last one ran can be told.
   */
  private setModels(models: ModelInfo[]): void {
    const guessed = this.models.get().length === 0 && models.length > 0;
    this.models.set(models);
    const view = this.view.get();
    if (guessed && view.draft && view.page === "thread" && !view.sessionId) {
      this.newSession(view.draft.cwd);
    }
  }

  /** Moves the session being set up to another agent: its model and where it runs start over. */
  setDraftHarness(harness: string): void {
    const draft = this.view.get().draft;
    if (!draft || draft.harness === harness) return;
    const usual = this.settings.get()?.model ?? null;
    const model = draftModel(this.models.get(), harness, usual);
    this.setView({
      draft: {
        ...draft,
        harness,
        model,
        effort: model === usual ? (this.settings.get()?.effort ?? null) : null,
        // Each agent has modes of its own: the session starts in what the owner keeps for it.
        mode: this.settings.get()?.modes[harness] ?? "",
        environment: draftEnvironment(
          this.models.get(),
          this.sandboxes.get().environments,
          harness,
          readLast(),
        ),
      },
    });
  }

  /**
   * Asks the owner for a folder: the host's chooser, or the page's own where there is none. The
   * host's chooser picks a folder of this computer, so a window on a remote server uses the page's,
   * which lists the server's folders through its daemon.
   */
  chooseFolder(): Promise<string | null> {
    const native = isRemote(this.remote.get()) ? null : host.pickDirectory();
    if (native) return native;
    this.folderChosen?.(null);
    this.setView({ folderPicker: true, palette: false });
    return new Promise((resolve) => {
      this.folderChosen = resolve;
    });
  }

  /** What the page's own chooser ended with: a folder, or null when it was closed. */
  answerFolder(folder: string | null): void {
    this.setView({ folderPicker: false });
    this.folderChosen?.(folder);
    this.folderChosen = null;
  }

  async pickFolder(): Promise<void> {
    const folder = await this.chooseFolder();
    if (folder) this.newSession(folder);
  }

  /** Makes the drafted session and sends its first prompt. */
  async createAndSend(
    text: string,
    images: string[],
    documents: PromptDocument[] = [],
  ): Promise<boolean> {
    const draft = this.view.get().draft;
    if (!draft) return false;
    const models = this.models.get();
    // The agent decides: a model of another's, left from before the models were known, gives way.
    const model = draftModel(models, draft.harness, draft.model);
    const environment =
      draft.environment !== null &&
      canSandbox(models, draft.harness) &&
      this.sandboxes.get().environments.some((one) => one.id === draft.environment)
        ? draft.environment
        : null;
    const directories =
      !environment && this.capabilities(draft.harness).directories ? draft.directories : [];
    // The composer keeps to what the agent takes; one that changed since keeps the prompt unsent.
    const kept = keepAccepted({ images, documents }, this.capabilities(draft.harness).attachments);
    if (kept.dropped.length) {
      this.toast(
        `${harnessLabel(draft.harness)} cannot read ${kept.dropped.join(", ")}. Remove ${kept.dropped.length > 1 ? "them" : "it"} to send.`,
        "error",
      );
      return false;
    }
    const info = await this.attempt(
      this.request("session.create", {
        cwd: draft.cwd,
        ...(draft.mode ? { mode: draft.mode } : {}),
        ...(model ? { model } : {}),
        ...(draft.effort && model === draft.model ? { effort: draft.effort } : {}),
        ...(environment
          ? { environment }
          : draft.worktree
            ? { worktree: draft.branch ? { branch: draft.branch } : {} }
            : {}),
        ...(directories.length ? { directories } : {}),
      }),
    );
    if (!info) return false;
    keepLast(draft.harness, environment);
    this.upsertSessions([info]);
    this.selectSession(info.id);
    const result = await opening({
      send: () => this.trySend(info.id, text, images, "auto", documents),
      // Only a session with no turn is dropped; the owner chose this, for one that never started.
      // Its worktree was made for it alone, so it goes too (the branch stays); the daemon refuses
      // if anything else uses the folder.
      drop: async () =>
        (this.conversation(info.id).get().state?.turns.length ?? 0) === 0 &&
        (await this.deleteSession(info.id, info.worktree !== null)),
    });
    if (result === "dropped") {
      // Back to the draft it was sent from, with the prompt in its composer, unless the owner has
      // gone somewhere else meanwhile.
      const view = this.view.get();
      if (view.sessionId === null && !view.draft) {
        this.setView({ draft, page: "thread" });
      }
      this.putInComposer(draftKey(draft.cwd), plainMentions(text), { images, documents });
      return false;
    }
    // A session that could not be deleted stays: a prompt it would not take waits in its composer.
    if (result === "kept") this.putInComposer(info.id, plainMentions(text), { images, documents });
    return true;
  }

  async send(
    sessionId: string,
    text: string,
    images: string[],
    delivery: Delivery,
    documents: PromptDocument[] = [],
  ): Promise<boolean> {
    return (await this.trySend(sessionId, text, images, delivery, documents)) === "sent";
  }

  /**
   * Sends a prompt. "Refused" is the daemon's own answer, so nothing was started; "lost" is a
   * connection that failed under the request, which leaves it unknown whether the daemon took it.
   */
  private async trySend(
    sessionId: string,
    text: string,
    images: string[],
    delivery: Delivery,
    documents: PromptDocument[],
  ): Promise<"sent" | "refused" | "lost"> {
    host.prepareNotifications();
    try {
      const sent = await this.request("session.send", {
        sessionId,
        text,
        images,
        ...(documents.length ? { documents } : {}),
        delivery,
      });
      // The daemon keeps a queued prompt's documents by name only: they come back from here.
      if (sent?.id && documents.length) this.queuedDocuments.set(sent.id, documents);
      return "sent";
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), "error");
      return error instanceof DaemonError ? "refused" : "lost";
    }
  }

  /** The documents of prompts this page queued, by queue id, to give back if the turn stops. */
  private readonly queuedDocuments = new Map<string, PromptDocument[]>();
  /** Attachments given back to a composer, by its key, until it takes them. */
  private readonly returnedAttachments = new Map<string, Attachments>();

  /** The attachments given back to a composer, once. */
  takeReturned(key: string): Attachments | null {
    const back = this.returnedAttachments.get(key) ?? null;
    this.returnedAttachments.delete(key);
    return back;
  }

  interrupt(sessionId: string): void {
    void this.attempt(this.request("session.interrupt", { sessionId }));
  }

  respond(sessionId: string, approvalId: string, response: ApprovalResponse): void {
    void this.attempt(this.request("approval.respond", { sessionId, approvalId, response }));
  }

  updateSession(params: Params<"session.update">): void {
    void this.attempt(this.request("session.update", params)).then((info) => {
      if (!info) return;
      this.upsertSessions([info]);
      if (params.archived !== undefined) {
        this.archived.set(null);
        if (params.archived && this.view.get().sessionId === info.id) this.selectSession(null);
      }
    });
  }

  /** Deletes a session for good. True when it is gone. */
  async deleteSession(sessionId: string, removeWorktree: boolean): Promise<boolean> {
    const done = await this.attempt(this.request("session.delete", { sessionId, removeWorktree }));
    if (done) this.forget([sessionId]);
    return Boolean(done);
  }

  /** Has the agent review code, in a turn of its own. */
  async review(sessionId: string, target: ReviewTarget): Promise<boolean> {
    host.prepareNotifications();
    return (await this.attempt(this.request("session.review", { sessionId, target }))) !== null;
  }

  /**
   * Takes a session back to before a turn, and gives the turn's prompt back to the composer so it
   * can be changed and sent again.
   */
  async rewind(sessionId: string, turnId: string, prompt: string, files = false): Promise<void> {
    const done = await this.attempt(
      this.request("session.rewind", { sessionId, turnId, ...(files ? { files: true } : {}) }),
    );
    if (done !== null && prompt) this.putInComposer(sessionId, prompt);
  }

  async fork(sessionId: string, turnId?: string): Promise<void> {
    const info = await this.attempt(
      this.request("session.fork", { sessionId, ...(turnId ? { turnId } : {}) }),
    );
    if (!info) return;
    this.upsertSessions([info]);
    this.selectSession(info.id);
  }

  async loadArchived(): Promise<void> {
    const answer = await this.attempt(this.request("session.list", { archived: true }));
    if (answer) this.archived.set(answer.sessions);
  }

  /** Reads every agent's account. Each is a courtesy: the page works without knowing it. */
  async refreshAccount(): Promise<void> {
    const names = this.harnesses.get().map((each) => each.name);
    await Promise.all(
      (names.length ? names : [this.mainHarness()]).map((harness) =>
        this.request("account.read", { harness }).then(
          (account) => this.setAccount(account),
          () => {},
        ),
      ),
    );
  }

  private setAccount(account: AccountInfo): void {
    this.accounts.update((all) => ({ ...all, [account.harness]: account }));
  }

  // Connector

  /** The agent whose Connector is shown, by name. */
  shownAgent(): string {
    return this.connectorAgent.get() ?? this.mainHarness();
  }

  /** What every Connector request names: the shown agent, or none for the main one. */
  private agent(): { harness?: string } {
    const name = this.connectorAgent.get();
    return name ? { harness: name } : {};
  }

  /** Shows another agent's Connector, read afresh. */
  showConnector(harness: string | null): void {
    this.connectorAgent.set(harness === this.mainHarness() ? null : harness);
    this.mcp.set(null);
    this.plugins.set(null);
    this.skills.set(null);
    this.hooks.set(null);
    void this.loadConnector();
  }

  async loadConnector(): Promise<void> {
    const agent = this.agent();
    const hooks = this.capabilities(this.shownAgent()).hooks;
    const [servers, catalog, settings] = await Promise.all([
      this.attempt(this.request("mcp.list", agent)),
      this.attempt(this.request("plugins.list", agent)),
      hooks ? this.attempt(this.request("hooks.read", agent)) : null,
    ]);
    if (servers) this.mcp.set(servers.servers);
    if (catalog) this.plugins.set(catalog);
    if (settings) this.hooks.set(settings);
  }

  /** The shown agent's skills in a folder. */
  async loadSkills(cwd: string): Promise<void> {
    const answer = await this.attempt(this.request("skills.list", { cwd, ...this.agent() }));
    if (answer) this.skills.set(answer.skills);
  }

  /** The helper agents the shown agent can start in a folder. */
  async loadSubagents(cwd: string): Promise<void> {
    const answer = await this.attempt(this.request("subagents.list", { cwd, ...this.agent() }));
    if (answer) this.subagents.set(answer.agents);
  }

  async enableSkill(cwd: string, name: string, enabled: boolean): Promise<void> {
    const answer = await this.attempt(
      this.request("skills.enable", { cwd, name, enabled, ...this.agent() }),
    );
    if (answer) this.skills.set(answer.skills);
  }

  /** Sets the shown agent's hooks. The page has asked the owner first. */
  async setHooks(settings: HookSettings): Promise<boolean> {
    const now = await this.attempt(this.request("hooks.set", { settings, ...this.agent() }));
    if (now) this.hooks.set(now);
    return now !== null;
  }

  private async mcpDid(work: Promise<{ servers: McpServerInfo[] }>): Promise<boolean> {
    const answer = await this.attempt(work);
    if (answer) this.mcp.set(answer.servers);
    return answer !== null;
  }

  private async pluginsDid(work: Promise<PluginCatalog>): Promise<boolean> {
    const catalog = await this.attempt(work);
    if (catalog) this.plugins.set(catalog);
    return catalog !== null;
  }

  putMcpServer(server: McpServerInput): Promise<boolean> {
    return this.mcpDid(this.request("mcp.put", { server, ...this.agent() }));
  }

  removeMcpServer(name: string): Promise<boolean> {
    return this.mcpDid(this.request("mcp.remove", { name, ...this.agent() }));
  }

  enableMcpServer(name: string, enabled: boolean): Promise<boolean> {
    return this.mcpDid(this.request("mcp.enable", { name, enabled, ...this.agent() }));
  }

  reconnectMcpServer(name: string): Promise<boolean> {
    return this.mcpDid(this.request("mcp.reconnect", { name, ...this.agent() }));
  }

  enableMcpTool(name: string, tool: string, enabled: boolean): Promise<boolean> {
    return this.mcpDid(this.request("mcp.enableTool", { name, tool, enabled, ...this.agent() }));
  }

  async loadFeatures(): Promise<void> {
    const features = await this.attempt(this.request("features.read", {}));
    if (features) this.features.set(features);
  }

  async setFeatures(features: AgentFeatures): Promise<void> {
    const now = await this.attempt(this.request("features.set", features));
    if (now) this.features.set(now);
  }

  /** Starts a server's sign-in and opens where the owner finishes it. */
  async loginMcpServer(name: string): Promise<void> {
    const answer = await this.attempt(this.request("mcp.login", { name, ...this.agent() }));
    if (!answer) return;
    // A browser tab may refuse a window opened this long after the press, and does not say so.
    if (!host.openExternal(answer.url)) {
      this.toast(`If no window opened, sign in at ${answer.url}`);
    }
  }

  installPlugin(marketplace: string, name: string): Promise<boolean> {
    return this.pluginsDid(this.request("plugins.install", { marketplace, name, ...this.agent() }));
  }

  uninstallPlugin(id: string): Promise<boolean> {
    return this.pluginsDid(this.request("plugins.uninstall", { id, ...this.agent() }));
  }

  enablePlugin(id: string, enabled: boolean): Promise<boolean> {
    return this.pluginsDid(this.request("plugins.enable", { id, enabled, ...this.agent() }));
  }

  addMarketplace(source: string): Promise<boolean> {
    return this.pluginsDid(this.request("marketplace.add", { source, ...this.agent() }));
  }

  removeMarketplace(name: string): Promise<boolean> {
    return this.pluginsDid(this.request("marketplace.remove", { name, ...this.agent() }));
  }

  // Schedules

  async loadSchedules(): Promise<void> {
    const answer = await this.attempt(this.request("schedule.list", {}));
    if (answer) this.schedules.set(answer.schedules);
  }

  async putSchedule(input: ScheduleInput): Promise<Schedule | null> {
    return this.attempt(this.request("schedule.put", input));
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.attempt(this.request("schedule.delete", { id }));
  }

  /** Runs a schedule now, and says so when the run started no session. */
  async runSchedule(id: string): Promise<void> {
    const run = await this.attempt(this.request("schedule.run", { id }));
    if (run?.error) this.toast(`Did not start: ${run.error}`, "error");
  }

  /** Starts an agent's sign-in and opens its page. The daemon says when it ends. */
  async signIn(harness: string): Promise<void> {
    const login = await this.attempt(this.request("account.login", { harness }));
    if (!login) return;
    this.login.set({ ...login, harness });
    host.openExternal(login.url);
  }

  async cancelSignIn(): Promise<void> {
    const login = this.login.get();
    if (!login) return;
    this.login.set(null);
    await this.request("account.login.cancel", { id: login.id, harness: login.harness }).catch(
      () => {},
    );
  }

  async signOut(harness: string): Promise<void> {
    await this.attempt(this.request("account.logout", { harness }));
    await this.refreshAccount();
  }

  // Terminals

  onTerminalOutput(id: string, listener: (data: Uint8Array) => void): () => void {
    let listeners = this.terminalListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.terminalListeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // The daemon

  private async bootstrap(): Promise<void> {
    try {
      const [daemon, settings, list] = await Promise.all([
        this.request("daemon.info", {}),
        this.request("settings.get", {}),
        this.request("session.list", { archived: false }),
      ]);
      this.daemon.set(daemon);
      this.harnesses.set(daemon.harnesses);
      this.settings.set(settings);
      const byId: Record<string, Session> = {};
      for (const info of list.sessions) byId[info.id] = info;
      this.sessions.set({ byId, loaded: true });
      // Whatever was followed before the connection dropped is caught up.
      for (const sessionId of this.followed) void this.open(sessionId);
      const view = this.view.get();
      if (view.sessionId && !this.followed.includes(view.sessionId))
        void this.follow(view.sessionId);
      void this.request("models.list", {}).then(
        ({ models }) => this.setModels(models),
        () => {},
      );
      void this.request("modes.list", {}).then(
        ({ modes }) => this.modes.set(modes),
        () => {},
      );
      void this.request("providers.list", {}).then(
        ({ providers }) => this.providers.set(providers),
        () => {},
      );
      void this.request("sandboxes.list", {}).then(
        (sandboxes) => this.sandboxes.set(sandboxes),
        () => {},
      );
      void this.refreshAccount();
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  /**
   * Follows a session that is not the one in view, to answer what it waits on from the sidebar.
   * The session in view stays the latest followed, so looking at others never drops it.
   */
  peek(sessionId: string): void {
    void this.follow(sessionId);
    const current = this.view.get().sessionId;
    const at = current && current !== sessionId ? this.followed.indexOf(current) : -1;
    if (at !== -1) this.followed.push(...this.followed.splice(at, 1));
  }

  private async follow(sessionId: string): Promise<void> {
    const index = this.followed.indexOf(sessionId);
    if (index !== -1) this.followed.splice(index, 1);
    this.followed.push(sessionId);
    while (this.followed.length > FOLLOWED) {
      const dropped = this.followed.shift();
      if (dropped) this.request("session.close", { sessionId: dropped }).catch(() => {});
    }
    await this.open(sessionId);
  }

  /** Follows a session: the whole state the first time, only what was missed after. */
  private async open(sessionId: string): Promise<void> {
    const store = this.conversation(sessionId);
    const known = store.get().state;
    store.update((conversation) => ({ ...conversation, loading: !known, error: null }));
    try {
      const answer = await this.request("session.open", {
        sessionId,
        ...(known ? { after: { seq: known.seq, epoch: known.epoch } } : {}),
      });
      if ("state" in answer) {
        store.set({ state: answer.state, loading: false, error: null });
      } else {
        for (const frame of answer.frames) this.frames.push(frame);
        store.update((conversation) => ({ ...conversation, loading: false }));
        this.flushFrames();
      }
    } catch (error) {
      store.update((conversation) => ({
        ...conversation,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private receiveFrame(frame: EventFrame): void {
    this.frames.push(frame);
    if (this.flushing) return;
    this.flushing = true;
    // One redraw per animation frame however fast frames arrive. A hidden
    // page gets no animation frames, so a timer stands in.
    const run = () => {
      if (!this.flushing) return;
      this.flushing = false;
      this.flushFrames();
    };
    requestAnimationFrame(run);
    setTimeout(run, 120);
  }

  private flushFrames(): void {
    const frames = this.frames.splice(0);
    const touched = new Map<string, SessionState>();
    const gaps = new Set<string>();
    for (const frame of frames) {
      const store = this.conversations.get(frame.sessionId);
      const state = touched.get(frame.sessionId) ?? store?.get().state;
      if (!state || frame.seq <= state.seq || gaps.has(frame.sessionId)) continue;
      if (frame.seq !== state.seq + 1) {
        gaps.add(frame.sessionId);
        continue;
      }
      let next = state;
      for (const event of frame.events) {
        if (event.type === "turn.completed" && event.status !== "completed" && next.queue.length) {
          // A stopped turn sends nothing more: what was queued goes back to the field, attachments
          // and all.
          const back = givenBack(next.queue, this.queuedDocuments);
          for (const queued of next.queue) this.queuedDocuments.delete(queued.id);
          this.putInComposer(frame.sessionId, back.text, back);
          if (back.lost.length) {
            this.toast(`Attach ${back.lost.join(", ")} again: it was queued elsewhere.`, "error");
          }
        }
        next = reduceSession(next, event);
      }
      touched.set(frame.sessionId, { ...next, seq: frame.seq });
    }
    for (const [sessionId, state] of touched) {
      this.conversation(sessionId).update((conversation) => ({ ...conversation, state }));
    }
    for (const sessionId of gaps) void this.open(sessionId);
  }

  /** Adds text, and attachments, to a session's composer, after what is in it, for the owner to send. */
  putInComposer(sessionId: string, text: string, attached?: Attachments): void {
    this.saveDraftText(sessionId, [this.draftText(sessionId), text].filter(Boolean).join("\n\n"));
    if (attached && (attached.images.length || attached.documents.length)) {
      const before = this.returnedAttachments.get(sessionId);
      this.returnedAttachments.set(sessionId, {
        images: [...(before?.images ?? []), ...attached.images],
        documents: [...(before?.documents ?? []), ...attached.documents],
      });
    }
    this.returned.set(this.returned.get() + 1);
  }

  /** Counts drafts given back by a stopped turn, so the field re-reads its text. */
  readonly returned = new Store(0);

  private receivePush(event: DaemonEvent): void {
    switch (event.type) {
      case "sessions.changed":
        this.noticeAttention(event.sessions);
        this.upsertSessions(event.sessions);
        break;
      case "sessions.removed":
        this.forget(event.sessionIds);
        break;
      case "settings.changed":
        this.settings.set(event.settings);
        break;
      case "account.changed":
        this.setAccount(event.account);
        // Codex also says the account changed for reasons that end no sign-in.
        if (
          this.login.get()?.harness === event.account.harness &&
          (event.error || event.account.kind)
        )
          this.login.set(null);
        if (event.error) this.toast(`The sign-in did not finish: ${event.error}`, "error");
        break;
      case "limits.changed":
        this.setAccount(event.account);
        break;
      case "commands.changed":
        this.commands.update((all) => ({ ...all, [event.sessionId]: event.commands }));
        break;
      case "suggestion.changed":
        this.nextPrompts.update(({ [event.sessionId]: _old, ...rest }) =>
          event.suggestion ? { ...rest, [event.sessionId]: event.suggestion } : rest,
        );
        break;
      case "models.changed":
        this.models.set(event.models);
        break;
      case "providers.changed":
        this.providers.set(event.providers);
        break;
      case "sandboxes.changed":
        this.sandboxes.update((value) => ({ ...value, environments: event.environments }));
        break;
      case "terminals.changed":
        this.terminals.update((all) => ({ ...all, [event.sessionId ?? ""]: event.terminals }));
        break;
      case "terminal.output": {
        const listeners = this.terminalListeners.get(event.id);
        if (!listeners?.size) break;
        const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
        for (const listener of listeners) listener(bytes);
        break;
      }
      case "usage.today":
        this.usage.set(event.day);
        break;
      // The Connector page shows one agent's at a time.
      case "mcp.changed":
        if (event.harness === this.shownAgent()) this.mcp.set(event.servers);
        break;
      case "plugins.changed":
        if (event.harness === this.shownAgent()) this.plugins.set(event.catalog);
        break;
      case "hooks.changed":
        if (event.harness === this.shownAgent()) this.hooks.set(event.settings);
        break;
      case "skills.changed": {
        const home = this.daemon.get()?.userHome;
        if (event.harness === this.shownAgent() && home && this.skills.get())
          void this.loadSkills(home);
        break;
      }
      case "features.changed":
        this.features.set(event.features);
        break;
      case "schedules.changed":
        this.schedules.set(event.schedules);
        break;
    }
  }

  private upsertSessions(infos: Session[]): void {
    this.sessions.update((sessions) => {
      const byId = { ...sessions.byId };
      for (const info of infos) {
        if (info.archived) delete byId[info.id];
        else byId[info.id] = info;
        const store = this.conversations.get(info.id);
        const state = store?.get().state;
        if (store && state)
          store.update((conversation) => ({ ...conversation, state: { ...state, info } }));
      }
      return { ...sessions, byId };
    });
  }

  private forget(sessionIds: string[]): void {
    this.sessions.update((sessions) => {
      const byId = { ...sessions.byId };
      for (const id of sessionIds) delete byId[id];
      return { ...sessions, byId };
    });
    for (const id of sessionIds) this.conversations.delete(id);
    const current = this.view.get().sessionId;
    if (current && sessionIds.includes(current)) this.selectSession(null);
  }

  /** Tells the owner when a session they are not looking at stops or asks. */
  private noticeAttention(infos: Session[]): void {
    const known = this.sessions.get().byId;
    const view = this.view.get();
    for (const info of infos) {
      const before = known[info.id];
      if (!before) continue;
      const label = attentionLabel(before, info);
      if (!label) continue;
      if (view.sessionId === info.id && document.hasFocus()) continue;
      host.notify(label, sessionTitle(info));
    }
  }
}
