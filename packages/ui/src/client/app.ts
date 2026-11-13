import {
  type AccountInfo,
  type ApprovalResponse,
  type DaemonEvent,
  type DaemonInfo,
  type DayUsage,
  type Delivery,
  type EventFrame,
  type MethodName,
  type ModelInfo,
  type Params,
  type Result,
  type SessionInfo,
  type SessionMode,
  type SessionState,
  type Settings,
  type TerminalInfo,
  reduceSession,
} from "@cycle/protocol";
import { Connection, type ConnectionStatus } from "./connection.ts";
import { host } from "./host.ts";
import { Store } from "./store.ts";

export type PanelId = "changes" | "files" | "terminal" | "overview";
export type Theme = "system" | "light" | "dark";

/** A session being set up: it exists once its first prompt is sent. */
export interface Draft {
  cwd: string;
  worktree: boolean;
  branch: string;
  model: string | null;
  effort: string | null;
  mode: SessionMode;
}

export interface ViewState {
  sessionId: string | null;
  draft: Draft | null;
  page: "thread" | "settings";
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
  byId: Record<string, SessionInfo>;
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

function readPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
  } catch {
    return {};
  }
}

/** The folder a session belongs to in the list: its repository, not its worktree. */
export function projectOf(info: SessionInfo): string {
  return info.worktree?.repo ?? info.cwd;
}

export function sessionTitle(info: SessionInfo): string {
  return info.title || info.preview.split("\n")[0]?.slice(0, 80) || "New session";
}

const ATTENTION: Partial<Record<SessionInfo["status"], string>> = {
  waiting: "Needs your approval",
  idle: "Finished",
  error: "Stopped with an error",
};

/**
 * Everything the page knows, and everything it can ask the daemon to do.
 * State lives in stores by owner, so a streamed chunk redraws the
 * conversation it belongs to and nothing else.
 */
export class CycleApp {
  readonly connection = new Store<ConnectionStatus>("connecting");
  readonly daemon = new Store<DaemonInfo | null>(null);
  readonly sessions = new Store<SessionsState>({ byId: {}, loaded: false });
  readonly archived = new Store<SessionInfo[] | null>(null);
  readonly settings = new Store<Settings | null>(null);
  readonly models = new Store<ModelInfo[]>([]);
  readonly account = new Store<AccountInfo | null>(null);
  readonly usage = new Store<DayUsage | null>(null);
  readonly terminals = new Store<Record<string, TerminalInfo[]>>({});
  readonly toasts = new Store<Toast[]>([]);
  readonly view: Store<ViewState>;

  private readonly link: Connection;
  private readonly conversations = new Map<string, Store<Conversation>>();
  private readonly followed: string[] = [];
  private readonly frames: EventFrame[] = [];
  private flushing = false;
  private toastIds = 0;
  private readonly terminalListeners = new Map<string, Set<(data: Uint8Array) => void>>();

  constructor(url: string) {
    const prefs = readPrefs();
    this.view = new Store<ViewState>({
      sessionId: null,
      draft: null,
      page: "thread",
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
    this.link.connect();
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
    this.setView({
      sessionId: null,
      page: "thread",
      palette: false,
      draft: {
        cwd: folder,
        worktree: settings?.worktree ?? false,
        branch: "",
        model: settings?.model ?? null,
        effort: settings?.effort ?? null,
        mode: settings?.mode ?? "auto",
      },
    });
  }

  async pickFolder(): Promise<void> {
    const native = host.pickDirectory();
    if (!native) {
      this.setView({ folderPicker: true, palette: false });
      return;
    }
    const folder = await native;
    if (folder) this.newSession(folder);
  }

  /** Makes the drafted session and sends its first prompt. */
  async createAndSend(text: string, images: string[]): Promise<boolean> {
    const draft = this.view.get().draft;
    if (!draft) return false;
    const info = await this.attempt(
      this.request("session.create", {
        cwd: draft.cwd,
        mode: draft.mode,
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.effort ? { effort: draft.effort } : {}),
        ...(draft.worktree ? { worktree: draft.branch ? { branch: draft.branch } : {} } : {}),
      }),
    );
    if (!info) return false;
    this.upsertSessions([info]);
    this.selectSession(info.id);
    await this.send(info.id, text, images, "auto");
    return true;
  }

  async send(sessionId: string, text: string, images: string[], delivery: Delivery): Promise<void> {
    host.prepareNotifications();
    await this.attempt(this.request("session.send", { sessionId, text, images, delivery }));
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

  async deleteSession(sessionId: string, removeWorktree: boolean): Promise<void> {
    const done = await this.attempt(this.request("session.delete", { sessionId, removeWorktree }));
    if (done) this.forget([sessionId]);
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

  async refreshAccount(): Promise<void> {
    try {
      this.account.set(await this.request("account.read", {}));
    } catch {
      // The account is a courtesy: the page works without knowing it.
    }
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
      this.settings.set(settings);
      const byId: Record<string, SessionInfo> = {};
      for (const info of list.sessions) byId[info.id] = info;
      this.sessions.set({ byId, loaded: true });
      // Whatever was followed before the connection dropped is caught up.
      for (const sessionId of this.followed) void this.open(sessionId);
      const view = this.view.get();
      if (view.sessionId && !this.followed.includes(view.sessionId))
        void this.follow(view.sessionId);
      void this.request("models.list", {}).then(
        ({ models }) => this.models.set(models),
        () => {},
      );
      void this.refreshAccount();
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), "error");
    }
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
          // A stopped turn sends nothing more: what was queued goes back to the field.
          const key = frame.sessionId;
          const returned = next.queue.map((queued) => queued.text).join("\n\n");
          this.saveDraftText(key, [this.draftText(key), returned].filter(Boolean).join("\n\n"));
          this.returned.set(this.returned.get() + 1);
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
    }
  }

  private upsertSessions(infos: SessionInfo[]): void {
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
  private noticeAttention(infos: SessionInfo[]): void {
    const known = this.sessions.get().byId;
    const view = this.view.get();
    for (const info of infos) {
      const before = known[info.id]?.status;
      if (!before || before === info.status) continue;
      const wasWorking = before === "running" || before === "waiting";
      const label = ATTENTION[info.status];
      if (!label || (!wasWorking && info.status !== "waiting")) continue;
      if (view.sessionId === info.id && document.hasFocus()) continue;
      host.notify(label, sessionTitle(info));
    }
  }
}
