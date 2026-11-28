import {
  type AgentContext,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { ModelInfo, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { effortOptions, sanitizeModels } from "./config-options.ts";
import type { SdkContent } from "./content.ts";
import { askContext } from "./context.ts";
import { announceCommands, announceConfigOptions, aside } from "./events.ts";
import { askingOptions } from "./permissions.ts";
import { spawn } from "./process.ts";
import { scheduledBy, scheduleHooks } from "./schedules.ts";
import {
  type AdapterConfig,
  type Live,
  newTurn,
  notify,
  type QueryFn,
  type SessionState,
  type Turn,
  tell,
} from "./session.ts";
import { type StopReason, stopReasonOf } from "./translate.ts";
import { PlanUsage, withContext } from "./usage.ts";
import { worktreeHooks } from "./worktree-hooks.ts";

/**
 * Whether a message is the main agent beginning a message of its own: the start of one, which is what a turn that
 * nobody prompted opens with. Not what a process says between turns (modes, commands, task news), not the tail of
 * a turn that has ended, and not a sub-agent's talk (`parent_tool_use_id`).
 */
const speaksAloneOf = (message: SDKMessage): boolean =>
  message.type === "stream_event" &&
  (message.event as { type?: string }).type === "message_start" &&
  !(message as { parent_tool_use_id?: string | null }).parent_tool_use_id;

/**
 * The sessions of an adapter, their Claude processes and their turns. A session has one Claude process for as long as
 * it is in use: prompts are pushed into its input stream, so a turn after the first does not pay for a start (the
 * first costs about a second and a half; the next ones, nothing).
 *
 * That is memory held per open session (about 230 MB), so a process that has been idle for `idleMs` is let go, and
 * the next prompt starts one again with `resume`. A process that dies does the same. Decision 0007.
 *
 * What is ACP stays in `agent.ts`: this is told what a request asks and does it.
 */
export class Lifecycle {
  readonly sessions = new Map<string, SessionState>();
  /** Latest models discovered from `query.initializationResult().models`, reused across sessions in this adapter. */
  models: ModelInfo[] | undefined;
  /** Whether the client said, in `initialize`, that it can answer a form. One client per adapter. */
  canElicit = false;
  readonly planUsage = new PlanUsage();
  readonly cancelGraceMs: number;
  /** Sessions whose process was started ahead of a prompt and has had none yet, oldest first. */
  readonly #warm = new Set<SessionState>();
  readonly #idleMs: number;
  readonly #config: AdapterConfig;
  readonly #runQuery: QueryFn;

  constructor(config: AdapterConfig, runQuery: QueryFn) {
    this.#config = config;
    this.#runQuery = runQuery;
    this.#idleMs = config.idleMs ?? 300_000;
    this.cancelGraceMs = config.cancelGraceMs ?? 3_000;
  }

  require(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new RequestError(-32002, "Session not found", { sessionId });
    }
    return session;
  }

  /** A compaction that did not finish because its process went: it is over, and says so. */
  #endCompaction(session: SessionState) {
    const compactionId = session.compaction;
    if (compactionId === undefined) return;
    session.compaction = undefined;
    session.compacted = undefined;
    tell(session, {
      sessionUpdate: "compaction_update",
      compactionId,
      status: "cancelled",
    } as SessionUpdate);
  }

  /** Sub-agents that were running when their process went are over, and clients are told. */
  #endSubagents(session: SessionState) {
    // Their calls end before they do: a client is told of a sub-agent's end once there is nothing of it left running.
    const calls = session.transcripts.endAll();
    const ended = [...session.subagents.endAll(), ...session.tasks.endAll()];
    for (const { childId, updates } of calls)
      for (const update of updates) tell(session, update, childId);
    for (const update of ended) tell(session, update);
  }

  /** Tells clients what is set to wake the session, when it is not what they were last told (docs/protocol.md §9). */
  #tellSchedules(session: SessionState) {
    const update = session.schedules.update(Date.now());
    if (update !== undefined) tell(session, update as unknown as SessionUpdate);
  }

  /** The process is gone: what it was, compaction, sub-agents and tasks, ends, and what it held sleeps. */
  #gone(session: SessionState) {
    this.#endCompaction(session);
    this.#endSubagents(session);
    // What it held fires only if the session is used again before it is due.
    if (session.schedules.sleeping(true)) this.#tellSchedules(session);
  }

  /** Lets the session's process go: gracefully, or at once. The next prompt starts another. */
  release(session: SessionState, hard: boolean) {
    const live = session.live;
    if (live === undefined) return;
    this.#gone(session);
    this.#warm.delete(session);
    session.live = undefined;
    clearTimeout(live.idle);
    live.end();
    if (hard) live.abort.abort();
    else setTimeout(() => live.abort.abort(), 2_000).unref?.();
  }

  scheduleIdle(session: SessionState) {
    const live = session.live;
    if (!live || session.turn) return;
    clearTimeout(live.idle);
    // Background work keeps the process: a sub-agent, or a command or watcher it runs (killed with it otherwise).
    if (session.subagents.hasBackground || session.tasks.hasRunning) return;
    // So does a cron or wakeup due within the hour: it lives in the process, and one missed while the process is
    // gone never fires (CYCL-145). Asked again when the time is up, so the hour counts from then.
    live.idle = setTimeout(
      () =>
        session.schedules.dueWithin(Date.now())
          ? this.scheduleIdle(session)
          : this.release(session, false),
      this.#idleMs,
    );
    live.idle.unref?.();
  }

  /**
   * Whether Claude has this session on disk, so that the next process resumes it (it has the id) instead of
   * starting it (it would refuse an id it already knows, or has none to resume). Claude writes the session
   * when it takes the first prompt, not when Cycle makes the session: one that has had no prompt has nothing to
   * resume. If it should have a record (a turn was answered) and has none, the history is lost, and that is said
   * rather than a new conversation begun under the old name. Where there is no way to look (no config
   * directory given to Claude), or looking fails, the session is taken to be there, as it was before.
   */
  async recordOf(sessionId: string, cwd: string, hadTurn: boolean): Promise<boolean> {
    const sessionInfo = this.#config.sessionInfo;
    if (sessionInfo === undefined) return true;
    let found: boolean;
    try {
      found = (await sessionInfo(sessionId, cwd)) !== undefined;
    } catch {
      return true;
    }
    if (found) return true;
    if (hadTurn) {
      throw new RequestError(
        -32603,
        "Claude has no record of this session any more: its history can be read, but it cannot be continued",
        { sessionId },
      );
    }
    return false;
  }

  /** Tells the client the title Claude gave the session, once per change. Never throws. */
  async #announceTitle(client: AgentContext, session: SessionState) {
    const sessionInfo = this.#config.sessionInfo;
    if (sessionInfo === undefined) return;
    try {
      const info = await sessionInfo(session.id, session.cwd);
      if (info === undefined) return;
      // `summary` falls back to the first prompt when Claude has not given the session a title.
      const generated = info.summary !== info.firstPrompt ? info.summary : undefined;
      const title = info.customTitle ?? generated;
      if (title === undefined || title === "" || title === session.title) return;
      session.title = title;
      await notify(client, session.id, {
        sessionUpdate: "session_info_update",
        title,
      } as SessionUpdate);
    } catch {
      // No title is not a failure.
    }
  }

  /** Ends the turn that is running, once: the usage, then the idle state that tells clients it is over. */
  async finish(
    client: AgentContext,
    session: SessionState,
    turn: Turn,
    stop: StopReason,
    usage?: SessionUpdate,
  ) {
    if (turn.done) return;
    turn.done = true;
    clearTimeout(turn.killTimer);
    if (session.turn === turn) session.turn = undefined;
    this.scheduleIdle(session);
    try {
      for (const update of turn.translator.unfinished()) await notify(client, session.id, update);
      if (usage !== undefined && !turn.cancelled) {
        const size = (usage as { size?: unknown }).size;
        if (typeof size === "number") session.contextSize = size;
        await notify(client, session.id, usage);
      }
      await notify(client, session.id, {
        sessionUpdate: "state_update",
        state: "idle",
        ...(turn.cancelled ? { stopReason: "cancelled" } : stop),
      } as SessionUpdate);
    } catch {
      // The connection is gone: there is no one to tell.
    }
    if (!turn.cancelled) void this.#announceTitle(client, session);
  }

  /** Starts a process for the session. Its messages go to whatever turn is running. */
  start(client: AgentContext, session: SessionState): Live {
    session.client = client;
    // A new process sets again what its session had set and is not yet due.
    if (session.schedules.sleeping(false)) this.#tellSchedules(session);
    const live = spawn(this.#config, this.#runQuery, session, {
      ...askingOptions({ client, session, canElicit: () => this.canElicit }),
      hooks: {
        ...scheduleHooks(session.schedules, () => this.#tellSchedules(session)),
        ...worktreeHooks(client, session),
      },
    });
    // A window is this process's word: one from before is not reused for a usage between turns.
    session.contextSize = undefined;
    void this.#discover(client, session, live);
    void this.#read(client, session, live);
    return live;
  }

  /** Starts a process ahead of a first prompt, so what it can say (the slash commands) is known before anything is typed. */
  warmStart(client: AgentContext, session: SessionState, maxWarm: number) {
    session.live = this.start(client, session);
    // Not without end: a client that makes many sessions does not get that many processes.
    this.#warm.add(session);
    for (const old of this.#warm) {
      if (this.#warm.size <= maxWarm) break;
      this.release(old, false);
    }
    // Not used soon: let it go, as any idle process is.
    this.scheduleIdle(session);
  }

  /** Commands and live model catalog from the process's initialization response (with independent fallbacks). */
  async #discover(client: AgentContext, session: SessionState, live: Live) {
    const query = live.query;
    let init: Awaited<ReturnType<Query["initializationResult"]>> | undefined;
    if (typeof query.initializationResult === "function") {
      try {
        init = await query.initializationResult();
      } catch {
        // Fall back to individual queries below.
      }
    }
    if (session.live !== live) return;

    let commands = init?.commands;
    if (commands === undefined) {
      try {
        commands = await query.supportedCommands();
      } catch {
        commands = undefined;
      }
    }
    if (session.live === live && Array.isArray(commands) && commands.length > 0) {
      await announceCommands(client, session, commands).catch(() => undefined);
    }
    if (session.live !== live) return;

    let rawModels = init?.models;
    if (rawModels === undefined && typeof query.supportedModels === "function") {
      try {
        rawModels = await query.supportedModels();
      } catch {
        rawModels = undefined;
      }
    }
    const models = sanitizeModels(rawModels);
    if (session.live === live && models !== undefined) {
      this.models = models;
      this.reconcileEffort(session);
      await announceConfigOptions(client, session, this.models).catch(() => undefined);
    }
  }

  /** One loop for the life of the process. Whatever turn is running owns what comes out. */
  async #read(client: AgentContext, session: SessionState, live: Live) {
    let failure: unknown;
    try {
      for await (const message of live.query as AsyncIterable<SDKMessage>) {
        if (session.live !== live) continue; // let go: nothing it says matters now
        await this.#take(client, session, live, message);
      }
    } catch (error) {
      failure = error;
    }
    // The process is gone, whatever the reason. A turn that was waiting on it ends here.
    if (session.live === live) {
      session.live = undefined;
      this.#gone(session);
    }
    clearTimeout(live.idle);
    // Only a turn that was running on this process ends with it: an exit that comes late, after
    // another process has taken over the session, says nothing of that one's turn.
    const turn = session.turn;
    if (turn !== undefined && !turn.done && turn.process === live) {
      await this.finish(
        client,
        session,
        turn,
        turn.cancelled
          ? { stopReason: "cancelled" }
          : {
              stopReason: "error",
              error: {
                code: -32603,
                message:
                  failure instanceof Error
                    ? failure.message
                    : "The Claude process ended before the turn did",
              },
            },
      );
    }
  }

  /** One message of the process: to the session, to a sub-agent's conversation, or to the turn that is running. */
  async #take(client: AgentContext, session: SessionState, live: Live, message: SDKMessage) {
    if (scheduledBy(session.schedules, message)) this.#tellSchedules(session);
    // A turn that went through means the session is on disk, whenever the process said hello.
    if (message.type === "result" && (message as { subtype?: string }).subtype === "success") {
      session.started = true;
    }
    // Only once there is a prompt: a process started ahead of one has made no session on disk to resume.
    if (message.type === "system" && message.subtype === "init" && session.turn !== undefined) {
      session.started = true;
    }
    await aside(this, client, session, message).catch(() => undefined);
    // A sub-agent's own talk is its session's, turn or no turn: a background one goes on after the turn ends.
    // Only once it was announced (ACP announces a child before anything of it); before that it is dropped.
    const from = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    if (from) {
      const child = session.subagents.childOf(from);
      if (child === undefined) return;
      const servers = Object.keys(session.setup.mcpServers);
      for (const update of session.transcripts.feed(child, message, servers)) {
        const call = update as { toolCallId?: unknown; name?: unknown };
        if (typeof call.toolCallId === "string" && typeof call.name === "string")
          session.tasks.noteCall(call.toolCallId, call.name);
        await notify(client, child, update).catch(() => undefined);
      }
      return;
    }
    let turn = session.turn;
    if ((turn === undefined || turn.done) && speaksAloneOf(message)) {
      // Claude began on its own (a background task finished and woke it): there is no prompt, but
      // there is a turn to show, from its first words to its result. It exists before anything is
      // awaited, so a prompt or a cancel that arrives meanwhile finds it.
      turn = this.#beginOwnTurn(session, live);
      await notify(client, session.id, {
        sessionUpdate: "state_update",
        state: "running",
      } as SessionUpdate).catch(() => undefined);
    }
    if (turn === undefined || turn.done) return;
    for (const update of turn.translator.feed(message)) {
      const call = update as { toolCallId?: unknown; name?: unknown };
      if (typeof call.toolCallId === "string" && typeof call.name === "string")
        session.tasks.noteCall(call.toolCallId, call.name);
      // The turn can end while this waits (a cancel that ran out of time): nothing more is its.
      if (turn.done) break;
      await notify(client, session.id, update);
    }
    if (message.type === "result") await this.#result(client, session, live, turn, message);
  }

  /** A result of the turn's: its end, unless what was put into it is still to be answered. */
  async #result(
    client: AgentContext,
    session: SessionState,
    live: Live,
    turn: Turn,
    message: SDKMessage,
  ) {
    // What was put into the turn and not taken before it ended is Claude's next to answer,
    // in the same process: the turn goes on until that is answered too.
    // A result that does not say what it took (the SDK leaves it out of failed ones) says
    // nothing about them either: the turn ends, and the process goes with them below.
    const taken = (message as { user_message_uuids?: string[] }).user_message_uuids;
    if (taken !== undefined) for (const id of taken) turn.steers.delete(id);
    if (taken !== undefined && turn.steers.size > 0 && !turn.cancelled) return;
    let usage = turn.translator.usageOf(message);
    // What the window holds, asked while the turn is still this one's, so nothing of a next turn comes
    // before its end. Not for a turn whose usage is not told (stopped) or whose process is going.
    if (usage !== undefined && !turn.cancelled && turn.steers.size === 0 && session.live === live) {
      const context = await askContext(live.query);
      // Put into the turn while that was asked: Claude's next to answer, in this process, as above.
      if (taken !== undefined && turn.steers.size > 0 && !turn.cancelled) return;
      usage = withContext(usage, context, session.contextSize);
    }
    // A turn that ends with something put into it still waiting (stopped, or unknown): Claude
    // would answer it afterwards, with no turn to show it in. The process goes before it can begin
    // that; the next prompt starts another, which resumes the session.
    if (turn.steers.size > 0) this.release(session, true);
    await this.finish(client, session, turn, stopReasonOf(message), usage);
  }

  /** A turn nobody prompted: its process is already running it. */
  #beginOwnTurn(session: SessionState, live: Live): Turn {
    clearTimeout(live.idle);
    this.#warm.delete(session); // it is at work: not one held ahead of a prompt
    const turn = newTurn(session, live);
    session.turn = turn;
    return turn;
  }

  /** Puts the turn's prompt into the session's process, starting one if there is none. */
  async runTurn(
    client: AgentContext,
    session: SessionState,
    turn: Turn,
    content: string | SdkContent[],
    messageId: string,
  ) {
    // A cancel can arrive before there is a process: then there is nothing to interrupt.
    if (turn.cancelled) return this.finish(client, session, turn, { stopReason: "cancelled" });
    try {
      this.#warm.delete(session); // it has its prompt
      const live = session.live ?? this.start(client, session);
      session.live = live;
      clearTimeout(live.idle);
      turn.process = live;
      live.push(content, messageId);
      turn.pushed = true;
    } catch (error) {
      await this.finish(client, session, turn, {
        stopReason: "error",
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * Cancels the turn that is running. The process stays up: interrupt ends the turn with a result, and the session goes
   * on. If it does not answer in time, it is killed and the next prompt starts another.
   */
  async cancel(client: AgentContext, session: SessionState) {
    const turn = session.turn;
    if (turn === undefined || turn.done) return;
    turn.cancelled = true;
    turn.permissions.abort();
    const live = session.live;
    if (live === undefined) return; // not started yet: runTurn sees the flag
    const kill = () => {
      this.release(session, true);
      void this.finish(client, session, turn, { stopReason: "cancelled" });
    };
    turn.killTimer = setTimeout(kill, this.cancelGraceMs);
    await live.query.interrupt().catch(kill);
  }

  /** The session is closed: its turn is cancelled and its process let go at once. */
  close(session: SessionState) {
    if (session.turn) {
      session.turn.cancelled = true;
      session.turn.permissions.abort();
    }
    this.release(session, true);
    this.sessions.delete(session.id);
  }

  /** Applies a change to a running process; if it cannot, lets the process go so the next one has it. */
  apply(session: SessionState, change: (query: Query) => Promise<unknown>) {
    const live = session.live;
    if (live === undefined) return Promise.resolve();
    return change(live.query).catch(() => this.release(session, true));
  }

  /** Applies the session's current effort override to a live process when the SDK supports flag updates. */
  applyEffort(session: SessionState) {
    const effortLevel = session.effort ?? null;
    this.apply(session, (query) =>
      typeof query.applyFlagSettings === "function"
        ? query.applyFlagSettings({ effortLevel })
        : Promise.resolve(),
    );
  }

  /**
   * Applies the session's advisor to a live process, as its flag settings: `null` takes Cycle's choice away. Turning it on
   * or off keeps the main model's prompt cache. An advisor the API refused for this conversation stays off until a
   * `/clear` or `/compact`, whatever is chosen; Claude Code says nothing of it.
   */
  applyAdvisor(session: SessionState) {
    const advisorModel = session.advisor ?? null;
    this.apply(session, (query) =>
      typeof query.applyFlagSettings === "function"
        ? query.applyFlagSettings({ advisorModel })
        : Promise.resolve(),
    );
  }

  /**
   * Whether suggestions of what to say next are wanted, as the prompt about to run says. A process already running is
   * told through its flag settings: `null` takes Cycle's "no" away, leaving the person's own settings.json to decide.
   */
  wantSuggestions(session: SessionState, wanted: boolean) {
    session.suggestions = wanted;
    const live = session.live;
    if (live === undefined || live.suggestions === wanted) return;
    live.suggestions = wanted;
    // Not worth the process (and the turn about to run on it) if it refuses: one not wanted is dropped in `aside` anyway.
    if (typeof live.query.applyFlagSettings === "function")
      void live.query
        .applyFlagSettings({ promptSuggestionEnabled: wanted ? null : false })
        .catch(() => undefined);
  }

  /** Resets an active effort override if the active model does not support it. */
  reconcileEffort(session: SessionState): boolean {
    if (session.effort === undefined) return false;
    const allowed = effortOptions(session, this.models);
    if (allowed.some((option) => option.value === session.effort)) return false;
    session.effort = undefined;
    this.applyEffort(session);
    return true;
  }
}
