import {
  type ApprovalResponse,
  type DayUsage,
  type Delivery,
  type EventFrame,
  type Harness,
  type HarnessEvent,
  type HarnessSession,
  type Params,
  type PromptInput,
  type QueuedMessage,
  type SessionEvent,
  type SessionInfo,
  type SessionMode,
  type SessionState,
  type SessionStatus,
  type Settings,
  type TokenCount,
  type WorktreeInfo,
  activeTurn,
  coalesceEvents,
  initialSessionState,
  reduceSession,
} from "@cycle/protocol";
import { type Git, defaultBranchName } from "./git.ts";
import type { JsonStore, Delay } from "./store.ts";
import { type UsageLedger, ZERO_TOKENS, tokenDelta } from "./usage.ts";

/** What the daemon alone keeps about a session, which no harness knows. */
export interface SessionMeta {
  title?: string;
  pinned?: boolean;
  unread?: boolean;
  mode?: SessionMode;
  model?: string;
  effort?: string | null;
  worktree?: WorktreeInfo;
  /** The schedule whose run started it. */
  scheduleId?: string;
}

export interface MetaFile {
  sessions: Record<string, SessionMeta>;
}

export interface HubOptions {
  harness: Harness;
  meta: JsonStore<MetaFile>;
  settings(): Settings;
  usage: UsageLedger;
  git: Git;
  /** Where worktrees are made. */
  worktreeParent: string;
  schedule: Delay;
  now(): number;
  /** How many clients follow a session now. */
  viewers(sessionId: string): number;
  publish: {
    frame(frame: EventFrame): void;
    sessions(sessions: SessionInfo[]): void;
    removed(sessionIds: string[]): void;
    usage(day: DayUsage): void;
  };
}

interface Live {
  state: SessionState;
  /** The latest frames, for a client that was away briefly. */
  ring: EventFrame[];
  pending: SessionEvent[];
  cancelFlush: (() => void) | null;
  /** A turn was asked for and has not been announced yet. */
  starting: boolean;
  usageSeen: TokenCount | null;
  /** The next usage report only sets the mark: it counts work done before now. */
  usageBaseline: boolean;
  usedAt: number;
}

/** Streamed text is sent on at most this often, as one frame. */
const DELTA_FLUSH_MS = 16;
const RING_FRAMES = 512;
const MAX_LIVE = 32;

export class SessionError extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns every session's state. It folds the harness's events into each open
 * session, numbers the result as frames so clients can follow or catch up,
 * and keeps what belongs to the owner rather than the agent: pins, modes,
 * queued prompts and what is unread.
 */
export class SessionHub {
  private readonly options: HubOptions;
  private readonly infos = new Map<string, SessionInfo>();
  private readonly live = new Map<string, Live>();
  private readonly loading = new Map<string, Promise<Live>>();
  private queueIds = 0;
  private epochs = 0;

  constructor(options: HubOptions) {
    this.options = options;
    options.harness.onEvent((event) => this.handle(event));
  }

  // Reading

  async list(archived: boolean): Promise<SessionInfo[]> {
    const stored = await this.options.harness.listSessions({ archived });
    const listed = new Set<string>();
    const out: SessionInfo[] = [];
    for (const session of stored) {
      listed.add(session.id);
      out.push(this.remember(session, archived));
    }
    if (!archived) {
      // A session with no turn yet is not in the harness's list.
      for (const [id, info] of this.infos) {
        if (!listed.has(id) && !info.archived && this.live.has(id)) out.push(info);
      }
    }
    return out.toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  info(sessionId: string): SessionInfo {
    const info = this.infos.get(sessionId);
    if (!info) throw new SessionError(`unknown session: ${sessionId}`);
    return info;
  }

  /** Whether a session is in the middle of a turn. A session nobody knows is not. */
  working(sessionId: string): boolean {
    const status = this.infos.get(sessionId)?.status;
    return status === "running" || status === "waiting";
  }

  /** Whether any session is in the middle of a turn in this folder. */
  busyIn(cwd: string): boolean {
    for (const info of this.infos.values()) {
      if (info.cwd === cwd && (info.status === "running" || info.status === "waiting")) return true;
    }
    return false;
  }

  /** Folders sessions run in, which the owner may read files under. */
  folders(): string[] {
    const out = new Set<string>();
    for (const info of this.infos.values()) {
      out.add(info.cwd);
      if (info.worktree) out.add(info.worktree.repo);
    }
    return [...out];
  }

  async open(
    sessionId: string,
    after: { seq: number; epoch: string } | undefined,
  ): Promise<{ state: SessionState } | { frames: EventFrame[] }> {
    const live = await this.ensureLive(sessionId);
    this.flush(live);
    if (after && after.epoch === live.state.epoch && after.seq <= live.state.seq) {
      const first = live.ring[0]?.seq ?? live.state.seq + 1;
      if (after.seq >= first - 1) {
        return { frames: live.ring.filter((frame) => frame.seq > after.seq) };
      }
    }
    return { state: live.state };
  }

  // Changing

  /** `scheduleId` marks a session a schedule's run starts. */
  async create(params: Params<"session.create">, scheduleId?: string): Promise<SessionInfo> {
    const { harness, git, now } = this.options;
    const settings = this.options.settings();
    let cwd = params.cwd;
    let worktree: WorktreeInfo | undefined;
    if (params.worktree) {
      const made = await git.addWorktree({
        cwd,
        parent: this.options.worktreeParent,
        branch: params.worktree.branch?.trim() || defaultBranchName(now()),
        ...(params.worktree.base ? { base: params.worktree.base } : {}),
      });
      cwd = made.cwd;
      worktree = made.worktree;
    }
    const mode = params.mode ?? settings.mode;
    const model = params.model ?? settings.model ?? undefined;
    const effort = params.effort ?? settings.effort ?? undefined;
    let session: HarnessSession;
    try {
      session = await harness.createSession({
        cwd,
        mode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
    } catch (error) {
      // A session that never started leaves no worktree behind.
      if (worktree) await git.removeWorktree(worktree.repo, cwd).catch(() => {});
      throw error;
    }
    this.options.meta.update((file) => {
      file.sessions[session.id] = {
        mode,
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(worktree ? { worktree } : {}),
        ...(scheduleId ? { scheduleId } : {}),
      };
    });
    const info: SessionInfo = { ...this.remember(session, false), status: "idle" };
    this.live.set(session.id, this.newLive(initialSessionState(info), false));
    this.setInfo(info);
    return info;
  }

  async send(
    sessionId: string,
    input: PromptInput,
    delivery: Delivery,
  ): Promise<{ queued: boolean }> {
    const live = await this.ensureLive(sessionId);
    this.flush(live);
    if (this.info(sessionId).archived)
      throw new SessionError("Unarchive the session to continue it.");
    if (live.starting || activeTurn(live.state)) {
      if (delivery === "steer" && !live.starting) {
        try {
          await this.options.harness.steer(sessionId, input);
          return { queued: false };
        } catch {
          // The turn ended first: the prompt waits its turn like any other.
        }
      }
      const queued: QueuedMessage = { id: `q${++this.queueIds}`, ...input };
      this.apply(live, { type: "queue.updated", sessionId, queue: [...live.state.queue, queued] });
      return { queued: true };
    }
    await this.startTurn(live, input);
    return { queued: false };
  }

  unqueue(sessionId: string, id: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.apply(live, {
      type: "queue.updated",
      sessionId,
      queue: live.state.queue.filter((queued) => queued.id !== id),
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.options.harness.interrupt(sessionId);
  }

  respondApproval(approvalId: string, response: ApprovalResponse): void {
    this.options.harness.respondApproval(approvalId, response);
  }

  async compact(sessionId: string): Promise<void> {
    await this.ensureLive(sessionId);
    await this.options.harness.compactSession(sessionId);
  }

  async update(params: Params<"session.update">): Promise<SessionInfo> {
    const { sessionId } = params;
    let info = this.info(sessionId);
    const { harness } = this.options;
    if (params.title !== undefined) {
      const title = params.title.trim();
      if (title) await harness.renameSession(sessionId, title);
      info = { ...info, title: title || null };
    }
    if (params.archived !== undefined && params.archived !== info.archived) {
      if (info.status === "running" || info.status === "waiting") {
        throw new SessionError("Stop the session before archiving it.");
      }
      await harness.archiveSession(sessionId, params.archived);
      if (params.archived) this.drop(sessionId);
      info = { ...info, archived: params.archived, status: "stored" };
    }
    if (params.pinned !== undefined) info = { ...info, pinned: params.pinned };
    if (params.unread !== undefined) info = { ...info, unread: params.unread };
    if (params.model !== undefined) info = { ...info, model: params.model };
    if (params.effort !== undefined) info = { ...info, effort: params.effort };
    if (params.mode !== undefined) info = { ...info, mode: params.mode };
    this.options.meta.update((file) => {
      const meta = (file.sessions[sessionId] ??= {});
      if (params.title !== undefined) meta.title = params.title.trim();
      if (params.pinned !== undefined) meta.pinned = params.pinned;
      if (params.unread !== undefined) meta.unread = params.unread;
      if (params.model !== undefined) meta.model = params.model;
      if (params.effort !== undefined) meta.effort = params.effort;
      if (params.mode !== undefined) meta.mode = params.mode;
    });
    this.setInfo(info);
    return info;
  }

  async remove(sessionId: string, removeWorktree: boolean): Promise<void> {
    const info = this.info(sessionId);
    if (info.status === "running" || info.status === "waiting") {
      throw new SessionError("Stop the session before deleting it.");
    }
    await this.options.harness.deleteSession(sessionId);
    if (removeWorktree && info.worktree) {
      await this.options.git.removeWorktree(info.worktree.repo, info.cwd);
    }
    this.drop(sessionId);
    this.infos.delete(sessionId);
    this.options.meta.update((file) => {
      delete file.sessions[sessionId];
    });
    this.options.publish.removed([sessionId]);
  }

  async fork(sessionId: string, turnId: string | null): Promise<SessionInfo> {
    const source = this.info(sessionId);
    const session = await this.options.harness.forkSession(sessionId, turnId);
    const sourceMeta = this.options.meta.value.sessions[sessionId] ?? {};
    this.options.meta.update((file) => {
      file.sessions[session.id] = {
        mode: source.mode,
        ...(sourceMeta.model ? { model: sourceMeta.model } : {}),
        ...(sourceMeta.effort ? { effort: sourceMeta.effort } : {}),
        ...(source.worktree ? { worktree: source.worktree } : {}),
      };
    });
    const info = this.remember({ ...session, forkedFrom: session.forkedFrom ?? sessionId }, false);
    this.options.publish.sessions([info]);
    return info;
  }

  /** The owner looked at it: nothing in it is news any more. */
  markRead(sessionId: string): void {
    const info = this.infos.get(sessionId);
    if (!info?.unread) return;
    this.options.meta.update((file) => {
      const meta = file.sessions[sessionId];
      if (meta) delete meta.unread;
    });
    this.setInfo({ ...info, unread: false });
  }

  // Inside

  private newLive(state: SessionState, usageBaseline: boolean): Live {
    return {
      state: { ...state, epoch: `${this.options.now().toString(36)}-${++this.epochs}` },
      ring: [],
      pending: [],
      cancelFlush: null,
      starting: false,
      usageSeen: null,
      usageBaseline,
      usedAt: this.options.now(),
    };
  }

  /** Joins what the harness says of a session with what the daemon keeps. */
  private remember(session: HarnessSession, archived: boolean): SessionInfo {
    const meta = this.options.meta.value.sessions[session.id] ?? {};
    const known = this.infos.get(session.id);
    const live = this.live.get(session.id);
    const info: SessionInfo = {
      id: session.id,
      harness: this.options.harness.name,
      title: meta.title || session.title,
      preview: session.preview || known?.preview || "",
      cwd: session.cwd,
      model: meta.model ?? (session.model || known?.model || ""),
      effort: meta.effort !== undefined ? meta.effort : (session.effort ?? known?.effort ?? null),
      mode: meta.mode ?? this.options.settings().mode,
      status: live ? this.statusOf(live) : "stored",
      branch: meta.worktree?.branch ?? session.branch,
      worktree: meta.worktree ?? null,
      createdAt: session.createdAt,
      updatedAt: Math.max(session.updatedAt, known?.updatedAt ?? 0),
      archived,
      pinned: meta.pinned ?? false,
      unread: meta.unread ?? false,
      forkedFrom: session.forkedFrom,
      scheduleId: meta.scheduleId ?? null,
    };
    this.infos.set(info.id, info);
    if (live) live.state = { ...live.state, info };
    return info;
  }

  private setInfo(info: SessionInfo): void {
    this.infos.set(info.id, info);
    const live = this.live.get(info.id);
    if (live) live.state = { ...live.state, info };
    this.options.publish.sessions([info]);
  }

  private ensureLive(sessionId: string): Promise<Live> {
    const live = this.live.get(sessionId);
    if (live) {
      live.usedAt = this.options.now();
      return Promise.resolve(live);
    }
    let loading = this.loading.get(sessionId);
    if (!loading) {
      loading = this.load(sessionId).finally(() => this.loading.delete(sessionId));
      this.loading.set(sessionId, loading);
    }
    return loading;
  }

  private async load(sessionId: string): Promise<Live> {
    const meta = this.options.meta.value.sessions[sessionId] ?? {};
    const known = this.infos.get(sessionId);
    const loaded = await this.options.harness.loadSession(sessionId, {
      mode: meta.mode ?? known?.mode ?? this.options.settings().mode,
      ...(meta.model ? { model: meta.model } : {}),
    });
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const info = this.remember(loaded.session, known?.archived ?? false);
    const state = initialSessionState(info);
    // A turn the history left running was cut off: nothing will finish it.
    state.turns = loaded.turns.map((turn) =>
      turn.status === "running" ? { ...turn, status: "interrupted" } : turn,
    );
    state.usage = loaded.usage;
    const live = this.newLive(state, true);
    this.live.set(sessionId, live);
    this.setInfo({ ...info, status: this.statusOf(live) });
    this.evict();
    return live;
  }

  /** Lets go of the sessions nobody has used for longest, past a limit. */
  private evict(): void {
    if (this.live.size <= MAX_LIVE) return;
    const idle = [...this.live.entries()]
      .filter(
        ([id, live]) =>
          this.statusOf(live) !== "running" &&
          this.statusOf(live) !== "waiting" &&
          this.options.viewers(id) === 0,
      )
      .toSorted((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [id] of idle.slice(0, this.live.size - MAX_LIVE)) {
      this.drop(id);
      const info = this.infos.get(id);
      if (info) this.setInfo({ ...info, status: "stored" });
    }
  }

  private drop(sessionId: string): void {
    const live = this.live.get(sessionId);
    live?.cancelFlush?.();
    this.live.delete(sessionId);
  }

  private statusOf(live: Live): SessionStatus {
    if (live.starting || activeTurn(live.state)) {
      return live.state.approvals.length ? "waiting" : "running";
    }
    return live.state.turns.at(-1)?.status === "failed" ? "error" : "idle";
  }

  private async startTurn(live: Live, input: PromptInput): Promise<void> {
    const info = live.state.info;
    live.starting = true;
    this.syncStatus(live);
    try {
      await this.options.harness.send(info.id, input, {
        mode: info.mode,
        ...(info.model ? { model: info.model } : {}),
        ...(info.effort ? { effort: info.effort } : {}),
      });
    } catch (error) {
      live.starting = false;
      this.apply(live, {
        type: "notice",
        sessionId: info.id,
        level: "error",
        message: `The prompt could not be sent: ${message(error)}`,
      });
      throw error;
    }
  }

  private handle(event: HarnessEvent): void {
    if (event.type === "harness.exited") {
      for (const live of this.live.values()) {
        const turn = activeTurn(live.state);
        live.starting = false;
        if (turn) {
          this.apply(live, {
            type: "turn.completed",
            sessionId: live.state.info.id,
            turnId: turn.id,
            status: "failed",
            error: `${event.message}. It starts again with your next message.`,
            durationMs: null,
          });
        }
      }
      return;
    }
    if (event.type === "session.changed") {
      const info = this.infos.get(event.sessionId);
      if (!info) return;
      const meta = this.options.meta.value.sessions[info.id];
      const title = event.patch.title;
      this.setInfo({
        ...info,
        ...(title !== undefined && !meta?.title ? { title } : {}),
      });
      return;
    }
    // The connector's news is the daemon's to pass on, not any session's.
    if (event.type === "mcp.changed") return;
    const live = this.live.get(event.sessionId);
    if (!live) return;
    live.pending.push(event);
    if (event.type === "item.delta") {
      live.cancelFlush ??= this.options.schedule(() => this.flush(live), DELTA_FLUSH_MS);
    } else {
      this.flush(live);
    }
  }

  private apply(live: Live, event: SessionEvent): void {
    live.pending.push(event);
    this.flush(live);
  }

  /** Folds what has arrived into the state and sends it on as one frame. */
  private flush(live: Live): void {
    live.cancelFlush?.();
    live.cancelFlush = null;
    if (!live.pending.length) return;
    const events = coalesceEvents(live.pending);
    live.pending = [];
    let state = live.state;
    for (const event of events) state = reduceSession(state, event);
    state = { ...state, seq: state.seq + 1 };
    live.state = state;
    const frame: EventFrame = { sessionId: state.info.id, seq: state.seq, events };
    live.ring.push(frame);
    if (live.ring.length > RING_FRAMES) live.ring.splice(0, live.ring.length - RING_FRAMES);
    this.options.publish.frame(frame);
    for (const event of events) this.after(live, event);
    this.syncStatus(live);
  }

  private after(live: Live, event: SessionEvent): void {
    const info = live.state.info;
    switch (event.type) {
      case "turn.started":
        live.starting = false;
        break;
      case "item.started":
        if (event.item.kind === "userMessage" && !info.preview) {
          this.setInfo({ ...info, preview: event.item.text.slice(0, 200) });
        }
        break;
      case "usage.updated": {
        const total = event.usage.total;
        if (!live.usageBaseline) {
          this.options.publish.usage(this.options.usage.add(tokenDelta(live.usageSeen, total), 0));
        }
        live.usageBaseline = false;
        live.usageSeen = total;
        break;
      }
      case "turn.completed":
        this.finished(live, event.status === "completed");
        break;
      default:
    }
  }

  private finished(live: Live, completed: boolean): void {
    const info = live.state.info;
    live.starting = false;
    this.options.publish.usage(this.options.usage.add(ZERO_TOKENS, 1));
    const unread = this.options.viewers(info.id) === 0;
    if (unread) {
      this.options.meta.update((file) => {
        (file.sessions[info.id] ??= {}).unread = true;
      });
    }
    this.setInfo({ ...info, updatedAt: this.options.now(), unread: info.unread || unread });
    const [next, ...rest] = live.state.queue;
    if (!next) return;
    if (!completed) {
      // A stopped turn sends nothing more by itself: clients take the queue back.
      this.apply(live, { type: "queue.updated", sessionId: info.id, queue: [] });
      return;
    }
    this.apply(live, { type: "queue.updated", sessionId: info.id, queue: rest });
    this.startTurn(live, { text: next.text, images: next.images }).catch(() => {
      // startTurn already told the session why.
    });
  }

  private syncStatus(live: Live): void {
    const status = this.statusOf(live);
    const info = live.state.info;
    if (info.status !== status) this.setInfo({ ...info, status });
  }
}
