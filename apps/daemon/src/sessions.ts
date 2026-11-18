import {
  type Agents,
  type ApprovalResponse,
  type ContextUsage,
  type DayUsage,
  type Delivery,
  type EventFrame,
  type FileRewind,
  type PromptDocument,
  type HarnessEvent,
  type AgentEvent,
  type AgentSession,
  type Params,
  type PromptInput,
  type QueuedMessage,
  type ReviewTarget,
  type SessionEvent,
  type Session,
  type PermissionMode,
  type SessionState,
  type SessionActivity,
  type SessionStatus,
  type Settings,
  type TokenCount,
  type TurnOptions,
  type TurnOrigin,
  type WorktreeInfo,
  LEGACY_MODE_PREFIX,
  activeTurn,
  coalesceEvents,
  harnessLabel,
  initialSessionState,
  legacyMode,
  resolveMode,
  reduceSession,
  sameModelFamily,
} from "@cycle/protocol";
import { type Git, defaultBranchName } from "./git.ts";
import type { JsonStore, Delay } from "./store.ts";
import { type UsageLedger, ZERO_TOKENS, tokenDelta } from "./usage.ts";

/**
 * A worktree as it is stored: a daemon from before a worktree had a place of its own kept `repo`,
 * `base` and `branch` only. Its `path` and `origin` are read as `wholeWorktree` says.
 */
export type StoredWorktree = Omit<WorktreeInfo, "path" | "origin"> &
  Partial<Pick<WorktreeInfo, "path" | "origin">>;

/**
 * A stored worktree with every field. Without a `path` it is one of the older kind, at
 * `<legacy>/<repo folder>/<name>` and made as the session was: the root is the first two folders
 * of the session's `cwd` under `legacy`, else the `cwd`.
 */
function wholeWorktree(stored: StoredWorktree, cwd: string, legacy: string): WorktreeInfo {
  const prefix = `${legacy}/`;
  const [repoFolder, name] = cwd.startsWith(prefix) ? cwd.slice(prefix.length).split("/") : [];
  return {
    ...stored,
    path: stored.path ?? (name ? `${legacy}/${repoFolder}/${name}` : cwd),
    origin: stored.origin ?? "owner",
  };
}

/** What the daemon alone keeps about a session, which no harness knows. */
export interface SessionMeta {
  title?: string;
  pinned?: boolean;
  unread?: boolean;
  /**
   * The mode as a daemon from before each agent named its own reads it: one of `LegacyMode`. It is
   * read when there is no `agentMode`, and no longer written, so such a daemon still reads a mode it
   * knows.
   */
  mode?: string;
  /** The session's mode, one its agent offers. */
  agentMode?: PermissionMode;
  model?: string;
  effort?: string | null;
  worktree?: StoredWorktree;
  /** The sandbox its agent runs in, by name. */
  sandbox?: string;
  /** Folders beyond its own its agent may reach. */
  directories?: string[];
  /** The schedule whose run started it. */
  scheduleId?: string;
}

export interface MetaFile {
  sessions: Record<string, SessionMeta>;
}

/**
 * The mode kept for a session: its own, else one kept before each agent named its own, marked to be
 * read by what it meant then, since the same word can be another of an agent's modes now.
 */
export function keptMode(meta: SessionMeta): string | undefined {
  return meta.agentMode ?? (meta.mode === undefined ? undefined : legacyMode(meta.mode));
}

export interface HubOptions {
  harness: Agents;
  meta: JsonStore<MetaFile>;
  settings(): Settings;
  usage: UsageLedger;
  git: Git;
  /** Where older daemons made worktrees: one stored without a `path` was made here. */
  legacyWorktrees: string;
  schedule: Delay;
  now(): number;
  /** Takes a line for the daemon's log. Never a prompt or an answer: ids, names and times. */
  log(line: string): void;
  /** How many clients follow a session now. */
  viewers(sessionId: string): number;
  publish: {
    frame(frame: EventFrame): void;
    sessions(sessions: Session[]): void;
    removed(sessionIds: string[]): void;
    usage(day: DayUsage): void;
  };
}

/** When each step of a turn happened on the daemon's clock, to say where its wait went. */
interface TurnTiming {
  /** The turn it is of, once it has been announced: an earlier turn's end is not this one's. */
  turnId: string | null;
  /** The prompt reached the daemon, or left its queue. */
  asked: number;
  /** The harness took the prompt. */
  accepted: number | null;
  started: number | null;
  /** The first thing the agent did, and what kind of thing. */
  item: { at: number; kind: string } | null;
  /** The first streamed chunk of anything. */
  stream: number | null;
}

interface Live {
  state: SessionState;
  /** The latest frames, for a client that was away briefly. */
  ring: EventFrame[];
  pending: SessionEvent[];
  cancelFlush: (() => void) | null;
  /** A turn was asked for and has not been announced yet. */
  starting: boolean;
  /** The steps of the turn that was asked for last, until it ends. */
  timing: TurnTiming | null;
  /** Who asked for that turn, when not the owner: its announcement is marked with it. */
  origin: TurnOrigin | null;
  /** The agent began a turn of its own while that turn was being asked for. */
  overtaken: boolean;
  /** Who asked for each queued prompt, when not the owner. */
  queuedOrigins: Map<string, TurnOrigin>;
  usageSeen: TokenCount | null;
  /** The next usage report only sets the mark: it counts work done before now. */
  usageBaseline: boolean;
  usedAt: number;
  /**
   * The documents of each queued prompt, by its id. The queue in the state names them only: up to
   * 8 MB each would otherwise go out with every change to the queue and stay in the frames kept for
   * a client that was away.
   */
  documents: Map<string, PromptDocument[]>;
}

/** Streamed text is sent on at most this often, as one frame. */
const DELTA_FLUSH_MS = 16;
const RING_FRAMES = 512;
const MAX_LIVE = 32;
const MAX_TAG = 40;

export class SessionError extends Error {}

/** What a session says of its state when the daemon does not hold it. */
const STORED = { status: "stored", activity: "idle", loaded: false, failed: false } as const;

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
  private readonly infos = new Map<string, Session>();
  private readonly live = new Map<string, Live>();
  private readonly loading = new Map<string, Promise<Live>>();
  private queueIds = 0;
  private epochs = 0;

  constructor(options: HubOptions) {
    this.options = options;
    options.harness.onEvent((event) => this.handle(event));
  }

  // Reading

  async list(archived: boolean): Promise<Session[]> {
    const stored = await this.options.harness.listSessions({ archived });
    const listed = new Set<string>();
    const out: Session[] = [];
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

  info(sessionId: string): Session {
    const info = this.infos.get(sessionId);
    if (!info) throw new SessionError(`unknown session: ${sessionId}`);
    return info;
  }

  /** Whether a session is in the middle of a turn. A session nobody knows is not. */
  working(sessionId: string): boolean {
    const activity = this.infos.get(sessionId)?.activity;
    return activity !== undefined && activity !== "idle";
  }

  /** Whether any session is in the middle of a turn in this folder. */
  busyIn(cwd: string): boolean {
    for (const info of this.infos.values()) {
      if (info.cwd === cwd && info.activity !== "idle") return true;
    }
    return false;
  }

  /** Folders sessions run in, which the owner may read files under. */
  folders(): string[] {
    const out = new Set<string>();
    for (const info of this.infos.values()) {
      out.add(info.cwd);
      if (info.worktree) out.add(info.worktree.repo);
      for (const directory of info.directories) out.add(directory);
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
  async create(params: Params<"session.create">, scheduleId?: string): Promise<Session> {
    const { harness, git, now } = this.options;
    const settings = this.options.settings();
    let cwd = params.cwd;
    let worktree: WorktreeInfo | undefined;
    if (params.sandbox && params.worktree) {
      // A worktree's history is in its repository's folder, which its sandbox would not hold.
      throw new SessionError("A session in a sandbox works in the folder itself, not a worktree.");
    }
    const directories = [...new Set(params.directories ?? [])].filter((path) => path !== cwd);
    if (directories.length && params.sandbox) {
      // A sandbox holds the session's folder alone.
      throw new SessionError("A session in a sandbox reaches its own folder only.");
    }
    if (params.worktree) {
      const made = await git.addWorktree({
        cwd,
        branch: params.worktree.branch?.trim() || defaultBranchName(now()),
        ...(params.worktree.base ? { base: params.worktree.base } : {}),
      });
      cwd = made.cwd;
      worktree = { ...made.worktree, origin: "owner" };
    }
    const model = params.model ?? settings.model ?? undefined;
    const effort = params.effort ?? settings.effort ?? undefined;
    const agent = await this.agentFor(model);
    const mode = this.modeFor(
      agent,
      params.mode ?? settings.modes[agent],
      params.mode !== undefined,
    );
    let session: AgentSession;
    try {
      session = await harness.createSession({
        cwd,
        mode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(params.sandbox ? { sandboxed: params.sandbox } : {}),
        ...(directories.length ? { directories } : {}),
      });
    } catch (error) {
      // A session that never started leaves no worktree behind.
      if (worktree) await git.removeWorktree(worktree.repo, worktree.path).catch(() => {});
      throw error;
    }
    this.options.meta.update((file) => {
      file.sessions[session.id] = {
        agentMode: mode,
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(worktree ? { worktree } : {}),
        ...(session.sandbox ? { sandbox: session.sandbox } : {}),
        ...(directories.length ? { directories } : {}),
        ...(scheduleId ? { scheduleId } : {}),
      };
    });
    const info: Session = {
      ...this.remember(session, false),
      status: "idle",
      activity: "idle",
      loaded: true,
      failed: false,
    };
    this.live.set(session.id, this.newLive(initialSessionState(info), false));
    this.setInfo(info);
    return info;
  }

  /** `origin` marks a turn the owner did not ask for here, as a schedule's. */
  async send(
    sessionId: string,
    input: PromptInput,
    delivery: Delivery,
    origin?: TurnOrigin,
  ): Promise<{ queued: boolean; id?: string }> {
    const asked = this.options.now();
    const live = await this.ensureLive(sessionId);
    this.flush(live);
    if (this.info(sessionId).archived)
      throw new SessionError("Unarchive the session to continue it.");
    if (input.documents?.length) {
      const takes = (await this.options.harness.capabilitiesOf(sessionId)).attachments;
      const refused = input.documents.find((document) => !takes.includes(document.kind));
      if (refused) {
        throw new SessionError(
          `${harnessLabel(live.state.info.harness)} cannot read ${refused.kind === "pdf" ? "a PDF" : "a text file"} attached to a prompt.`,
        );
      }
    }
    if (live.starting || activeTurn(live.state)) {
      if (delivery === "steer" && !live.starting) {
        try {
          await this.options.harness.steer(sessionId, input);
          return { queued: false };
        } catch {
          // The turn ended first: the prompt waits its turn like any other.
        }
      }
      return { queued: true, id: this.enqueue(live, input, origin) };
    }
    let id: string | null = null;
    await this.startTurn(
      live,
      (options) => this.options.harness.send(sessionId, input, options),
      origin,
      () => {
        id = this.enqueue(live, input, origin);
      },
      asked,
    );
    return id ? { queued: true, id } : { queued: false };
  }

  /**
   * Puts a prompt in the queue, at its end or, when it was already next, at its front, and answers
   * its id. The page is told its documents by name: the daemon holds them until it is sent.
   */
  private enqueue(live: Live, input: PromptInput, origin?: TurnOrigin, front = false): string {
    const id = `q${++this.queueIds}`;
    const { documents, ...rest } = input;
    const queued: QueuedMessage = {
      id,
      ...rest,
      ...(documents?.length
        ? { documents: documents.map(({ kind, name }) => ({ kind, name })) }
        : {}),
    };
    if (documents?.length) live.documents.set(id, documents);
    if (origin) live.queuedOrigins.set(id, origin);
    const queue = live.state.queue;
    this.apply(live, {
      type: "queue.updated",
      sessionId: live.state.info.id,
      queue: front ? [queued, ...queue] : [...queue, queued],
    });
    return id;
  }

  unqueue(sessionId: string, id: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.queuedOrigins.delete(id);
    live.documents.delete(id);
    this.apply(live, {
      type: "queue.updated",
      sessionId,
      queue: live.state.queue.filter((queued) => queued.id !== id),
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.options.harness.interrupt(sessionId);
  }

  /** Stops one task of the session's. Its end comes as the harness's news, as any other. */
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const stop = this.options.harness.stopTask;
    if (!stop) throw new SessionError("This session has no tasks to stop alone.");
    await stop.call(this.options.harness, sessionId, taskId);
  }

  respondApproval(approvalId: string, response: ApprovalResponse): void {
    this.options.harness.respondApproval(approvalId, response);
  }

  /** Starts a turn that reviews code. It is not queued: it waits for no turn, and none for it. */
  async review(sessionId: string, target: ReviewTarget): Promise<void> {
    const live = await this.ensureLive(sessionId);
    this.flush(live);
    if (this.info(sessionId).archived) {
      throw new SessionError("Unarchive the session to review in it.");
    }
    if (live.starting || activeTurn(live.state)) {
      throw new SessionError("Wait for the turn to finish, or stop it, before a review.");
    }
    await this.startTurn(live, (options) =>
      this.options.harness.review(sessionId, target, options),
    );
  }

  /**
   * Takes the conversation back to before a turn. With `files`, the files the agent changed since go
   * back first, and nothing is taken back when they cannot; else they stay.
   */
  async rewind(sessionId: string, turnId: string, files = false): Promise<void> {
    const live = await this.rewindable(sessionId, turnId);
    if (files) {
      const done = await this.options.harness.rewindFiles(sessionId, turnId, false);
      if (!done.possible) {
        throw new SessionError(done.error ?? "The files could not be put back.");
      }
    }
    let from: string;
    try {
      ({ from } = await this.options.harness.rewindSession(sessionId, turnId));
    } catch (error) {
      if (!files) throw error;
      // The two would no longer agree: the owner must know which half happened.
      throw new SessionError(
        `The files were put back as they were before that turn, but the conversation could not go back: ${message(error)}. Its later turns are still there.`,
      );
    }
    const known = live.state.turns.some((turn) => turn.id === from);
    this.apply(live, {
      type: "turns.rewound",
      sessionId,
      turnId: known ? from : turnId,
    });
    // The agent counts again from the shorter history: its next report only sets the mark.
    live.usageBaseline = true;
  }

  /** What going back before a turn would do to the files. Nothing is changed. */
  async previewRewind(sessionId: string, turnId: string): Promise<FileRewind> {
    await this.rewindable(sessionId, turnId);
    return this.options.harness.rewindFiles(sessionId, turnId, true);
  }

  /**
   * What the session's context holds: its agent's parts when it can tell, else what the latest
   * request read.
   */
  async context(sessionId: string): Promise<ContextUsage | null> {
    const live = await this.ensureLive(sessionId);
    const told = await this.options.harness.readContext(sessionId);
    if (told) return told;
    const usage = live.state.usage;
    return usage ? { tokens: usage.last.total, window: usage.contextWindow, parts: [] } : null;
  }

  async compact(sessionId: string): Promise<void> {
    await this.ensureLive(sessionId);
    await this.options.harness.compactSession(sessionId);
  }

  async update(params: Params<"session.update">): Promise<Session> {
    const { sessionId } = params;
    let info = this.info(sessionId);
    const { harness } = this.options;
    // First: a tag a conversation cannot take refuses the whole change, before any of it is made.
    if (params.tag !== undefined) {
      const tag = params.tag?.trim().slice(0, MAX_TAG) || null;
      await harness.tagSession(sessionId, tag);
      const { tag: _old, ...rest } = info;
      info = tag ? { ...rest, tag } : rest;
    }
    if (params.title !== undefined) {
      const title = params.title.trim();
      if (title) await harness.renameSession(sessionId, title);
      info = { ...info, title: title || null };
    }
    if (params.archived !== undefined && params.archived !== info.archived) {
      if (info.activity !== "idle") {
        throw new SessionError("Stop the session before archiving it.");
      }
      await harness.archiveSession(sessionId, params.archived);
      if (params.archived) this.drop(sessionId);
      // Unarchiving a session opened archived leaves it held, yet reads stored until its next event.
      info = { ...info, archived: params.archived, ...STORED };
    }
    if (params.pinned !== undefined) info = { ...info, pinned: params.pinned };
    if (params.unread !== undefined) info = { ...info, unread: params.unread };
    if (params.model !== undefined && params.model !== info.model) {
      const models = await harness.listModels();
      const from = models.find((model) => model.id === info.model);
      const to = models.find((model) => model.id === params.model);
      if (from && to && !sameModelFamily(from, to)) {
        const began =
          from.harness !== to.harness
            ? harnessLabel(from.harness)
            : from.provider
              ? "a model of your own provider"
              : "one of the agent's own models";
        throw new SessionError(
          `This session began on ${began} and stays with that kind. Start a new session to use ${to.name}.`,
        );
      }
      info = { ...info, model: params.model };
    }
    if (params.effort !== undefined) info = { ...info, effort: params.effort };
    if (params.mode !== undefined) {
      info = { ...info, mode: this.modeFor(info.harness, params.mode, true) };
    }
    const mode = params.mode !== undefined ? info.mode : undefined;
    this.options.meta.update((file) => {
      const meta = (file.sessions[sessionId] ??= {});
      if (params.title !== undefined) meta.title = params.title.trim();
      if (params.pinned !== undefined) meta.pinned = params.pinned;
      if (params.unread !== undefined) meta.unread = params.unread;
      if (params.model !== undefined) meta.model = params.model;
      if (params.effort !== undefined) meta.effort = params.effort;
      if (mode !== undefined) meta.agentMode = mode;
    });
    this.setInfo(info);
    // A running agent takes them in now where it can: a mode that asks less matters mid-turn.
    const moved = {
      ...(mode !== undefined ? { mode } : {}),
      ...(params.model !== undefined ? { model: info.model } : {}),
      ...(params.effort !== undefined ? { effort: params.effort } : {}),
    };
    if (Object.keys(moved).length && this.live.has(sessionId)) {
      await harness.configure(sessionId, moved).catch((error: unknown) => {
        this.notice(sessionId, "warning", `It takes this from its next turn: ${message(error)}`);
      });
    }
    return info;
  }

  async remove(sessionId: string, removeWorktree: boolean): Promise<void> {
    const info = this.info(sessionId);
    if (info.activity !== "idle") {
      throw new SessionError("Stop the session before deleting it.");
    }
    await this.options.harness.deleteSession(sessionId);
    if (removeWorktree && info.worktree) {
      await this.options.git.removeWorktree(info.worktree.repo, info.worktree.path);
    }
    this.drop(sessionId);
    this.infos.delete(sessionId);
    this.options.meta.update((file) => {
      delete file.sessions[sessionId];
    });
    this.options.publish.removed([sessionId]);
  }

  async fork(sessionId: string, turnId: string | null): Promise<Session> {
    const source = this.info(sessionId);
    const session = await this.options.harness.forkSession(sessionId, turnId);
    const sourceMeta = this.options.meta.value.sessions[sessionId] ?? {};
    this.options.meta.update((file) => {
      file.sessions[session.id] = {
        agentMode: source.mode,
        ...(sourceMeta.model ? { model: sourceMeta.model } : {}),
        ...(sourceMeta.effort ? { effort: sourceMeta.effort } : {}),
        ...(source.worktree ? { worktree: source.worktree } : {}),
        ...(source.sandbox ? { sandbox: source.sandbox } : {}),
        ...(source.directories.length ? { directories: source.directories } : {}),
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

  private async rewindable(sessionId: string, turnId: string): Promise<Live> {
    if (this.info(sessionId).archived) {
      throw new SessionError("Unarchive the session to change it.");
    }
    const live = await this.ensureLive(sessionId);
    this.flush(live);
    if (live.starting || activeTurn(live.state)) {
      throw new SessionError("Stop the turn before going back.");
    }
    if (!live.state.turns.some((turn) => turn.id === turnId)) {
      throw new SessionError("That turn is not in this conversation.");
    }
    return live;
  }

  private newLive(state: SessionState, usageBaseline: boolean): Live {
    return {
      state: {
        ...state,
        epoch: `${this.options.now().toString(36)}-${++this.epochs}`,
      },
      ring: [],
      pending: [],
      cancelFlush: null,
      starting: false,
      timing: null,
      origin: null,
      overtaken: false,
      queuedOrigins: new Map(),
      usageSeen: null,
      usageBaseline,
      usedAt: this.options.now(),
      documents: new Map(),
    };
  }

  /** The agent a new session on this model runs on: its model's, or the main one's. */
  async agentFor(model: string | undefined): Promise<string> {
    const { harness } = this.options;
    if (!model) return harness.name;
    const found = (await harness.listModels()).find((each) => each.id === model);
    return found?.harness ?? harness.name;
  }

  /**
   * The mode a value means on an agent: one of its own, a legacy one by what it replaces, else
   * its default. A mode the owner asked for by name that the agent does not offer is refused.
   */
  private modeFor(agent: string, value: string | undefined, strict = false): string {
    const modes = this.options.harness.listModes().filter((mode) => mode.harness === agent);
    const named = value !== undefined && !value.startsWith(LEGACY_MODE_PREFIX);
    if (strict && named && !modes.some((mode) => mode.id === value)) {
      throw new SessionError(`${harnessLabel(agent)} has no mode named ${value}.`);
    }
    return resolveMode(modes, value)?.id ?? value ?? "";
  }

  private notice(sessionId: string, level: "info" | "warning", text: string): void {
    const live = this.live.get(sessionId);
    if (live) this.apply(live, { type: "notice", sessionId, level, message: text });
  }

  /** Joins what the harness says of a session with what the daemon keeps. */
  private remember(session: AgentSession, archived: boolean): Session {
    const meta = this.options.meta.value.sessions[session.id] ?? {};
    const known = this.infos.get(session.id);
    const live = this.live.get(session.id);
    const info: Session = {
      id: session.id,
      harness: session.harness,
      title: meta.title || session.title,
      preview: session.preview || known?.preview || "",
      cwd: session.cwd,
      model: meta.model ?? (session.model || known?.model || ""),
      effort: meta.effort !== undefined ? meta.effort : (session.effort ?? known?.effort ?? null),
      mode: this.modeFor(
        session.harness,
        keptMode(meta) ?? this.options.settings().modes[session.harness],
      ),
      ...(live ? this.activityFields(live) : STORED),
      branch: meta.worktree?.branch ?? session.branch,
      worktree: meta.worktree
        ? wholeWorktree(meta.worktree, session.cwd, this.options.legacyWorktrees)
        : null,
      sandbox: meta.sandbox ?? session.sandbox,
      sandboxCwd: session.sandboxCwd,
      directories: meta.directories ?? [],
      createdAt: session.createdAt,
      updatedAt: Math.max(session.updatedAt, known?.updatedAt ?? 0),
      archived,
      pinned: meta.pinned ?? false,
      unread: meta.unread ?? false,
      forkedFrom: session.forkedFrom,
      ...(session.tag ? { tag: session.tag } : {}),
      scheduleId: meta.scheduleId ?? null,
    };
    this.infos.set(info.id, info);
    if (live) live.state = { ...live.state, info };
    return info;
  }

  private setInfo(info: Session): void {
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
    // The session's mode, where its agent is known before it loads.
    const agent = known?.harness;
    const mode = agent
      ? this.modeFor(agent, keptMode(meta) ?? this.options.settings().modes[agent])
      : undefined;
    const loaded = await this.options.harness.loadSession(sessionId, {
      ...(mode ? { mode } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.sandbox ? { sandbox: meta.sandbox } : {}),
      ...(meta.directories?.length ? { directories: meta.directories } : {}),
    });
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const info = this.remember(loaded.session, known?.archived ?? false);
    // Known only now, its agent is told the mode before anything runs: a compaction too.
    if (!mode) await this.options.harness.configure(sessionId, { mode: info.mode });
    const state = initialSessionState(info);
    // A turn the history left running was cut off: nothing will finish it.
    state.turns = loaded.turns.map((turn) =>
      turn.status === "running" ? { ...turn, status: "interrupted" } : turn,
    );
    state.usage = loaded.usage;
    // Known as it loads, what was used before is the mark; else the next report sets it.
    const live = this.newLive(state, loaded.usage === null);
    live.usageSeen = loaded.usage?.total ?? null;
    this.live.set(sessionId, live);
    this.setInfo({ ...info, ...this.activityFields(live) });
    this.evict();
    return live;
  }

  /** Lets go of the sessions nobody has used for longest, past a limit. */
  private evict(): void {
    if (this.live.size <= MAX_LIVE) return;
    const idle = [...this.live.entries()]
      .filter(([id, live]) => this.activityOf(live) === "idle" && this.options.viewers(id) === 0)
      .toSorted((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [id] of idle.slice(0, this.live.size - MAX_LIVE)) {
      this.drop(id);
      const info = this.infos.get(id);
      if (info) this.setInfo({ ...info, ...STORED });
    }
  }

  private drop(sessionId: string): void {
    const live = this.live.get(sessionId);
    live?.cancelFlush?.();
    this.live.delete(sessionId);
  }

  /** What a session is doing. One still starting counts as running. */
  private activityOf(live: Live): SessionActivity {
    if (live.starting || activeTurn(live.state)) {
      return live.state.approvals.length ? "requires_action" : "running";
    }
    return "idle";
  }

  /** Whether its last turn ended in failure, or its agent exited under it. Not while it works. */
  private failedOf(live: Live): boolean {
    return this.activityOf(live) === "idle" && live.state.turns.at(-1)?.status === "failed";
  }

  private statusOf(live: Live): SessionStatus {
    const activity = this.activityOf(live);
    if (activity === "requires_action") return "waiting";
    if (activity === "running") return "running";
    return this.failedOf(live) ? "error" : "idle";
  }

  /** What a session held in memory says of its state. */
  private activityFields(live: Live): Pick<Session, "status" | "activity" | "loaded" | "failed"> {
    return {
      status: this.statusOf(live),
      activity: this.activityOf(live),
      loaded: true,
      failed: this.failedOf(live),
    };
  }

  /** Starts a turn with the session's mode, model and effort, and says why one did not start. */
  private async startTurn(
    live: Live,
    start: (options: TurnOptions) => Promise<unknown>,
    origin?: TurnOrigin,
    /** Puts what was asked in the queue, when the agent began a turn of its own first. */
    busy?: () => void,
    /** When the prompt reached the daemon, or left its queue. */
    asked = this.options.now(),
  ): Promise<void> {
    const info = live.state.info;
    const timing: TurnTiming = {
      turnId: null,
      asked,
      accepted: null,
      started: null,
      item: null,
      stream: null,
    };
    live.timing = timing;
    live.starting = true;
    live.origin = origin ?? null;
    live.overtaken = false;
    this.syncStatus(live);
    try {
      await start({
        mode: info.mode,
        ...(info.model ? { model: info.model } : {}),
        ...(info.effort ? { effort: info.effort } : {}),
        ...(info.sandbox ? { sandbox: info.sandbox } : {}),
        ...(info.directories.length ? { directories: info.directories } : {}),
      });
      timing.accepted = this.options.now();
    } catch (error) {
      live.starting = false;
      live.origin = null;
      live.timing = null;
      // The agent began a turn of its own while this one was asked for: what was asked waits behind
      // it, or, when that turn already ended, is asked for again.
      if (busy && live.overtaken) {
        live.overtaken = false;
        if (activeTurn(live.state)) {
          busy();
          this.syncStatus(live);
          return;
        }
        return this.startTurn(live, start, origin, busy);
      }
      this.apply(live, {
        type: "notice",
        sessionId: info.id,
        level: "error",
        message: `The turn could not start: ${message(error)}`,
      });
      throw error;
    }
  }

  private handle(event: HarnessEvent): void {
    if (!("sessionId" in event)) return this.agentEvent(event);
    if (event.type === "mode.changed") {
      const info = this.infos.get(event.sessionId);
      const mode = this.options.harness
        .listModes()
        .find((each) => each.harness === info?.harness && each.id === event.mode);
      if (!info || !mode || info.mode === mode.id) return;
      if (mode.dangerous) {
        this.notice(
          info.id,
          "warning",
          `${harnessLabel(info.harness)} moved to ${mode.name}. The session stays in its mode, and its next turn starts in it.`,
        );
        return;
      }
      this.options.meta.update((file) => {
        (file.sessions[info.id] ??= {}).agentMode = mode.id;
      });
      this.setInfo({ ...info, mode: mode.id });
      this.notice(info.id, "info", `${harnessLabel(info.harness)} moved to ${mode.name}.`);
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
    // The commands a prompt may begin with, and its next guess, are the daemon's to pass on.
    if (event.type === "commands.changed" || event.type === "suggestion.changed") return;
    const live = this.live.get(event.sessionId);
    if (!live) return;
    this.mark(live, event);
    live.pending.push(this.marked(live, event));
    if (event.type === "item.delta") {
      live.cancelFlush ??= this.options.schedule(() => this.flush(live), DELTA_FLUSH_MS);
    } else {
      this.flush(live);
    }
  }

  /** What an agent says of itself. The account, the limits and the connector are the daemon's to pass on. */
  private agentEvent(event: AgentEvent): void {
    if (event.type !== "agent.exited") return;
    for (const live of this.live.values()) {
      // Another harness's sessions carry on.
      if (live.state.info.harness !== event.harness) continue;
      const turn = activeTurn(live.state);
      live.starting = false;
      // Its tasks went with it.
      if (live.state.tasks.length > 0) {
        this.apply(live, { type: "tasks.updated", sessionId: live.state.info.id, tasks: [] });
      }
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
  }

  /**
   * The turn asked for here is the next one announced, and takes the origin it was asked with. A
   * turn the agent began by itself says so, and is left as it is.
   */
  private marked(live: Live, event: SessionEvent): SessionEvent {
    if (event.type !== "turn.started") return event;
    if (event.origin) {
      // Not the turn asked for, which is still to come, or is refused and then waits behind it.
      if (live.starting) live.overtaken = true;
      return event;
    }
    const origin = live.starting ? live.origin : null;
    live.origin = null;
    live.starting = false;
    return origin ? { ...event, origin } : event;
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
    const frame: EventFrame = {
      sessionId: state.info.id,
      seq: state.seq,
      events,
    };
    live.ring.push(frame);
    if (live.ring.length > RING_FRAMES) live.ring.splice(0, live.ring.length - RING_FRAMES);
    this.options.publish.frame(frame);
    for (const event of events) this.after(live, event);
    this.syncStatus(live);
  }

  private after(live: Live, event: SessionEvent): void {
    const info = live.state.info;
    switch (event.type) {
      // An agent may announce a prompt whole, with no start before it.
      case "item.started":
      case "item.completed":
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
        // Before the queue's next prompt starts a timing of its own.
        this.report(live, event.turnId, event.status);
        this.finished(live, event.status === "completed");
        break;
      default:
    }
  }

  /** Notes when a step of the running turn first happened, as it arrives and before any batching. */
  private mark(live: Live, event: SessionEvent): void {
    const timing = live.timing;
    if (!timing) return;
    const at = this.options.now();
    if (event.type === "turn.started") {
      // The first turn announced after the ask is the one asked for.
      if (timing.turnId === null) {
        timing.turnId = event.turnId;
        timing.started = at;
      }
      return;
    }
    if (!("turnId" in event) || event.turnId !== timing.turnId) return;
    if (event.type === "item.delta") timing.stream ??= at;
    else if (event.type === "item.started" && event.item.kind !== "userMessage") {
      timing.item ??= { at, kind: event.item.kind };
    }
  }

  /**
   * One line for a turn that ended: how long after the prompt each step came. Ids, the model's name
   * and times only: never what was asked or answered, nor anything that is a secret.
   */
  private report(live: Live, turnId: string, status: string): void {
    const timing = live.timing;
    // The end of a turn stopped just before is not this one's.
    if (!timing || timing.turnId !== turnId) return;
    live.timing = null;
    const info = live.state.info;
    const after = (at: number | null) => (at === null ? "-" : `${at - timing.asked}ms`);
    this.options.log(
      `turn ${info.id} ${status}: model=${info.model || "auto"} effort=${info.effort ?? "auto"} ` +
        `accepted=${after(timing.accepted)} started=${after(timing.started)} ` +
        `item=${after(timing.item?.at ?? null)}${timing.item ? `:${timing.item.kind}` : ""} ` +
        `stream=${after(timing.stream)} done=${after(this.options.now())}`,
    );
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
    this.setInfo({
      ...info,
      updatedAt: this.options.now(),
      unread: info.unread || unread,
    });
    const [next, ...rest] = live.state.queue;
    if (!next) return;
    if (!completed) {
      // A stopped turn sends nothing more by itself: clients take the queue back, and the page that
      // queued a document still holds it.
      live.documents.clear();
      live.queuedOrigins.clear();
      this.apply(live, {
        type: "queue.updated",
        sessionId: info.id,
        queue: [],
      });
      return;
    }
    this.apply(live, {
      type: "queue.updated",
      sessionId: info.id,
      queue: rest,
    });
    const documents = live.documents.get(next.id);
    live.documents.delete(next.id);
    const input = {
      text: next.text,
      images: next.images,
      ...(documents ? { documents } : {}),
    };
    const origin = live.queuedOrigins.get(next.id);
    live.queuedOrigins.delete(next.id);
    this.startTurn(
      live,
      (options) => this.options.harness.send(info.id, input, options),
      origin,
      () => this.enqueue(live, input, origin, true),
    ).catch(() => {
      // startTurn already told the session why.
    });
  }

  private syncStatus(live: Live): void {
    const fields = this.activityFields(live);
    const info = live.state.info;
    if (
      info.status !== fields.status ||
      info.activity !== fields.activity ||
      info.failed !== fields.failed ||
      info.loaded !== fields.loaded
    ) {
      this.setInfo({ ...info, ...fields });
    }
  }
}
