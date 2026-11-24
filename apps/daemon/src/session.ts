import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { META, type QueueEntry, type QueueReason } from "@cycle/protocol";
import type { AgentLink } from "./agent-link.ts";
import type { SessionEntry } from "./index-file.ts";
import type { SessionLog } from "./log/types.ts";

/** A client connection, as far as a session needs to know it. */
export type ClientConn = {
  readonly id: string;
  /** Sends a notification to the client. */
  notify: (method: string, params: unknown) => Promise<void>;
  /** Asks the client something and waits for the answer. */
  request: (method: string, params: unknown) => Promise<unknown>;
  /** Whether the client said, in `initialize`, that it can answer a form (`elicitation/create`). */
  elicitation: boolean;
  ackReturns: boolean;
};

/** A client watching one session: what it is sent comes through the session's log. */
export type Attachment = { conn: ClientConn; ready: boolean; detach: () => void };

/** An agent's request that is waiting for a client's answer. See docs/protocol.md §9. */
export type Pending = {
  requestId: string;
  /** What clients are asked: `session/request_permission` or `elicitation/create`. */
  method: string;
  /** What the agent is told when the request ends without an answer: a cancel, an agent that exits. */
  cancelled: unknown;
  /** The part of a client's answer that settles it. */
  answer: (response: unknown) => unknown;
  /** What clients are asked, with the daemon's session id. */
  params: Record<string, unknown>;
  settled: boolean;
  /** Clients that have been asked, so none is asked twice. */
  asked: Set<Attachment>;
  resolve: (outcome: unknown) => void;
};

/** What a client is told when the history cannot be written: the detail stays in the daemon's own error. */
export const HISTORY_NOT_SAVED = "The session's history cannot be saved, so the turn was stopped";

export type SessionStatus = "running" | "idle" | "requires_action" | "stopped";

/** What the daemon holds for a session while it is loaded. */
export class Session {
  readonly id: string;
  entry: SessionEntry;
  readonly log: SessionLog;
  link: AgentLink | undefined;
  /** The agent's last say on what it is doing. */
  agentState: "running" | "idle" | "requires_action" = "idle";
  /** The turn in progress has a turn end on record (the agent's, or the daemon's for a failure): a second is not written. */
  turnEnded = true;
  readonly pending = new Map<string, Pending>();
  /**
   * Whether the last prompt that said so wants a suggestion of what to say next (`cycle/promptSuggestions`,
   * docs/protocol.md §8). Given to the agent with every prompt; only in memory. Unknown until a prompt says.
   */
  promptSuggestions: boolean | undefined;
  /** Prompts sent while the agent was working, oldest first (docs/protocol.md §8). */
  queue: QueueEntry[] = [];
  /** Why the queue is being held for a client to attach, when it was to be handed back and none was there. */
  heldReason: QueueReason | undefined;
  readonly returns = new Map<
    string,
    { returned: QueueEntry[]; reason: QueueReason; durable: boolean }
  >();
  returnOwner: { conn: ClientConn; id: string; acknowledging: boolean } | undefined;
  readonly attachments = new Set<Attachment>();
  #requests = 0;
  /**
   * True while the agent is being asked to resume the session. ACP v2 has it send its current
   * state first; that is a handshake, not history, and is not logged.
   */
  resuming = false;
  /**
   * How many stops have come in while the agent was still starting. A prompt that was waiting for
   * the agent compares it before and after: a stop in between means it is not to be handed over.
   */
  startingCancels = 0;
  /**
   * How many prompts are being made ready (a mention of another session read into it) before they are handed over. A
   * stop in that time has no turn to stop either, so it counts in `startingCancels` the same way.
   */
  preparing = 0;
  /**
   * The sub-agents the agent has announced and not ended, by id, and whether each runs in the
   * background. In memory only: when the agent process goes, so do they.
   */
  readonly #subagents = new Map<string, boolean>();
  /**
   * The tasks that are not sub-agents (`_cycle/task_update`: a command, a watcher) the agent said are running. In memory
   * only, like the sub-agents: they are the agent process's, and go with it.
   */
  readonly #tasks = new Set<string>();
  /**
   * Every sub-agent the agent has announced (`subagent_update`), ended or not: only those may speak as a child session
   * (docs/protocol.md §9). In memory only; a new process announces its own.
   */
  readonly #children = new Set<string>();
  /** The sub-agents the agent said can be stopped alone (`capabilities.cancel`, CYCL-143). */
  readonly #stoppable = new Set<string>();
  readonly unknownBackground = new Map<
    string,
    { toolCallId: string | undefined; dismissing?: boolean }
  >();
  /**
   * Why the session's history can no longer be written, once a write has failed. A turn that
   * cannot be saved is not run on: the session refuses new ones, and its agent is cancelled.
   */
  historyError: string | undefined;
  /**
   * The last `available_commands_update` given to `#write` (as `commandsKey`), written or not, so
   * one that says the same again is not written. Undefined until the first one comes in this run;
   * the log knows the one on record from before (`SessionLog.lastCommands`).
   */
  lastCommands: string | undefined;
  /** Set when the daemon lets the session go (deleted, or the daemon stops): a log closed then is not a failed one. */
  closed = false;
  /**
   * Reasons why this session's running agent process must be recycled once idle (trust change,
   * hot-reloaded runtime setting with `next_idle_restart`, or account sign-out).
   */
  readonly #staleReasons = new Set<string>();
  /** Set while an agent process is being started, so two prompts do not start two. */
  starting: Promise<AgentLink> | undefined;

  markStale(reason: string): void {
    this.#staleReasons.add(reason);
  }

  isStale(): boolean {
    return this.#staleReasons.size > 0;
  }

  /** Whether it is stale for `reason` (an `auth` one speaks for the account it was started with, not the current one). */
  isStaleFor(reason: string): boolean {
    return this.#staleReasons.has(reason);
  }

  clearStale(): void {
    this.#staleReasons.clear();
  }
  /**
   * When something last happened here (a record written, a client attaching or leaving, an agent started), in ms. An
   * agent left with nothing to do for long enough is let go (docs/daemon.md "空闲回收"); the next prompt starts it again.
   */
  lastActive = 0;

  constructor(id: string, entry: SessionEntry, log: SessionLog) {
    this.id = id;
    this.entry = entry;
    this.log = log;
  }

  nextRequestId(): string {
    this.#requests += 1;
    return `p${this.#requests}`;
  }

  /** When something last happened in the session: its last record that is not the daemon's own. */
  updatedAt(): string {
    return this.log.updatedAt() ?? this.entry.createdAt;
  }

  unread(): boolean {
    return (this.entry.attentionSeq ?? 0) > (this.entry.readSeq ?? 0);
  }

  /** How many things run in the background: sub-agents sent there, and tasks that are not sub-agents. */
  backgroundCount(): number {
    return this.backgroundSubagents() + this.#tasks.size;
  }

  /** How many sub-agents run in the background. */
  backgroundSubagents(): number {
    let count = 0;
    for (const background of this.#subagents.values()) if (background) count += 1;
    return count;
  }

  /**
   * Takes in a `_cycle/task_update`. A task counts from an update that says it runs until one says it ended, or that
   * it is gone from the agent's list (`unknown`: its end is not known, and it does not hold the session as running).
   * Returns whether the number in the background changed, which the list shows.
   */
  noteTask(update: Record<string, unknown>): boolean {
    const id = update.taskId;
    if (typeof id !== "string") return false;
    if (update.state === "running") {
      if (this.#tasks.has(id)) return false;
      this.#tasks.add(id);
      return true;
    }
    return this.#tasks.delete(id);
  }

  /**
   * Takes in a `subagent_update`. A sub-agent is in the background from the first update that says
   * so until it is idle; later updates often leave the flag out, and then it stays as it was.
   * Returns whether the number in the background changed, which the list shows.
   */
  noteSubagent(update: Record<string, unknown>): boolean {
    const before = this.backgroundCount();
    const unknownBefore = this.unknownBackground.size;
    const id = update.sessionId;
    if (typeof id !== "string") return false;
    this.noteChild(id);
    // ACP v2 patch rules: an omitted `capabilities` keeps what was said, `null` or a `cancel` of null takes it back.
    if (update.capabilities !== undefined) {
      const cancel = (update.capabilities as { cancel?: unknown } | null)?.cancel;
      if (cancel !== undefined && cancel !== null) this.#stoppable.add(id);
      else if (update.capabilities === null || cancel === null) this.#stoppable.delete(id);
    }
    const state = update.state;
    const named = typeof state === "string" ? state : (state as { state?: unknown } | null)?.state;
    const meta = (update._meta as Record<string, unknown> | null | undefined)?.[META.subagent];
    const info = meta as { background?: unknown; status?: string; toolCallId?: string } | undefined;
    const said = info?.background;
    if (info?.status === "unknown") {
      this.#subagents.delete(id);
      this.unknownBackground.set(id, { toolCallId: info.toolCallId });
    } else if (named === "idle" || info?.status === "dismissed") {
      this.unknownBackground.delete(id);
      this.#subagents.delete(id);
    } else if (named === "running" || this.#subagents.has(id)) {
      const wasUnknown = this.unknownBackground.delete(id);
      this.#subagents.set(
        id,
        typeof said === "boolean" ? said : (this.#subagents.get(id) ?? wasUnknown),
      );
    }
    return before !== this.backgroundCount() || unknownBefore !== this.unknownBackground.size;
  }

  /** `id` was announced as a sub-agent (`subagent_update`). */
  noteChild(id: string): void {
    this.#children.add(id);
  }

  /** Whether `id` is a sub-agent the agent announced: what it says under that id is that sub-agent's. */
  isChild(id: string): boolean {
    return this.#children.has(id);
  }

  /**
   * Whether the sub-agent `id` can be stopped alone now (CYCL-143): the agent said it can (`capabilities.cancel`), and
   * it is running (not ended, and not gone from the agent's list without an end).
   */
  canStop(id: string): boolean {
    return this.#stoppable.has(id) && this.#subagents.has(id);
  }

  /** The agent process is gone, and its sub-agents and tasks with it. */
  endSubagents(): void {
    this.#subagents.clear();
    this.#tasks.clear();
    this.#children.clear();
    this.#stoppable.clear();
    this.unknownBackground.clear();
  }

  status(): SessionStatus {
    if (this.pending.size > 0) return "requires_action";
    if (this.link === undefined && this.starting === undefined) return "stopped";
    return this.agentState;
  }

  /** The state as ACP's `state_update` names it: a stopped session is idle. */
  snapshot(): SessionUpdate {
    const status = this.status();
    return {
      sessionUpdate: "state_update",
      state: status === "stopped" ? "idle" : status,
      ...(this.historyError !== undefined ? { _meta: { [META.historyFailed]: true } } : {}),
    } as SessionUpdate;
  }
}
