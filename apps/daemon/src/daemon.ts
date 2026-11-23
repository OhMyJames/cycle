import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type AgentContext,
  agent as acpAgent,
  type ClientApp,
  type McpServer,
  methods,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
  agentDefaultsRead,
  agentDefaultsSet,
  agentsList,
  CHILD_UPDATE,
  CHILD_UPDATE_KINDS,
  type ChildUpdate,
  CONNECTORS_CHANGED,
  CYCLE_PROTOCOL_VERSION,
  CycleErrorCode,
  type CycleMethod,
  checkPrompt,
  connectorsAdd,
  connectorsAuthClear,
  connectorsAuthFinish,
  connectorsAuthStart,
  connectorsList,
  connectorsRemove,
  connectorsUpdate,
  diffFile,
  diffStatus,
  filesSearch,
  foldersList,
  fsList,
  fsRead,
  META,
  NOTIFICATIONS,
  PLAN_USAGE_CHANGED,
  PLAN_USAGE_UPDATE,
  PLUGINS_CHANGED,
  type PlanUsage,
  PlanUsageSchema,
  type PlanWindow,
  planUsageRead,
  pluginSourcesAdd,
  pluginSourcesRefresh,
  pluginSourcesRemove,
  pluginsAvailable,
  pluginsInstall,
  pluginsList,
  pluginsSetEnabled,
  pluginsUninstall,
  pluginsUpdate,
  promptAckReturn,
  promptDequeue,
  QUEUE_LIMIT,
  QUEUE_UPDATE,
  type QueueEntry,
  type QueueReason,
  QueueUpdateSchema,
  ReplayFromSeqSchema,
  SessionUsageSchema,
  sessionArchive,
  sessionDismissBackground,
  sessionMarkRead,
  sessionSetTitle,
  sessionStopSubagent,
  sessionUnarchive,
  TERMINAL_NOTIFICATIONS,
  terminalAttach,
  terminalClose,
  terminalCreate,
  terminalDetach,
  terminalInput,
  terminalList,
  terminalResize,
  trustRead,
  trustSet,
} from "@cycle/protocol";
import type { z } from "zod";
import { AgentLink } from "./agent-link.ts";
import type { AgentDefinition } from "./agents.ts";
import { TERMINAL_DEFAULTS } from "./config.ts";
import { ConnectorService } from "./connectors/service.ts";
import {
  blobsDir,
  defaultsPath,
  indexPath,
  optionsCachePath,
  sessionsDir,
  trustPath,
} from "./data-dir.ts";
import { AgentDefaults } from "./defaults-file.ts";
import { workspaceFile, workspaceStatus } from "./diff.ts";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  logUnavailable,
  queueFull,
  RESOURCE_NOT_FOUND,
  RpcError,
  sessionBusy,
  sessionNotFound,
  UNSUPPORTED_VERSION,
} from "./errors.ts";
import { searchFiles } from "./files.ts";
import { listFolders } from "./folders.ts";
import { listFolder, readFile } from "./fs.ts";
import { ignoredNames } from "./git.ts";
import { type SessionEntry, SessionIndex } from "./index-file.ts";
import { BlobLogStore } from "./log/blobs.ts";
import { JsonlLogStore } from "./log/jsonl.ts";
import { attach } from "./log/replay.ts";
import type { LogRecord, LogStore, NewRecord } from "./log/types.ts";
import { errorText, type Logger, silentLogger } from "./logger.ts";
import { AgentOptionsCache, choicesFromConfigOptions } from "./options-cache.ts";
import { type PluginProvider, PluginService } from "./plugins.ts";
import { redactParams, redactRecord } from "./redact.ts";
import {
  type Attachment,
  type ClientConn,
  HISTORY_NOT_SAVED,
  type Pending,
  Session,
  type SessionStatus,
} from "./session.ts";
import {
  collapseSessionMentions,
  expandSessionMentions,
  type Mentioned,
  mentionsSession,
} from "./session-mentions.ts";
import { sessionPage } from "./session-page.ts";
import {
  type TerminalSink,
  Terminals,
  type TerminalsOptions,
  terminalEnv,
  terminalShell,
} from "./terminals.ts";
import { checkToolResult } from "./tool-result.ts";
import { FolderTrust, realFolder, within } from "./trust-file.ts";
import { type Activity, opensOrEndsTurn, turnLeftOpen } from "./turns.ts";

export type DaemonOptions = {
  /** Where the daemon keeps its data. Always given: nothing here guesses a home. */
  dataDir: string;
  agents: AgentDefinition[];
  /** For tests: replaces the JSONL store. */
  store?: LogStore;
  /** What this build is, told to every client that connects. Default `dev`: not a release. */
  version?: string;
  /**
   * How long a session's agent may sit with nothing to do and nobody attached before it is let go (`reclaimIdleAgents`):
   * the process ends, the session stays, and its next prompt starts and resumes one. Never, when not given.
   */
  agentIdleMs?: number;
  /** For tests: the clock idle times are measured by. */
  now?: () => number;
  /** For tests: replaces the connectors kept in `$CYCLE_HOME/connectors/` (docs/protocol.md §14). */
  connectors?: ConnectorService;
  /** Where what it does and what goes wrong is told (docs/daemon.md "日志"): events and ids, never content. */
  log?: Logger;
  /**
   * The terminals' shell, environment and limits (docs/protocol.md §8 "终端"). Default: the daemon's `SHELL` and the
   * default allowlist over its environment, with the default limits.
   */
  terminals?: Omit<TerminalsOptions, "onChanged" | "log">;
};

/** The terminals' settings when the daemon is given none: what `config.json` defaults to. */
export const defaultTerminals = (
  environment: Record<string, string | undefined>,
  settings: typeof TERMINAL_DEFAULTS = TERMINAL_DEFAULTS,
): Omit<TerminalsOptions, "onChanged" | "log"> => ({
  env: terminalEnv(settings.allowEnv, environment),
  shell: terminalShell(environment.SHELL),
  maxPerSession: settings.maxPerSession,
  max: settings.max,
  scrollback: settings.scrollback,
});

const SESSION_UPDATE = methods.client.session.update;
const REQUEST_PERMISSION = methods.client.session.requestPermission;
const ELICITATION = methods.client.elicitation.create;

/** The value each of an agent's `configOptions` has now, as a configuration. */
const currentValues = (options: unknown): Record<string, string> => {
  const config: Record<string, string> = {};
  if (Array.isArray(options)) {
    for (const option of options as { configId?: unknown; currentValue?: unknown }[]) {
      if (typeof option?.configId === "string" && typeof option.currentValue === "string") {
        config[option.configId] = option.currentValue;
      }
    }
  }
  return config;
};

/** Keeps existing config order while ensuring `model` is applied before model-dependent `effort`. */
const orderedConfigEntries = (config: Record<string, string>): [string, string][] => {
  const entries = Object.entries(config);
  const effortIndex = entries.findIndex(([key]) => key === "effort");
  const modelIndex = entries.findIndex(([key]) => key === "model");
  if (effortIndex === -1 || modelIndex === -1 || effortIndex > modelIndex) return entries;
  const [effort] = entries.splice(effortIndex, 1);
  if (effort !== undefined) entries.splice(modelIndex, 0, effort);
  return entries;
};
/**
 * The daemon: Cycle's side of docs/protocol.md. It owns the sessions and their history, runs the
 * agents, and serves any number of clients. A client sees a session through the session's log, so
 * replay and live updates are one path.
 */
const ANSWER_ACTIONS = ["accept", "decline", "cancel"];

/** A client's answer to a form as the agent may see it: its action and its content, nothing else a client could add (such as the daemon's own `_meta`). Anything that is not an answer is a cancel. */
const elicitationAnswer = (response: unknown): { action: string; content?: object } => {
  const r = (typeof response === "object" && response !== null ? response : {}) as {
    action?: unknown;
    content?: unknown;
  };
  if (typeof r.action !== "string" || !ANSWER_ACTIONS.includes(r.action)) {
    return { action: "cancel" };
  }
  if (r.action === "accept" && typeof r.content === "object" && r.content !== null) {
    return { action: "accept", content: r.content };
  }
  return { action: r.action };
};

const withoutContent = (outcome: unknown): unknown => {
  if (typeof outcome !== "object" || outcome === null) return outcome;
  const { content: _content, ...rest } = outcome as Record<string, unknown>;
  return rest;
};

/**
 * The values a `configSchema` property allows when it lists them and takes no others: its `enum`, or
 * the `const` of each `oneOf` entry. Undefined for a property that lists none, or says it is open.
 */
const closedChoices = (property: unknown): unknown[] | undefined => {
  if (typeof property !== "object" || property === null) return undefined;
  const {
    enum: values,
    oneOf,
    _meta,
  } = property as {
    enum?: unknown;
    oneOf?: unknown;
    _meta?: Record<string, unknown>;
  };
  if (_meta?.[META.open] === true) return undefined;
  if (Array.isArray(values)) return values;
  if (Array.isArray(oneOf)) {
    const consts = oneOf.map((entry) => (entry as { const?: unknown } | null)?.const);
    return consts.every((value) => value !== undefined) ? consts : undefined;
  }
  return undefined;
};

/** The same declared choices apply to saved defaults and explicit creation overrides. */
const checkedConfig = (agent: AgentDefinition, raw: unknown): Record<string, string> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new RpcError(CycleErrorCode.InvalidConfig, "Expected a configuration object", {
      agent: agent.id,
    });
  const properties = agent.configSchema.properties as Record<string, unknown> | undefined;
  const entries = Object.entries(raw);
  for (const [configId, value] of entries) {
    const field = { agent: agent.id, configId };
    if (properties !== undefined && !Object.hasOwn(properties, configId))
      throw new RpcError(CycleErrorCode.InvalidConfig, `Unknown setting: ${configId}`, field);
    if (typeof value !== "string")
      throw new RpcError(CycleErrorCode.InvalidConfig, `Expected a string for ${configId}`, field);
    const allowed = closedChoices(properties?.[configId]);
    if (allowed && !allowed.includes(value))
      throw new RpcError(CycleErrorCode.InvalidConfig, `Unsupported value for ${configId}`, {
        ...field,
        value,
        allowed,
      });
  }
  return raw as Record<string, string>;
};

export class Daemon {
  readonly #version: string;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #store: LogStore;
  readonly #index: SessionIndex;
  readonly #defaults: AgentDefaults;
  readonly #optionsCache: AgentOptionsCache;
  readonly #trust: FolderTrust;
  readonly #connectors: ConnectorService;
  readonly #plugins: PluginService;
  readonly #terminals: Terminals;
  readonly #agentIdleMs: number | undefined;
  readonly #now: () => number;
  /** When the daemon started, or a client last connected or left: where an idle daemon starts counting. */
  #lastClientAt: number;
  readonly #log: Logger;
  readonly #sessions = new Map<string, Session>();
  /** Sessions being loaded, so a second request for one waits for the first load. */
  readonly #loading = new Map<string, Promise<Session>>();
  readonly #conns = new Set<ClientConn>();
  /** The latest plan usage each agent told, since the daemon started (docs/protocol.md §8 "套餐用量"). */
  readonly #planUsage = new Map<string, PlanUsage>();
  /** The same, limit by limit, with when each was told: what a newer word replaces. */
  readonly #planLimits = new Map<string, Map<string, { window: PlanWindow; at: number }>>();
  #counter = 0;
  #closing = false;

  private constructor(
    options: DaemonOptions,
    index: SessionIndex,
    defaults: AgentDefaults,
    optionsCache: AgentOptionsCache,
    trust: FolderTrust,
    connectors: ConnectorService,
  ) {
    this.#version = options.version ?? "dev";
    this.#agentIdleMs = options.agentIdleMs;
    this.#now = options.now ?? Date.now;
    this.#lastClientAt = this.#now();
    this.#log = options.log ?? silentLogger;
    this.#agents = new Map(options.agents.map((a) => [a.id, a]));
    this.#store =
      options.store ??
      new BlobLogStore(
        new JsonlLogStore({ dir: sessionsDir(options.dataDir) }),
        blobsDir(options.dataDir),
      );
    this.#index = index;
    this.#defaults = defaults;
    this.#optionsCache = optionsCache;
    this.#trust = trust;
    this.#connectors = connectors;
    this.#terminals = new Terminals({
      ...(options.terminals ?? defaultTerminals(process.env)),
      log: this.#log,
      onChanged: (sessionId, terminals) => {
        for (const conn of this.#conns)
          void conn
            .notify(TERMINAL_NOTIFICATIONS.changed, { sessionId, terminals })
            .catch(() => {});
      },
    });
    const providers = new Map<string, PluginProvider>();
    for (const agent of options.agents) {
      if (agent.plugins !== undefined) providers.set(agent.id, agent.plugins);
    }
    this.#plugins = new PluginService({
      providers,
      connectors,
      now: this.#now,
      onChanged: (agentId) => {
        for (const conn of this.#conns) {
          void conn.notify(PLUGINS_CHANGED, { agentId }).catch(() => {});
        }
      },
    });
    connectors.onChanged(() => {
      for (const conn of this.#conns) {
        void conn.notify(CONNECTORS_CHANGED, {}).catch(() => {});
      }
    });
  }

  /** Reads the index, and refuses to start if it is there and cannot be read. */
  static async start(options: DaemonOptions): Promise<Daemon> {
    return new Daemon(
      options,
      await SessionIndex.load(indexPath(options.dataDir)),
      await AgentDefaults.load(defaultsPath(options.dataDir)),
      await AgentOptionsCache.load(optionsCachePath(options.dataDir)),
      await FolderTrust.load(trustPath(options.dataDir)),
      options.connectors ?? (await ConnectorService.load(options.dataDir)),
    );
  }

  /** Serves one client on a stream. */
  accept(stream: Stream): { closed: Promise<void>; close: () => void } {
    const holder: { value?: ClientConn } = {};
    return this.#register(holder, this.#facing(holder).connect(stream));
  }

  /** Serves a client app in this process, with no transport. For tests. */
  acceptApp(clientApp: ClientApp): { closed: Promise<void>; close: () => void } {
    const holder: { value?: ClientConn } = {};
    return this.#register(holder, this.#facing(holder).connect(clientApp));
  }

  #register(
    holder: { value?: ClientConn },
    connection: { client: AgentContext; closed: Promise<void>; close: () => void },
  ): { closed: Promise<void>; close: () => void } {
    const client = connection.client;
    const conn: ClientConn = {
      id: `c${++this.#counter}`,
      notify: (method, params) => client.notify(method as never, params as never),
      request: (method, params) => client.request(method as never, params as never),
      elicitation: false,
      ackReturns: false,
    };
    holder.value = conn;
    this.#conns.add(conn);
    this.#lastClientAt = this.#now();
    void connection.closed.then(() => this.#dropped(conn));
    return { closed: connection.closed, close: () => connection.close() };
  }

  /**
   * What a stop would cut short, session by session: a turn in progress (with any request waiting on the owner) or
   * background sub-agents still working. Empty when the daemon can stop without losing anything; an idle exit
   * (CYCL-104) waits for that. Only loaded sessions can be doing anything.
   */
  activity(): Activity[] {
    const active: Activity[] = [];
    for (const session of this.#sessions.values()) {
      if (session.closed) continue;
      const turn = this.#turnInProgress(session);
      const background = session.backgroundCount();
      if (!turn && background === 0) continue;
      active.push({
        sessionId: session.id,
        ...(session.entry.title !== undefined ? { title: session.entry.title } : {}),
        turn,
        pending: session.pending.size,
        background,
        queued: session.queue.length,
      });
    }
    return active;
  }

  /**
   * Whether a session's agent can be let go without anything noticing: nobody is attached, and nothing is running,
   * waiting or in the background. What it held is on disk; the next prompt starts and resumes the agent. A queue already
   * held for a client to take back (docs/daemon.md "排队") needs no agent: it does not hold one, and keeps its reason.
   */
  #reclaimable(session: Session): boolean {
    return (
      !session.closed &&
      session.link !== undefined &&
      session.starting === undefined &&
      session.attachments.size === 0 &&
      // A request waiting for an answer counts as a turn in progress.
      !this.#turnInProgress(session) &&
      (session.queue.length === 0 || session.heldReason !== undefined) &&
      // A task the agent's list no longer has, its end unknown, does not hold it on its own (docs/protocol.md §8).
      session.backgroundCount() === 0
    );
  }

  /**
   * Lets go of each agent that has had nothing to do, with nobody attached, for `agentIdleMs` (docs/daemon.md
   * "空闲回收"). Its process ends; the session stays loaded (it is small: the history is on disk) and its next prompt
   * starts the agent again. Returns the sessions whose agent was let go.
   */
  reclaimIdleAgents(): string[] {
    const limit = this.#agentIdleMs;
    if (limit === undefined || this.#closing) return [];
    const now = this.#now();
    const reclaimed: string[] = [];
    for (const session of this.#sessions.values()) {
      if (!this.#reclaimable(session) || now - session.lastActive < limit) continue;
      this.#log.info("agent_reclaimed", {
        session: session.id,
        idleSeconds: Math.round((now - session.lastActive) / 1000),
      });
      const link = session.link;
      link?.kill();
      // Gone from now, not when its connection is seen to close: a prompt that comes in between starts a new agent
      // instead of being handed to the one going away. The close, when it comes, finds it already done.
      this.#onAgentClosed(session, link);
      reclaimed.push(session.id);
    }
    return reclaimed;
  }

  /**
   * Since when the daemon has had no client and nothing to do (docs/daemon.md "空闲退出"), or undefined while it has:
   * a client connected, a session loading or starting its agent, or something `activity()` lists. A daemon idle long
   * enough can stop without losing anything.
   */
  idleSince(): number | undefined {
    if (this.#closing || this.#conns.size > 0 || this.#loading.size > 0) return undefined;
    if (this.activity().length > 0) return undefined;
    let since = this.#lastClientAt;
    // A queue with no turn behind it is on disk and waits for a client either way (docs/daemon.md "排队"), and a
    // background task the agent no longer lists is not known to be working: neither holds the daemon.
    for (const session of this.#sessions.values()) {
      if (session.closed) continue;
      if (session.starting !== undefined) return undefined;
      since = Math.max(since, session.lastActive);
    }
    return since;
  }

  /** A turn has started and not ended: on record, or as the daemon has it (a prompt still on its way to the agent). */
  #turnInProgress(session: Session): boolean {
    const status = session.status();
    return (
      session.entry.turnOpen === true ||
      status === "running" ||
      status === "requires_action" ||
      session.pending.size > 0
    );
  }

  async close(): Promise<void> {
    // Stopping the agents is not a reason to hand anything back: what waits stays for the next start.
    this.#closing = true;
    // Terminals do not outlive the daemon (docs/protocol.md §8 "终端"). Their shells are hung up now and given their
    // grace while the sessions stop, not before.
    const terminals = this.#terminals.closeAll();
    for (const session of this.#sessions.values()) {
      // A turn cut short says so in the history before the agent goes (docs/protocol.md §8): it is not left running.
      if (!session.closed && this.#turnInProgress(session)) {
        await this.#interrupt(session, "Cycle was stopped while this turn was running");
      }
      session.closed = true;
      session.link?.kill();
      for (const attachment of session.attachments) attachment.detach();
      await session.log.close();
    }
    this.#sessions.clear();
    this.#connectors.close();
    // What the sessions noted as they went (an unread mark, a usage) is written by now, not dropped.
    await this.#index.flush();
    await this.#optionsCache.flush();
    await terminals;
  }

  #dropped(conn: ClientConn): void {
    this.#conns.delete(conn);
    this.#terminals.detachAll(conn.id);
    this.#lastClientAt = this.#now();
    for (const session of this.#sessions.values()) {
      for (const attachment of [...session.attachments]) {
        if (attachment.conn === conn) {
          attachment.detach();
          session.attachments.delete(attachment);
          // Nobody watching from now: the idle time starts here, not from the last record.
          session.lastActive = this.#now();
        }
      }
      if (session.returnOwner?.conn === conn && !session.returnOwner.acknowledging) {
        session.returnOwner = undefined;
        this.#offerReturn(session);
      }
      this.#abandonForms(session);
    }
  }

  /** Whether some attached client has said it can answer a form. */
  #canAskForms(session: Session): boolean {
    return [...session.attachments].some((attachment) => attachment.conn.elicitation);
  }

  /**
   * A form is asked only while some attached client can answer it. When the last one goes the
   * agent is told so, as it is when none is attached to begin with, instead of waiting for a client
   * that may never come back (decision 0011).
   */
  #abandonForms(session: Session): void {
    if (this.#canAskForms(session)) return;
    for (const pending of [...session.pending.values()]) {
      if (pending.method === ELICITATION) {
        this.#settle(session, pending, { action: "cancel", _meta: { [META.noClient]: true } });
      }
    }
  }

  #changed(): void {
    for (const conn of this.#conns)
      void conn.notify(NOTIFICATIONS.sessionListChanged, {}).catch(() => {});
  }

  #definition(id: string): AgentDefinition {
    const definition = this.#agents.get(id);
    if (definition === undefined) {
      throw new RpcError(CycleErrorCode.AgentUnavailable, "No such agent", { agent: id });
    }
    return definition;
  }

  /**
   * A loaded session, loading it from the index and its log if it is not yet. Everyone who asks
   * while it loads gets the one load: a log has a single writer, and two loads would be two.
   */
  #session(sessionId: string): Promise<Session> {
    const loaded = this.#sessions.get(sessionId);
    // A session being deleted is already gone to everyone who asks.
    if (loaded?.closed) return Promise.reject(sessionNotFound(sessionId));
    if (loaded !== undefined) return Promise.resolve(loaded);
    const loading = this.#loading.get(sessionId);
    if (loading !== undefined) return loading;
    const entry = this.#index.get(sessionId);
    if (entry === undefined) return Promise.reject(sessionNotFound(sessionId));
    const load = (async () => {
      const log = await this.#store.open(sessionId, "existing");
      const session = new Session(sessionId, entry, log);
      session.lastActive = this.#now();
      // The queue is the last snapshot in the log; the index says whether there is anything to look for.
      if (entry.queued === true) await this.#restoreQueue(session);
      this.#clamp(session);
      this.#watch(session);
      await this.#endTurnLeftOpen(session);
      this.#sessions.set(sessionId, session);
      this.#log.debug("session_loaded", { session: sessionId, queued: session.queue.length });
      return session;
    })().finally(() => {
      this.#loading.delete(sessionId);
    });
    this.#loading.set(sessionId, load);
    return load;
  }

  // ---- agents ----

  /**
   * What the agent is told of the session's folder: `cycle/trusted` when someone has decided
   * (docs/protocol.md §8 "信任文件夹"), nothing when nobody has or the folder is gone.
   */
  async #trustMeta(cwd: string): Promise<Record<string, boolean>> {
    const real = await realFolder(cwd).catch(() => undefined);
    const trusted = real === undefined ? null : this.#trust.of(real).trusted;
    return trusted === null ? {} : { [META.trusted]: trusted };
  }

  /** A session's folder, from the index: nothing of the session (its log) needs loading to read in it. */
  #cwdOf(sessionId: string): string {
    const entry = this.#index.get(sessionId);
    // A session being deleted is already gone to everyone who asks.
    if (entry === undefined || this.#sessions.get(sessionId)?.closed === true)
      throw sessionNotFound(sessionId);
    return entry.cwd;
  }

  /**
   * A decision changed: every agent in that folder was started with the old one, and would write it
   * back each time it starts a process. Each is stopped as soon as it has nothing to do (now, for an
   * idle one), so the next prompt starts it again with the new decision.
   */
  async #applyTrust(folder: string): Promise<void> {
    const running = [...this.#sessions.values()].filter(
      (s) => s.link !== undefined || s.starting !== undefined,
    );
    const reals = new Map<string, string | undefined>();
    await Promise.all(
      [...new Set(running.map((s) => s.entry.cwd))].map(async (cwd) => {
        reals.set(cwd, await realFolder(cwd).catch(() => undefined));
      }),
    );
    for (const session of running) {
      const real = reals.get(session.entry.cwd);
      if (real === undefined || !within(real, folder)) continue;
      session.trustStale = true;
      this.#restartIfStale(session);
    }
  }

  /**
   * An agent started for a session that has had no prompt holds a process for nothing yet. Past its agent's
   * `maxAhead` of them, counted among that agent's sessions, the oldest is let go (the session `keep` is the newest, and stays): its next prompt starts one again.
   */
  #letGoOfOldestAhead(keep: Session): void {
    const limit = this.#agents.get(keep.entry.agent)?.maxAhead;
    if (limit === undefined) return;
    const ahead = [...this.#sessions.values()].filter(
      (s) =>
        s.entry.agent === keep.entry.agent &&
        s.link !== undefined &&
        s.starting === undefined &&
        s.entry.prompted !== true &&
        s.status() === "idle" &&
        s.queue.length === 0,
    );
    for (const old of ahead.slice(0, Math.max(0, ahead.length - limit))) {
      if (old !== keep) old.link?.kill();
    }
  }

  /** Stops an agent started with a trust decision that has changed since, once it has nothing to do. */
  #restartIfStale(session: Session): void {
    if (!session.trustStale) return;
    if (session.link === undefined && session.starting === undefined) {
      // No agent: the next one is started with the decision as it is then.
      session.trustStale = false;
      return;
    }
    if (session.link === undefined || session.starting !== undefined) return;
    if (session.status() !== "idle" || session.queue.length > 0) return;
    if (session.backgroundCount() > 0) return;
    session.trustStale = false;
    session.link.kill();
  }

  /** Starts the agent for a session and has it create or resume it. */
  async #startAgent(session: Session, mode: "new" | "resume", create?: Record<string, unknown>) {
    const definition = this.#definition(session.entry.agent);
    const trust = await this.#trustMeta(session.entry.cwd);
    // The connection can end before connect() has returned the link (an agent that fails to start,
    // or exits at once): the end is noted, and acted on once there is a link to act on.
    let connected: AgentLink | undefined;
    let endedEarly = false;
    const link = await AgentLink.connect(definition, {
      update: (update, sessionId) => {
        // A sub-agent it announced speaks under its own id (ACP v2): that is the sub-agent's conversation. Any other id
        // is taken as the session's own, as before the agent named one.
        if (session.isChild(sessionId)) this.#onChildUpdate(session, sessionId, update);
        else this.#onUpdate(session, update);
      },
      permission: (params) => this.#onPermission(session, params),
      elicitation: (params) => this.#onElicitation(session, params),
      closed: () => {
        if (connected === undefined) endedEarly = true;
        else this.#onAgentClosed(session, connected);
      },
    });
    connected = link;
    session.link = link;
    if (endedEarly) this.#onAgentClosed(session, link);
    try {
      // Cycle's connectors, each through the gateway (docs/protocol.md §14). A session's own servers keep their names.
      const own = ((mode === "new" ? create?.mcpServers : undefined) ??
        session.entry.mcpServers ??
        []) as McpServer[];
      // What its plugins bring is made current first: a plugin can have changed without anyone having looked.
      if (link.mcpHttp) await this.#plugins.beforeAgentStarts(session.entry.agent);
      const connectors = link.mcpHttp
        ? await this.#connectors.serversFor(
            session.id,
            session.entry.cwd,
            new Set(own.map((server) => (server as { name: string }).name)),
            session.entry.agent,
          )
        : [];
      const mcpServers = [...own, ...connectors];
      if (mode === "new") {
        const created = await link.agent.request(methods.agent.session.new, {
          ...(create as object),
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          _meta: {
            ...((create as { _meta?: object })?._meta ?? {}),
            ...trust,
            [META.sessionId]: session.id,
          },
        } as never);
        return { link, created };
      }
      session.resuming = true;
      let resumed: unknown;
      try {
        try {
          // What the session was made with goes again: the agent does not keep it across a restart.
          const { additionalDirectories, systemPrompt } = session.entry;
          resumed = await link.agent.request(methods.agent.session.resume, {
            sessionId: session.entry.agentSessionId,
            cwd: session.entry.cwd,
            ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
            ...(mcpServers.length > 0 ? { mcpServers } : {}),
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            _meta: {
              ...trust,
              // So that an agent that finds no record of a session that had turns says so.
              ...(session.entry.hadTurn === true ? { [META.hadTurn]: true } : {}),
            },
          } as never);
        } catch (error) {
          throw new RpcError(
            CycleErrorCode.ResumeFailed,
            "The agent could not resume the session",
            {
              sessionId: session.id,
              detail: error instanceof Error ? error.message : String(error),
            },
          );
        }
        // A setting not on record (a session older than the record of what it started with) is
        // whatever the agent resumed it in: on record from now, so a client can show it.
        const resumedWith = currentValues(
          (resumed as { configOptions?: unknown } | undefined)?.configOptions,
        );
        const missing = Object.fromEntries(
          Object.entries(resumedWith).filter(([key]) => !(key in (session.entry.config ?? {}))),
        );
        if (Object.keys(missing).length > 0) {
          this.#remember(session, { config: { ...missing, ...(session.entry.config ?? {}) } });
        }
        // What was saved is put back, setting by setting. Keep `session.resuming` true until
        // restoration completes so intermediate `config_option_update` notifications cannot clobber
        // saved settings that have not been re-applied yet.
        const refused: { configId: string; wanted: string }[] = [];
        for (const [configId, value] of orderedConfigEntries(session.entry.config ?? {})) {
          await link.agent
            .request(methods.agent.session.setConfigOption, {
              sessionId: session.entry.agentSessionId,
              configId,
              type: "id",
              value,
            } as never)
            .catch((error: unknown) => {
              // Only the agent's own answer is a refusal. A link that broke is not: the record is kept.
              if (typeof (error as { code?: unknown } | null)?.code === "number")
                refused.push({ configId, wanted: value });
            });
        }
        if (refused.length > 0) await this.#configNotRestored(session, refused, resumedWith);
      } finally {
        session.resuming = false;
      }
      const resumedModels = choicesFromConfigOptions(
        (resumed as { configOptions?: unknown } | undefined)?.configOptions,
        "model",
      );
      if (resumedModels !== undefined) {
        void this.#optionsCache
          .update(session.entry.agent, "model", resumedModels)
          .catch(() => undefined);
      }
      return { link, created: undefined };
    } catch (error) {
      session.link = undefined;
      this.#connectors.release(session.id);
      link.kill();
      throw error;
    }
  }

  /**
   * Settings the agent refused on resume: the record follows what is in force, and the conversation
   * says so. Written before the caller can send anything more.
   */
  async #configNotRestored(
    session: Session,
    refused: { configId: string; wanted: string }[],
    actual: Record<string, string>,
  ): Promise<void> {
    const config = { ...(session.entry.config ?? {}) };
    // An agent that listed none of its settings has not said what is in force: the record stays as it is.
    const known = Object.keys(actual).length > 0;
    const titles: string[] = [];
    for (const { configId, wanted } of refused) {
      const now = actual[configId];
      if (now !== undefined) {
        config[configId] = now;
        titles.push(`The agent did not accept "${wanted}" for "${configId}". It is now "${now}".`);
      } else if (known) {
        delete config[configId];
        titles.push(
          `The agent no longer has the setting "${configId}" (it was "${wanted}"). It is not applied.`,
        );
      } else {
        titles.push(
          `The agent did not accept "${wanted}" for "${configId}", and has not said what it is now.`,
        );
      }
    }
    // The record first, and waited for, so a client that sees the notice finds the list already right.
    session.entry = { ...session.entry, config };
    await this.#index.update(session.id, { config });
    this.#changed();
    for (const title of titles) {
      await this.#write(session, {
        kind: "update",
        data: { sessionUpdate: "notice", severity: "warning", title },
      });
    }
  }

  /** The agent for a session, started if it is not running. */
  async #ensureAgent(session: Session): Promise<AgentLink> {
    // Whatever asks for the agent is about to use it (a prompt, a setting): not idle, so not let go under it.
    session.lastActive = this.#now();
    if (session.link !== undefined) return session.link;
    session.starting ??= this.#startAgent(session, "resume")
      .then(({ link }) => {
        // A start is something happening: its idle time is counted from when it is up.
        session.lastActive = this.#now();
        return link;
      })
      .finally(() => {
        session.starting = undefined;
      });
    return session.starting;
  }

  #notePlanUsage(agent: string, update: unknown): void {
    const parsed = PlanUsageSchema.safeParse(update);
    if (!parsed.success) return;
    const told = parsed.data;
    // Limit by limit: an event may name only some, and each session's process tells what it last heard, so each
    // limit keeps the newest word of it from any of them (an older one does not replace it).
    const limits =
      this.#planLimits.get(agent) ?? new Map<string, { window: PlanWindow; at: number }>();
    let changed = false;
    for (const window of told.windows) {
      const known = limits.get(window.kind);
      if (known !== undefined && known.at > told.at) continue;
      limits.set(window.kind, { window, at: told.at });
      changed = true;
    }
    if (!changed) return;
    this.#planLimits.set(agent, limits);
    const kept = [...limits.values()];
    const usage: PlanUsage = {
      windows: kept.map((l) => l.window),
      at: Math.max(...kept.map((l) => l.at)),
    };
    this.#planUsage.set(agent, usage);
    for (const conn of this.#conns)
      void conn.notify(PLAN_USAGE_CHANGED, { agent, usage }).catch(() => {});
  }

  /**
   * What a sub-agent said or called (docs/protocol.md §9, CYCL-134): kept and told as one record of its parent session,
   * `_cycle/child_update`, so it has the parent's seq and is replayed with it. Only its conversation: what it would say
   * of a state, a plan or a usage is not the session's, and its state is `subagent_update`'s. It changes nothing of the
   * session (its state, its list row, what is worth reading).
   */
  #onChildUpdate(session: Session, childId: string, update: SessionUpdate): void {
    if (session.resuming || session.historyError !== undefined || this.#closing) return;
    const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
    if (typeof kind !== "string" || !CHILD_UPDATE_KINDS.has(kind)) return;
    void this.#write(session, {
      kind: "update",
      data: { sessionUpdate: CHILD_UPDATE, childId, update } satisfies ChildUpdate,
    });
  }

  #onUpdate(session: Session, update: SessionUpdate): void {
    // The account's, not the session's: kept for the agent and told to every client, never written to a history.
    if ((update as { sessionUpdate?: unknown }).sessionUpdate === PLAN_USAGE_UPDATE) {
      this.#notePlanUsage(session.entry.agent, update);
      return;
    }
    // The daemon's to make from a sub-agent's own updates: an agent does not say it for one.
    if ((update as { sessionUpdate?: unknown }).sessionUpdate === CHILD_UPDATE) return;
    // Known as a sub-agent even when its announce is not kept (a resume replays, say): what it says later under its own
    // id is then dropped as a sub-agent's, never written as the session's own.
    const announced = update as { sessionUpdate?: unknown; sessionId?: unknown };
    if (announced.sessionUpdate === "subagent_update" && typeof announced.sessionId === "string")
      session.noteChild(announced.sessionId);
    // Once the daemon is stopping, the turn's end is on record: what the agent says after it is not.
    if (session.resuming || session.historyError !== undefined || this.#closing) return;
    const state = update as { sessionUpdate: string; state?: string };
    if (state.sessionUpdate === "state_update" && typeof state.state === "string") {
      if (
        state.state === "running" ||
        state.state === "idle" ||
        state.state === "requires_action"
      ) {
        session.agentState = state.state;
      }
    }
    if (!this.#learn(session, update)) return;
    // What the agent was given for a mention of another session is kept as the mention, not as that session's record.
    const echo = update as { content?: unknown };
    const content =
      state.sessionUpdate === "user_message" ? collapseSessionMentions(echo.content) : echo.content;
    const kept = content === echo.content ? update : { ...update, content };
    // Called in the order the updates arrive, so seq follows the agent's order.
    // The list shows what a session is doing, not what it said: only a change of state is announced
    // (docs/protocol.md §6). Anything else that changes the list says so where it changes it.
    // Update before yielding to storage so a concurrent dismissal checks the latest agent signal.
    const backgroundChanged =
      state.sessionUpdate === "subagent_update" &&
      session.noteSubagent(update as unknown as Record<string, unknown>);
    const announce = state.sessionUpdate === "state_update" || backgroundChanged;
    void this.#write(session, { kind: "update", data: kept }).then((written) => {
      if (written && announce) this.#changed();
      if (written && backgroundChanged) this.#restartIfStale(session);
    });
    // A turn ended (an idle that says why, not a snapshot): the next prompt goes, or the queue is handed back.
    const ended = update as {
      sessionUpdate: string;
      state?: string;
      stopReason?: unknown;
      error?: { code?: unknown } | null;
    };
    if (
      ended.sessionUpdate === "state_update" &&
      ended.state === "idle" &&
      typeof ended.stopReason === "string"
    ) {
      const code = typeof ended.error?.code === "number" ? ended.error.code : undefined;
      // How it ended, and the code of a failure: what the agent said about it is in the history, not here.
      if (ended.stopReason === "error")
        this.#log.warn("turn_ended", { session: session.id, stopReason: ended.stopReason, code });
      else this.#log.info("turn_ended", { session: session.id, stopReason: ended.stopReason });
    }
    if (
      ended.sessionUpdate === "state_update" &&
      ended.state === "idle" &&
      typeof ended.stopReason === "string" &&
      session.queue.length > 0
    ) {
      if (ended.stopReason === "end_turn") this.#dispatchNext(session);
      else
        void this.#returnQueue(session, ended.stopReason === "cancelled" ? "cancelled" : "error");
    }
    // A turn that ended with nothing behind it: an agent started with an old trust decision can go now.
    if (
      ended.sessionUpdate === "state_update" &&
      ended.state === "idle" &&
      typeof ended.stopReason === "string"
    )
      this.#restartIfStale(session);
  }

  // ---- the queue (docs/protocol.md §8) ----

  async #restoreQueue(session: Session): Promise<void> {
    for (const record of await session.log.read()) {
      if (record.kind === "meta") {
        const ack = (record.data as { acknowledgedReturn?: string }).acknowledgedReturn;
        if (ack) session.returns.delete(ack);
      } else if (
        record.kind === "update" &&
        (record.data as { sessionUpdate?: string } | null)?.sessionUpdate === QUEUE_UPDATE
      ) {
        const parsed = QueueUpdateSchema.safeParse(record.data);
        if (!parsed.success) continue;
        const { entries, returnId, returned, reason } = parsed.data;
        session.queue = entries;
        if (returnId && returned && reason)
          session.returns.set(returnId, { returned, reason, durable: true });
      }
    }
  }

  #indexQueue(session: Session): void {
    const queued = session.queue.length > 0 || session.returns.size > 0;
    if ((session.entry.queued === true) !== queued)
      this.#remember(session, { queued: queued ? true : undefined } as Partial<SessionEntry>);
  }

  /**
   * Writes the queue as it is now, with what was handed back by this change, if anything. Whether
   * it is on record: a change a person asked for is confirmed to them only once it is.
   */
  #publishQueue(
    session: Session,
    back?: { returnId: string; returned: QueueEntry[]; reason: QueueReason },
  ): Promise<boolean> {
    this.#indexQueue(session);
    return this.#write(session, {
      kind: "update",
      data: {
        sessionUpdate: QUEUE_UPDATE,
        entries: [...session.queue],
        ...(back !== undefined ? back : {}),
      },
    }).then((written) => {
      if (written) this.#changed();
      return written;
    });
  }

  /**
   * Hands everything waiting back, to be put in the input box. Nothing is sent. A client acts on
   * what is handed back only when it is there to be told, so with no client attached the queue
   * stays, and is handed back, for the same reason, when one attaches. `force` is for that.
   */
  #returnQueue(session: Session, reason: QueueReason, force = false): void {
    if (session.queue.length === 0 || this.#closing) return;
    if (!force && session.attachments.size === 0) {
      session.heldReason ??= reason;
      return;
    }
    const returned = session.queue;
    session.queue = [];
    session.heldReason = undefined;
    const returnId = randomUUID();
    const batch = { returned, reason, durable: false };
    session.returns.set(returnId, batch);
    void this.#publishQueue(session, { returnId, returned, reason }).then((written) => {
      batch.durable = written;
      this.#offerReturn(session);
    });
  }

  #offerReturn(session: Session): void {
    if (session.closed || session.historyError || session.returnOwner) return;
    const first = session.returns.entries().next().value;
    const recipient = [...session.attachments].find((a) => a.ready);
    if (!first || !first[1].durable || !recipient) return;
    const [returnId, { returned, reason }] = first;
    const { conn } = recipient;
    session.returnOwner = { conn, id: returnId, acknowledging: false };
    void conn
      .notify(SESSION_UPDATE, {
        sessionId: session.id,
        update: {
          sessionUpdate: QUEUE_UPDATE,
          entries: [...session.queue],
          returnId,
          returned,
          reason,
        },
      })
      .then(
        () => {
          if (!conn.ackReturns) return this.#ackReturn(session, conn, returnId);
        },
        () => {
          recipient.ready = false;
          if (session.returnOwner?.conn === conn && session.returnOwner.id === returnId) {
            session.returnOwner = undefined;
            this.#offerReturn(session);
          }
        },
      )
      .catch(() => {});
  }

  async #ackReturn(session: Session, conn: ClientConn, id: string): Promise<boolean> {
    const owner = session.returnOwner;
    if (!owner || owner.id !== id || owner.conn !== conn || owner.acknowledging) return false;
    owner.acknowledging = true;
    if (!(await this.#write(session, { kind: "meta", data: { acknowledgedReturn: id } })))
      throw logUnavailable(session.id, session.historyError ?? HISTORY_NOT_SAVED);
    session.returns.delete(id);
    session.returnOwner = undefined;
    this.#indexQueue(session);
    this.#offerReturn(session);
    return true;
  }

  /** A queue left behind with no turn to send it: the reason it was held, or a restart's. */
  #returnStale(session: Session): void {
    const status = session.status();
    if (status !== "idle" && status !== "stopped") return;
    this.#returnQueue(session, session.heldReason ?? "interrupted", true);
  }

  /** The oldest queued prompt goes to the agent, as the turn before it ended well. */
  #dispatchNext(session: Session): void {
    const next = session.queue.shift();
    if (next === undefined) return;
    this.#publishQueue(session);
    session.agentState = "running";
    // A new turn: its end, or its failure, is to be put on record (the one before left this set).
    session.turnEnded = false;
    this.#send(session, next.prompt).catch((error: unknown) => {
      this.#promptFailed(session, error);
      // It did not go, and what was behind it must not go past it: all of it is handed back, in order.
      session.queue.unshift(next);
      this.#returnQueue(session, "error");
    });
  }

  /** A prompt that could not be given to the agent: a turn that ended in failure is a turn end like any other, on record, so the session shows as unread. */
  #promptFailed(session: Session, error: unknown): void {
    this.#log.warn("prompt_failed", {
      session: session.id,
      code: (error as { code?: unknown } | null)?.code as number | undefined,
      error: errorText(error),
    });
    session.agentState = "idle";
    this.#changed();
    const code = (error as { code?: unknown } | null)?.code;
    this.#endTurnWithError(
      session,
      typeof code === "number" ? code : INTERNAL_ERROR,
      error instanceof Error ? error.message : String(error),
    );
  }

  /**
   * Hands a prompt to the turn that is running (docs/protocol.md §8). Undefined when the agent
   * cannot take it (it does not steer, it is not there, or it refused, as when the turn has just
   * ended): the caller queues it, or sends it, as the session now is.
   */
  async #steer(session: Session, prompt: unknown[]): Promise<unknown> {
    const link = session.link;
    if (this.#definition(session.entry.agent).steer !== true || link === undefined) return;
    try {
      const answer = (await link.agent.request(methods.agent.session.prompt, {
        sessionId: session.entry.agentSessionId,
        prompt: await this.#expand(session, prompt),
        _meta: { [META.steer]: true },
      } as never)) as { messageId?: unknown; _meta?: Record<string, unknown> | null };
      return { ...answer, _meta: { ...(answer._meta ?? {}), [META.steered]: true } };
    } catch {
      return undefined;
    }
  }

  async #send(session: Session, given: unknown[]): Promise<unknown> {
    const stopsBefore = session.startingCancels;
    // Asked for first: the session is starting from now, so a prompt that comes in meanwhile is queued behind this one.
    const starting = this.#ensureAgent(session);
    // Its failure is met below, once the prompt is ready; not reported as unhandled while the prompt is read.
    starting.catch(() => undefined);
    session.preparing++;
    let prompt: unknown[];
    try {
      prompt = await this.#expand(session, given);
    } finally {
      session.preparing--;
    }
    const link = await starting;
    if (session.startingCancels !== stopsBefore) {
      // Stopped while the agent was starting or the prompt was being made ready: there is no turn to stop yet, so the prompt is not given.
      // The turn ends as a cancelled one, which clients and the queue see like any other.
      this.#onUpdate(session, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
      } as SessionUpdate);
      return { messageId: randomUUID() };
    }
    return link.agent.request(methods.agent.session.prompt, {
      sessionId: session.entry.agentSessionId,
      prompt,
    } as never);
  }

  /**
   * The prompt as the agent is given it: a mention of another session of this daemon becomes that session's record, as
   * it is now (docs/protocol.md §8 "提及(@)另一个 session"). One that mentions none is given as it is.
   */
  async #expand(session: Session, prompt: unknown[]): Promise<unknown[]> {
    if (!mentionsSession(prompt)) return prompt;
    const embedded = this.#definition(session.entry.agent).promptCapabilities?.embeddedContext;
    const read = async (sessionId: string): Promise<Mentioned> => {
      if (sessionId === session.id) return { found: false, why: "self" };
      // Only what this daemon keeps: the id is looked up in its own index, never taken as a path.
      if (this.#index.get(sessionId) === undefined) return { found: false, why: "missing" };
      const other = await this.#session(sessionId).catch(() => undefined);
      if (other === undefined) return { found: false, why: "missing" };
      if (other.historyError !== undefined) return { found: false, why: "unreadable" };
      // As stored: images are not read back from their blobs, the record only says one was there.
      const records = await other.log.read(undefined, { stored: true });
      return { found: true, title: other.entry.title, records };
    };
    const expanded = await expandSessionMentions(prompt, read, embedded != null);
    this.#log.info("session_mentions_expanded", {
      session: session.id,
      count: prompt.filter((b, i) => b !== expanded[i]).length,
    });
    return expanded;
  }

  /**
   * Appends to a session's log. A write that fails is not lost quietly: the session is marked,
   * clients are told by a path that does not go through the log, and false is returned.
   */
  async #write(session: Session, record: NewRecord): Promise<boolean> {
    // Once it has failed nothing more is written: what comes after a gap would not be the history.
    if (session.historyError !== undefined || session.closed) return false;
    try {
      // What is kept, and so what clients see, is what has been through this (docs/protocol.md §12).
      const data = checkToolResult(record.kind, redactRecord(record.kind, record.data));
      await session.log.append({ ...record, data });
      return true;
    } catch (error) {
      // A log that was closed on purpose (the session is deleted, the daemon stops) is not a failure.
      if (!session.closed) this.#historyFailed(session, error);
      return false;
    }
  }

  /**
   * The history cannot be written. What happens next would not be on record, so the turn is
   * stopped (the agent is cancelled, what it waits on is answered as cancelled), every client
   * attached is told, and no new turn starts until the daemon is started again.
   */
  #historyFailed(session: Session, error: unknown): void {
    if (session.historyError !== undefined) return;
    this.#log.error("history_write_failed", { session: session.id, error: errorText(error) });
    session.historyError = error instanceof Error ? error.message : String(error);
    for (const pending of [...session.pending.values()]) {
      pending.settled = true;
      session.pending.delete(pending.requestId);
      pending.resolve(pending.cancelled);
      for (const attachment of pending.asked) {
        void attachment.conn
          .notify(NOTIFICATIONS.requestResolved, {
            sessionId: session.id,
            requestId: pending.requestId,
            outcome: pending.cancelled,
          })
          .catch(() => {});
      }
    }
    session.agentState = "idle";
    void session.link?.agent
      .notify(methods.agent.session.cancel, { sessionId: session.entry.agentSessionId } as never)
      .catch(() => undefined);
    // Not logged: the log is what failed. Like a snapshot it carries no seq.
    const update = {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: CycleErrorCode.LogUnavailable, message: HISTORY_NOT_SAVED },
    };
    for (const attachment of session.attachments) {
      void attachment.conn
        .notify(SESSION_UPDATE, { sessionId: session.id, update })
        .catch(() => {});
    }
    this.#changed();
  }

  /**
   * A crash can cost a log its last, half-written line, and with it the seqs after it, which are
   * then given out again. A mark made in the index for one of those would hide the new records of
   * the same number: it never stands past the log's end.
   */
  #clamp(session: Session): void {
    const last = session.log.lastSeq();
    const patch: Partial<SessionEntry> = {};
    if ((session.entry.readSeq ?? 0) > last) patch.readSeq = last;
    if ((session.entry.attentionSeq ?? 0) > last) patch.attentionSeq = last;
    if (Object.keys(patch).length > 0) this.#remember(session, patch, false);
  }

  /** Follows what is written to a session's log, for what the list shows of it. */
  #watch(session: Session): void {
    session.log.subscribe((record) => this.#observe(session, record));
  }

  #observe(session: Session, record: LogRecord): void {
    // The daemon's own notes (an agent let go, say) are not something happening in the session.
    if (record.kind !== "meta") session.lastActive = this.#now();
    // A request put to the owner (a permission, a form) is worth seeing whatever the agent says of
    // its own state: the Claude adapter says nothing, and the daemon knows it is waiting.
    if (record.kind === "request") {
      this.#remember(session, { attentionSeq: record.seq });
      return;
    }
    if (record.kind !== "update") return;
    const update = record.data as Record<string, unknown>;
    // Whether a turn is open on record, for a restart to find one that was cut short (docs/protocol.md §8).
    const turnOpen = opensOrEndsTurn(update);
    if (turnOpen !== undefined && session.entry.turnOpen !== turnOpen)
      this.#remember(session, { turnOpen }, false);
    // The person's first message: from now on the session is in the list.
    if (update.sessionUpdate === "user_message" && session.entry.prompted !== true) {
      this.#remember(session, { prompted: true });
      return;
    }
    if (update.sessionUpdate === "state_update") {
      // Worth seeing: the agent waits on the owner, or a turn has ended (an idle that says why: the
      // one the agent sends on resume is a snapshot, not an end). See docs/protocol.md §6.
      if (
        update.state === "requires_action" ||
        (update.state === "idle" && update.stopReason !== undefined)
      ) {
        // `#onUpdate` announces a change of state once the record is written: not twice.
        this.#remember(session, { attentionSeq: record.seq }, false);
        // A turn that has already been followed by the next (a queued prompt goes as the idle is written) is not the ended one.
        if (update.state === "idle") session.turnEnded = session.agentState === "idle";
      }
    }
  }

  /**
   * What an update tells the daemon about the session, beyond what it tells the client. Returns
   * false for an update that must not reach the log: an agent title the user has overruled, or one
   * the log already has.
   */
  #learn(session: Session, update: SessionUpdate): boolean {
    const u = update as {
      sessionUpdate: string;
      state?: string;
      stopReason?: string;
      title?: string | null;
      configOptions?: { configId?: string; currentValue?: unknown }[];
    };
    if (
      u.sessionUpdate === "state_update" &&
      u.state === "idle" &&
      u.stopReason === "end_turn" &&
      session.entry.hadTurn !== true
    ) {
      // A turn that was answered: the agent has a record of the session now. (A turn that failed, or was
      // cut off, may never have reached it; those prove nothing.)
      this.#remember(session, { hadTurn: true }, false);
    } else if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
      // The agent changed a setting itself (a plan approved, say) or announced its live model catalog:
      // keep changed values on record and cache the discovered model list for cold starts and blank sessions.
      const existing = session.entry.config ?? {};
      const next = currentValues(u.configOptions);
      const changed = Object.entries(next).some(([key, value]) => existing[key] !== value);
      if (changed) {
        this.#remember(session, { config: { ...existing, ...next } });
      }
      const models = choicesFromConfigOptions(u.configOptions, "model");
      if (models !== undefined) {
        void this.#optionsCache.update(session.entry.agent, "model", models).catch(() => undefined);
      }
    } else if (u.sessionUpdate === "usage_update") {
      const usage = SessionUsageSchema.safeParse(update);
      if (usage.success) {
        const { cost, ...rest } = usage.data;
        this.#remember(session, { usage: { ...rest, ...(cost ? { cost } : {}) } });
      }
    } else if (u.sessionUpdate === "session_info_update") {
      // The user's own name for a session wins over the agent's: a title that is not marked as the
      // agent's is the user's, which includes every title written before agents named sessions.
      const { title, titleFromAgent } = session.entry;
      // An agent that starts again says its title again: once is enough (if that is all it says).
      const said = Object.keys(update).filter((key) => key !== "sessionUpdate" && key !== "title");
      if (u.title === title && titleFromAgent === true && said.length === 0) return false;
      if (
        typeof u.title === "string" &&
        u.title !== "" &&
        (title === undefined || titleFromAgent === true)
      ) {
        this.#remember(session, { title: u.title, titleFromAgent: true });
      } else if (typeof u.title === "string") {
        // The user named it: clients are not told a different name, here or in a replay.
        return false;
      }
    }
    return true;
  }

  #remember(session: Session, patch: Partial<SessionEntry>, announce = true): void {
    session.entry = { ...session.entry, ...patch };
    // A session that is still being made is not in the index yet; it is put there with this entry.
    if (this.#index.get(session.id) === undefined) return;
    void this.#index.update(session.id, patch).then(
      () => {
        if (announce) this.#changed();
      },
      () => undefined,
    );
  }

  /**
   * A request asked or settled changed what the session is doing (it waits on the owner, or no longer does): the
   * clients attached are told, as a state snapshot like the one an attach ends with (docs/protocol.md §9). The agent
   * may say nothing of it, and a client that stayed must not see other than one that came back.
   */
  #stateChanged(session: Session, before: SessionStatus): void {
    if (session.status() === before || session.closed) return;
    const update = session.snapshot();
    for (const attachment of session.attachments) {
      if (!attachment.ready) continue;
      void attachment.conn
        .notify(SESSION_UPDATE, { sessionId: session.id, update })
        .catch(() => {});
    }
  }

  /** Puts a request to the clients, waits for the answer, and writes the request to the log. */
  async #ask(
    session: Session,
    method: string,
    params: Record<string, unknown>,
    how: { cancelled: unknown; answer: (response: unknown) => unknown },
  ): Promise<unknown> {
    // A stopping daemon puts nothing more to anyone: the agent is told no, as at a cancel.
    if (this.#closing) return how.cancelled;
    const requestId = session.nextRequestId();
    // The id is in _meta so a client can match `_cycle/request_resolved` to the dialog it is showing.
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    // What a client is shown has been through the same filter as what is kept: it is not the log that sends this.
    const clientParams = {
      ...redactParams(params),
      sessionId: session.id,
      _meta: { ...meta, [META.requestId]: requestId },
    };
    let resolve: (outcome: unknown) => void = () => {};
    const outcome = new Promise<unknown>((r) => {
      resolve = r;
    });
    const pending: Pending = {
      requestId,
      method,
      cancelled: how.cancelled,
      answer: how.answer,
      params: clientParams,
      settled: false,
      asked: new Set(),
      resolve,
    };
    const before = session.status();
    session.pending.set(requestId, pending);
    // Delivery is by the log: attached clients get it as the record is written. A request that
    // could not be written was shown to no one: the agent is told it was cancelled.
    const written = await this.#write(session, {
      kind: "request",
      data: { requestId, method, params: clientParams },
    });
    if (!written) {
      pending.settled = true;
      session.pending.delete(requestId);
      return how.cancelled;
    }
    this.#stateChanged(session, before);
    // A request written while nobody is attached waits here until a client attaches.
    return outcome;
  }

  async #onPermission(session: Session, params: Record<string, unknown>): Promise<unknown> {
    // Which sub-agent asks, when one does: the agent asks in that sub-agent's session (ACP v2), clients are asked in
    // the parent's and told whose it is (docs/protocol.md §9). Only the daemon says so: an agent's own word is dropped.
    const { [META.subagentId]: _said, ...meta } = (params._meta ?? {}) as Record<string, unknown>;
    const asker =
      typeof params.sessionId === "string" && session.isChild(params.sessionId)
        ? params.sessionId
        : undefined;
    params = {
      ...params,
      _meta: asker !== undefined ? { ...meta, [META.subagentId]: asker } : meta,
    };
    const outcome = await this.#ask(session, REQUEST_PERMISSION, params, {
      cancelled: { outcome: "cancelled" },
      answer: (response) => (response as { outcome: unknown }).outcome,
    });
    return { outcome };
  }

  /**
   * The agent asks for a form (docs/protocol.md §9, decision 0011). Only a client that said it can
   * answer one is asked, and if none is attached the agent is told so at once instead of waiting:
   * a question is not worth holding a turn for, and a client without the screen would never answer.
   */
  async #onElicitation(session: Session, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#canAskForms(session)) return { action: "cancel", _meta: { [META.noClient]: true } };
    return this.#ask(session, ELICITATION, params, {
      cancelled: { action: "cancel" },
      answer: elicitationAnswer,
    });
  }

  /** Asks one client, once. The first answer from any client settles it. */
  #offer(session: Session, pending: Pending, attachment: Attachment): void {
    if (pending.settled || pending.asked.has(attachment)) return;
    if (pending.method === ELICITATION && !attachment.conn.elicitation) return;
    pending.asked.add(attachment);
    attachment.conn
      .request(pending.method, pending.params)
      .then((answer) => this.#settle(session, pending, pending.answer(answer), attachment))
      .catch(() => {
        pending.asked.delete(attachment);
        // A client that cannot answer a form (its handler failed, or it went) is not going to: when
        // no other client has it, the agent is told so, as with no client at all (decision 0011).
        if (pending.method === ELICITATION && pending.asked.size === 0) {
          this.#settle(session, pending, { action: "cancel", _meta: { [META.noClient]: true } });
        }
      });
  }

  #settle(session: Session, pending: Pending, outcome: unknown, by?: Attachment): void {
    if (pending.settled) return;
    pending.settled = true;
    const before = session.status();
    session.pending.delete(pending.requestId);
    this.#stateChanged(session, before);
    // The session is no longer waiting on the owner: the list says so (the agent may say nothing).
    this.#changed();
    // What a person typed into a form can be a password or a token: the agent gets all of it, the
    // log and the other clients get that it was answered, and how.
    const shown = pending.method === ELICITATION ? withoutContent(outcome) : outcome;
    // The agent gets the answer once the answer is on record: a permission it was given that the
    // history does not show is worse than none. If the record cannot be written, it is told no.
    void this.#write(session, {
      kind: "response",
      data: { requestId: pending.requestId, outcome: shown, by: by?.conn.id ?? "daemon" },
    }).then((written) => {
      const given = written ? outcome : pending.cancelled;
      const told = written ? shown : pending.cancelled;
      pending.resolve(given);
      for (const other of pending.asked) {
        if (other === by) continue;
        void other.conn
          .notify(NOTIFICATIONS.requestResolved, {
            sessionId: session.id,
            requestId: pending.requestId,
            outcome: told,
          })
          .catch(() => {});
      }
    });
  }

  /**
   * A turn that ended in failure the agent did not report (it exited, or the prompt could not be sent) is put on record
   * as the end of the turn, once: that record is what makes the session unread. The list is announced again after it
   * is written, because a client that re-lists on the first announcement reads the row before the mark.
   */
  #endTurnWithError(session: Session, code: number, message: string): void {
    if (session.turnEnded) return;
    session.turnEnded = true;
    void this.#write(session, {
      kind: "update",
      data: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "error",
        error: { code, message },
      },
    }).then((written) => {
      if (written) this.#changed();
    });
  }

  /** Every request still waiting on the owner ends unanswered: aborted on record, cancelled to the agent and the clients asked. */
  #abortPending(session: Session): Promise<unknown> {
    const writes: Promise<boolean>[] = [];
    const before = session.status();
    for (const pending of [...session.pending.values()]) {
      pending.settled = true;
      session.pending.delete(pending.requestId);
      writes.push(
        this.#write(session, { kind: "aborted", data: { requestId: pending.requestId } }),
      );
      pending.resolve(pending.cancelled);
      for (const attachment of pending.asked) {
        void attachment.conn
          .notify(NOTIFICATIONS.requestResolved, {
            sessionId: session.id,
            requestId: pending.requestId,
            outcome: pending.cancelled,
          })
          .catch(() => {});
      }
    }
    this.#stateChanged(session, before);
    return Promise.all(writes);
  }

  /**
   * The daemon stops, or stopped, in the middle of a turn: the turn ends on record as interrupted (docs/protocol.md §8),
   * so the history does not stay at "working". What was queued is not handed back here: it stays, for the next client.
   */
  async #interrupt(session: Session, message: string): Promise<void> {
    this.#log.warn("turn_interrupted", {
      session: session.id,
      pending: session.pending.size,
      queued: session.queue.length,
    });
    await this.#abortPending(session);
    session.turnEnded = true;
    session.agentState = "idle";
    await this.#write(session, {
      kind: "update",
      data: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "error",
        error: { code: CycleErrorCode.DaemonStopped, message },
      },
    });
  }

  /**
   * A session loaded after a restart whose log has a turn that never ended: the daemon before this one stopped in the
   * middle of it without saying so (it crashed, was killed, or was older than this rule). Its end is put on record now.
   * The index says whether to look; an entry from before it said reads the log once.
   */
  async #endTurnLeftOpen(session: Session): Promise<void> {
    if (session.entry.turnOpen === false) return;
    let open: boolean;
    try {
      open = turnLeftOpen(await session.log.read(undefined, { stored: true }));
    } catch {
      // A log that cannot be read is reported where it is read; there is nothing to end here.
      return;
    }
    if (open) await this.#interrupt(session, "Cycle stopped while this turn was running");
    else this.#remember(session, { turnOpen: false }, false);
  }

  #onAgentClosed(session: Session, link: AgentLink | undefined): void {
    if (session.link !== link && link !== undefined) return;
    const wasWorking = session.agentState !== "idle";
    // Its exit code is in the agent's own lines; here, what it left behind.
    const closed = { session: session.id, working: wasWorking, pending: session.pending.size };
    if (wasWorking) this.#log.warn("agent_closed", closed);
    else this.#log.info("agent_closed", closed);
    session.link = undefined;
    // Its key to the gateway goes with it, and the connector processes it had.
    this.#connectors.release(session.id);
    this.#abortPending(session);
    void this.#write(session, { kind: "meta", data: { event: "agent_exited" } });
    // The sub-agents went with the process. The list is announced as changed at the end.
    session.endSubagents();
    if (wasWorking) {
      // Whoever is watching is told the turn is over, rather than left waiting for an idle.
      session.agentState = "idle";
      this.#endTurnWithError(session, CycleErrorCode.AgentExited, "The agent exited");
    }
    // What waits for an agent that is gone is handed back, after the idle that says why.
    this.#returnQueue(session, "error");
    this.#changed();
  }

  // ---- what a client sees ----

  #deliver(session: Session, attachment: Attachment) {
    return async (record: LogRecord) => {
      if (record.kind === "update") {
        const update = record.data as {
          sessionUpdate: string;
          entries?: QueueEntry[];
          returnId?: string;
        };
        await attachment.conn.notify(SESSION_UPDATE, {
          sessionId: session.id,
          update:
            update.sessionUpdate === QUEUE_UPDATE && update.returnId
              ? { sessionUpdate: QUEUE_UPDATE, entries: update.entries }
              : record.data,
          // The record's own time, as the log has it: the same live and in a replay (docs/protocol.md §5).
          _meta: { [META.seq]: record.seq, [META.ts]: record.ts },
        });
      } else if (record.kind === "request") {
        const id = (record.data as { requestId: string }).requestId;
        const pending = session.pending.get(id);
        if (pending !== undefined) this.#offer(session, pending, attachment);
      }
    };
  }

  /**
   * A session's row in the list, or undefined for one the person has not yet written to: a new session is a blank
   * conversation in the client until its first message, and only then is it in the list (docs/protocol.md §6).
   */
  async #row(sessionId: string, entry: SessionEntry, onlyPrompted: boolean) {
    const session = await this.#session(sessionId);
    // One whose history has failed is listed whatever it holds: the list is where it is deleted from.
    if (onlyPrompted && session.historyError === undefined && !(await this.#prompted(session)))
      return undefined;
    const background = session.backgroundCount();
    return {
      sessionId,
      cwd: entry.cwd,
      updatedAt: session.updatedAt(),
      _meta: {
        [META.archived]: entry.archived === true,
        [META.agent]: entry.agent,
        [META.state]: session.status(),
        [META.lastSeq]: session.log.lastSeq(),
        [META.unread]: session.unread(),
        ...(session.unknownBackground.size
          ? { [META.backgroundUnknown]: [...session.unknownBackground.keys()] }
          : {}),
        ...(background > 0 ? { [META.background]: background } : {}),
        ...(session.historyError !== undefined ? { [META.historyFailed]: true } : {}),
        ...(entry.config !== undefined ? { [META.config]: entry.config } : {}),
        ...(entry.usage !== undefined ? { [META.usage]: entry.usage } : {}),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
      },
    };
  }

  /**
   * Whether the person has said anything in the session. Known from the index, or for an entry written before the index
   * kept it, read once from the log and kept. A log that cannot be read throws, and the session is listed as unreadable.
   */
  async #prompted(session: Session): Promise<boolean> {
    if (session.entry.prompted !== undefined) return session.entry.prompted;
    // As stored: an image is not read back from its blob to find out whether there is a message.
    const records = await session.log.read(undefined, { stored: true });
    const prompted = records.some(isUserMessage);
    // A message written while the log was being read has set it already.
    if (session.entry.prompted === undefined) this.#remember(session, { prompted }, false);
    return session.entry.prompted ?? prompted;
  }

  /**
   * A session whose history cannot be read, as the list shows it: what the index knows, with no
   * `cycle/lastSeq` (that comes from the log) and no unread mark, and the marker.
   */
  #unreadableRow(sessionId: string, entry: SessionEntry) {
    return {
      sessionId,
      cwd: entry.cwd,
      updatedAt: entry.createdAt,
      _meta: {
        [META.archived]: entry.archived === true,
        [META.agent]: entry.agent,
        [META.state]: "stopped",
        [META.historyFailed]: true,
        ...(entry.config !== undefined ? { [META.config]: entry.config } : {}),
        ...(entry.usage !== undefined ? { [META.usage]: entry.usage } : {}),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
      },
    };
  }

  /** The app a client talks to: this connection's view of the daemon. */
  #facing(holder: { value?: ClientConn }) {
    const me = (): ClientConn => {
      if (holder.value === undefined) throw new Error("connection not ready");
      return holder.value;
    };
    const app = acpAgent({ name: "cycle" });

    app.onRequest(methods.agent.initialize, async ({ params }) => {
      const requested = (params._meta as Record<string, unknown> | null | undefined)?.[
        META.protocolVersion
      ];
      // Whether this client can answer a form: only then is it asked one (decision 0011).
      me().ackReturns = params._meta?.[META.ackReturns] === true;
      me().elicitation = params.capabilities?.elicitation?.form != null;
      if (
        typeof requested === "string" &&
        requested.split(".")[0] !== CYCLE_PROTOCOL_VERSION.split(".")[0]
      ) {
        throw new RpcError(UNSUPPORTED_VERSION, "Unsupported Cycle protocol version", {
          supported: [CYCLE_PROTOCOL_VERSION],
          requested,
        });
      }
      return {
        protocolVersion: 2,
        info: { name: "cycle", version: this.#version },
        capabilities: { session: {} },
        _meta: {
          [META.protocolVersion]: CYCLE_PROTOCOL_VERSION,
          [META.capabilities]: {
            replay: ["start", "_cycle.seq"],
            agents: [...this.#agents.keys()],
            sessionListPages: true,
            sessionOps: ["archive", "rename", "delete", "markRead", "stopSubagent"],
            queue: true,
            steer: true,
            files: true,
            folders: true,
            filesInFolder: true,
            fs: true,
            diff: true,
            trust: true,
            connectors: true,
            plugins: this.#plugins.agents(),
            planUsage: true,
            sessionMentions: true,
            terminal: true,
          },
        },
      } as never;
    });

    app.onRequest(methods.agent.session.new, async ({ params }) => {
      const meta = (params._meta ?? {}) as Record<string, unknown>;
      const agentId =
        typeof meta[META.agent] === "string"
          ? (meta[META.agent] as string)
          : [...this.#agents.keys()][0];
      if (agentId === undefined)
        throw new RpcError(CycleErrorCode.AgentUnavailable, "No agent is configured");
      const definition = this.#definition(agentId);
      const overrides = checkedConfig(
        definition,
        meta[META.config] === undefined ? {} : meta[META.config],
      );
      // The directories are paths on THIS machine (the daemon's), not the client's. Say so up front.
      const directories = [params.cwd, ...(params.additionalDirectories ?? [])];
      for (const [index, directory] of directories.entries()) {
        if (!isAbsolute(directory)) {
          throw new RpcError(
            INVALID_PARAMS,
            `The ${index === 0 ? "working directory" : "directory"} ${directory} is not an absolute path`,
          );
        }
        if (
          !(await stat(directory).then(
            (s) => s.isDirectory(),
            () => false,
          ))
        )
          throw new RpcError(
            INVALID_PARAMS,
            `The ${index === 0 ? "working directory" : "directory"} ${directory} does not exist on the machine the daemon runs on`,
          );
      }
      const id = randomUUID();
      const entry: SessionEntry = {
        agent: agentId,
        agentSessionId: id,
        cwd: params.cwd,
        createdAt: new Date().toISOString(),
        // Not in the list until the person's first message is on record (docs/protocol.md §6).
        prompted: false,
        turnOpen: false,
        // Kept to send again each time the agent starts. Not in the log: that goes to every client.
        ...(params.additionalDirectories?.length
          ? { additionalDirectories: params.additionalDirectories }
          : {}),
        ...(params.mcpServers?.length ? { mcpServers: params.mcpServers } : {}),
        ...(params.systemPrompt != null ? { systemPrompt: params.systemPrompt } : {}),
      };
      const log = await this.#store.open(id);
      const session = new Session(id, entry, log);
      this.#watch(session);
      try {
        await log.append({
          kind: "meta",
          data: { event: "created", agent: agentId, cwd: params.cwd },
        });
        const { link, created } = await this.#startAgent(session, "new", {
          cwd: params.cwd,
          additionalDirectories: params.additionalDirectories,
          mcpServers: params.mcpServers,
          systemPrompt: params.systemPrompt,
        });
        const answer = created as { sessionId: string; configOptions?: unknown[] };
        session.entry = { ...session.entry, agentSessionId: answer.sessionId };
        // What the user set as the agent's defaults, then what they asked of this one.
        const config = { ...this.#defaults.get(agentId), ...overrides };
        // What the agent says its settings are now: each change answers with the whole set.
        let options = answer.configOptions ?? [];
        for (const [configId, value] of orderedConfigEntries(config)) {
          try {
            const changed = await link.agent.request(methods.agent.session.setConfigOption, {
              sessionId: session.entry.agentSessionId,
              configId,
              type: "id",
              value,
            } as never);
            const latest = (changed as { configOptions?: unknown[] } | undefined)?.configOptions;
            if (Array.isArray(latest) && latest.length > 0) options = latest;
          } catch (error) {
            throw new RpcError(
              CycleErrorCode.InvalidConfig,
              "The agent refused the configuration",
              {
                configId,
                detail: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        // On record with what the agent started in, not only what was set: a resume sends it again,
        // so a session keeps its mode even if the agent's default for new ones changes. What the
        // agent reported meanwhile (a mode it fell back to) is newer than its first answer.
        const recorded = {
          ...currentValues(options),
          ...(session.entry.config ?? {}),
          ...config,
        };
        if (Object.keys(recorded).length > 0) {
          session.entry = { ...session.entry, config: recorded };
        }
        // Publish the session only after every requested setting has been accepted.
        this.#sessions.set(id, session);
        session.lastActive = this.#now();
        await this.#index.put(id, session.entry);
        this.#changed();
        this.#letGoOfOldestAhead(session);
        return { sessionId: id, configOptions: options } as never;
      } catch (error) {
        session.closed = true;
        session.link?.kill();
        this.#sessions.delete(id);
        await log.close();
        await this.#index.delete(id).catch(() => undefined);
        await this.#store.remove(id).catch(() => undefined);
        throw error;
      }
    });

    app.onRequest(methods.agent.session.list, async ({ params }) => {
      // Only a client that asks leaves out the sessions nothing has been said in: an older one opens a session it has
      // just made by finding it in the list (docs/protocol.md §6).
      const said =
        (params?._meta as Record<string, unknown> | null | undefined)?.[META.onlyPrompted] === true;
      const rows = [];
      const page = sessionPage(this.#index, params ?? {});
      for (const [sessionId, entry] of page.entries) {
        try {
          const row = await this.#row(sessionId, entry, said);
          if (row !== undefined) rows.push(row);
        } catch (error) {
          // Deleted while the list was being read.
          if (error instanceof RpcError && error.code === RESOURCE_NOT_FOUND) continue;
          // One session whose history cannot be read is that session's problem, not the list's: it
          // is listed, marked, and says so when it is opened. Anything else is the list's.
          if (!(error instanceof RpcError) || error.code !== CycleErrorCode.LogUnavailable)
            throw error;
          rows.push(this.#unreadableRow(sessionId, entry));
        }
      }
      return { sessions: rows, nextCursor: page.nextCursor } as never;
    });

    app.onRequest(methods.agent.session.resume, async ({ params }) => {
      const session = await this.#session(params.sessionId);
      const raw = params.replayFrom as { type?: string } | null | undefined;
      let after = session.log.lastSeq();
      let replaying = false;
      if (raw !== undefined && raw !== null) {
        replaying = true;
        if (raw.type === "start") after = 0;
        else if (raw.type === "_cycle.seq") {
          const parsed = ReplayFromSeqSchema.safeParse(raw);
          if (!parsed.success)
            throw new RpcError(INVALID_PARAMS, "Bad replayFrom", { replayFrom: raw });
          after = parsed.data.after;
        } else throw new RpcError(INVALID_PARAMS, "Unknown replayFrom", { replayFrom: raw });
      }
      const conn = me();
      for (const old of session.attachments) {
        if (old.conn === conn) {
          old.detach();
          session.attachments.delete(old);
        }
      }
      const attachment: Attachment = { conn, ready: false, detach: () => {} };
      session.attachments.add(attachment);
      session.lastActive = this.#now();
      const deliver = this.#deliver(session, attachment);
      try {
        const { detach } = await attach(session.log, after, deliver, async (replayedTo) => {
          // ACP v2: the replay is ended by one replay_complete, then the current state.
          if (replaying) {
            await conn.notify(SESSION_UPDATE, {
              sessionId: session.id,
              update: { sessionUpdate: "replay_complete" },
              _meta: { [META.seq]: replayedTo },
            });
          }
          await conn.notify(SESSION_UPDATE, { sessionId: session.id, update: session.snapshot() });
        });
        attachment.detach = detach;
      } catch (error) {
        session.attachments.delete(attachment);
        throw error;
      }
      // Requests still waiting from before are asked of this client too.
      for (const pending of session.pending.values()) this.#offer(session, pending, attachment);
      // A queue with no turn behind it was cut short by a restart. It is handed back now, after the
      // replay and the snapshot, so the client that attached is told while it is listening.
      attachment.ready = true;
      this.#returnStale(session);
      this.#offerReturn(session);
      // Which they are, so a client that had one before can tell it is not among them: answered elsewhere.
      return {
        configOptions: [],
        _meta: {
          [META.pending]: [...session.pending.values()]
            .filter((pending) => pending.asked.has(attachment))
            .map((pending) => pending.requestId),
        },
      } as never;
    });

    app.onRequest(methods.agent.session.prompt, async ({ params }) => {
      const session = await this.#session(params.sessionId);
      // A turn that could not be written down is not started: it would be lost on the next restart.
      if (session.historyError !== undefined)
        throw logUnavailable(session.id, session.historyError);
      // Refused whole, before anything is started or written: a block is never dropped (decision 0010).
      const problem = checkPrompt(
        params.prompt,
        this.#definition(session.entry.agent).promptCapabilities,
      );
      if (problem !== undefined)
        throw new RpcError(INVALID_PARAMS, `The prompt cannot be sent: ${problem.reason}`, {
          sessionId: session.id,
          ...problem,
        });
      this.#returnStale(session);
      // Taken: from now on the session is in the list (docs/protocol.md §6), whatever the agent makes of it. Not left to
      // the agent's echo of the message, which an agent that fails, or never echoes, would not send. Announced below.
      if (session.entry.prompted !== true) this.#remember(session, { prompted: true }, false);
      const busy = () => session.status() !== "idle" && session.status() !== "stopped";
      const steer = (params._meta as Record<string, unknown> | null | undefined)?.[META.steer];
      if (busy() && steer === true) {
        // Into the running turn, where the agent can take it; otherwise it is queued as any other.
        const steered = await this.#steer(session, params.prompt);
        if (steered !== undefined) return steered as never;
      }
      if (busy()) {
        // The agent is busy: the prompt waits here, and goes when the turn ends well.
        if (session.queue.length >= QUEUE_LIMIT) throw queueFull(session.id, QUEUE_LIMIT);
        const queueId = randomUUID();
        const queued = { queueId, prompt: params.prompt };
        session.queue.push(queued);
        if (!(await this.#publishQueue(session))) {
          // Not on record, so not taken: the sender keeps what they wrote, and the queue is as it was.
          // (If the turn has ended meanwhile and sent it, it is gone from the queue and is not undone.)
          const at = session.queue.indexOf(queued);
          if (at >= 0) {
            session.queue.splice(at, 1);
            throw logUnavailable(session.id, session.historyError ?? HISTORY_NOT_SAVED);
          }
        }
        return { messageId: queueId, _meta: { [META.queued]: true } } as never;
      }
      // Marked at once: the agent's own "running" comes later, and a second prompt must not slip in.
      session.agentState = "running";
      session.turnEnded = false;
      this.#changed();
      try {
        return (await this.#send(session, params.prompt)) as never;
      } catch (error) {
        this.#promptFailed(session, error);
        // The prompt never reached the agent, so no turn will end to send or return what was queued behind it.
        this.#returnQueue(session, "error");
        throw error;
      }
    });

    app.onNotification(methods.agent.session.cancel, async ({ params }) => {
      const session = this.#sessions.get(params.sessionId);
      if (session === undefined) return;
      // ACP: every pending permission request is answered "cancelled" when a turn is cancelled.
      for (const pending of [...session.pending.values()])
        this.#settle(session, pending, pending.cancelled);
      // A stop means the person wants to change direction: what waits goes back to the input box.
      this.#returnQueue(session, "cancelled");
      // The agent is still starting, or a prompt is still being made ready: there is no turn to stop, so what is about to
      // be given to it is held back.
      if (session.starting !== undefined || session.preparing > 0) session.startingCancels++;
      await session.link?.agent
        .notify(methods.agent.session.cancel, { sessionId: session.entry.agentSessionId } as never)
        .catch(() => undefined);
    });

    app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      const session = await this.#session(params.sessionId);
      const link = await this.#ensureAgent(session);
      const answer = await link.agent.request(methods.agent.session.setConfigOption, {
        ...params,
        sessionId: session.entry.agentSessionId,
      } as never);
      const value = "value" in params ? params.value : undefined;
      if (typeof value === "string") {
        const config = { ...(session.entry.config ?? {}), [params.configId]: value };
        session.entry = { ...session.entry, config };
        await this.#index.update(session.id, { config });
        this.#changed();
      }
      return answer as never;
    });

    app.onRequest(methods.agent.session.close, async ({ params }) => {
      const session = this.#sessions.get(params.sessionId);
      if (session !== undefined) this.#returnQueue(session, "closed");
      session?.link?.kill();
      return {} as never;
    });

    app.onRequest(methods.agent.session.delete, async ({ params }) => {
      let session: Session;
      try {
        session = await this.#session(params.sessionId);
      } catch (error) {
        // A session whose history cannot be read can still be deleted: it is the way out of it.
        if (!(error instanceof RpcError) || error.code !== CycleErrorCode.LogUnavailable)
          throw error;
        try {
          await this.#index.delete(params.sessionId);
          await this.#store.remove(params.sessionId);
        } finally {
          this.#changed();
        }
        return {} as never;
      }
      if (session.status() === "running" || session.status() === "requires_action")
        throw sessionBusy(session.id);
      session.closed = true;
      session.link?.kill();
      for (const attachment of session.attachments) attachment.detach();
      // Gone from the list now; their processes end on their own time, not the answer's.
      void this.#terminals.closeSession(session.id);
      try {
        // The index first, and the session out of the table at once: from then on nobody can load
        // it again or get hold of it (a list that was being read, a client that was reconnecting),
        // so none comes back from the dead while its log is being removed.
        await this.#index.delete(session.id);
        this.#sessions.delete(session.id);
        await session.log.close();
        await this.#store.remove(session.id);
      } finally {
        this.#changed();
      }
      return {} as never;
    });

    // The handler answers what the method's result schema says: a field the schema has and the handler leaves out
    // (or one of another shape) does not compile.
    const cycle = <P extends z.ZodType, R extends z.ZodType>(
      method: CycleMethod<P, R>,
      handler: (params: z.output<P>) => Promise<z.input<R>> | z.input<R>,
    ) => {
      app.onRequest(
        method.name as `_${string}`,
        method.params,
        async ({ params }) => (await handler(params as z.output<P>)) as never,
      );
    };

    cycle(agentsList, async () => ({
      agents: await Promise.all(
        [...this.#agents.values()].map(async (a) => ({
          id: a.id,
          name: a.name,
          available: (await a.available?.()) ?? true,
          configSchema: this.#optionsCache.apply(a.id, a.configSchema),
          ...(a.promptCapabilities !== undefined
            ? { promptCapabilities: a.promptCapabilities }
            : {}),
          ...(a.steer === true ? { steer: true } : {}),
        })),
      ),
    }));
    cycle(planUsageRead, () => ({ agents: Object.fromEntries(this.#planUsage) }));
    cycle(agentDefaultsRead, (params) => {
      this.#definition(params.agent);
      return { config: this.#defaults.get(params.agent) };
    });
    cycle(agentDefaultsSet, async (params) => {
      const definition = this.#definition(params.agent);
      await this.#defaults.set(params.agent, checkedConfig(definition, params.config));
      for (const conn of this.#conns) {
        void conn
          .notify(NOTIFICATIONS.agentDefaultsChanged, { agent: params.agent })
          .catch(() => {});
      }
      return {};
    });

    const change =
      (apply: (session: Session) => Promise<Partial<SessionEntry>>) =>
      async (params: { sessionId: string }) => {
        const session = await this.#session(params.sessionId);
        const patch = await apply(session);
        session.entry = { ...session.entry, ...patch };
        await this.#index.update(session.id, patch);
        this.#changed();
        return {};
      };
    cycle(sessionDismissBackground, async ({ sessionId, taskIds }) => {
      const session = await this.#session(sessionId);
      let dismissed = 0;
      for (const id of new Set(taskIds)) {
        const task = session.unknownBackground.get(id);
        if (!task || task.dismissing) continue;
        task.dismissing = true;
        if (
          !(await this.#write(session, {
            kind: "update",
            data: {
              sessionUpdate: "subagent_update",
              sessionId: id,
              _meta: { [META.subagent]: { toolCallId: task.toolCallId, status: "dismissed" } },
            },
          }))
        ) {
          task.dismissing = false;
          throw logUnavailable(sessionId, session.historyError ?? HISTORY_NOT_SAVED);
        }
        if (session.unknownBackground.get(id) === task) session.unknownBackground.delete(id);
        dismissed++;
      }
      if (dismissed) this.#changed();
      return { dismissed };
    });
    cycle(sessionStopSubagent, async ({ sessionId, childId }) => {
      const session = await this.#session(sessionId);
      // Only a sub-agent the agent said can be stopped, that is running, of an agent that is there (docs/protocol.md §9).
      const link = session.link;
      // Never the session's own id: a cancel in it is the turn's, and a stop must not end the turn.
      if (
        link === undefined ||
        childId === session.entry.agentSessionId ||
        !session.canStop(childId)
      )
        return { stopping: false };
      // ACP v2: a cancel in the child's own session stops that child, not the turn. Its end comes as its subagent_update.
      await link.agent
        .notify(methods.agent.session.cancel, { sessionId: childId } as never)
        .catch(() => undefined);
      this.#log.info("subagent_stop_asked", { session: session.id });
      return { stopping: true };
    });
    cycle(promptAckReturn, async ({ sessionId, returnId }) => {
      return {
        acknowledged: await this.#ackReturn(await this.#session(sessionId), me(), returnId),
      };
    });
    cycle(promptDequeue, async (params) => {
      const session = await this.#session(params.sessionId);
      const at = session.queue.findIndex((entry) => entry.queueId === params.queueId);
      const [entry] = at < 0 ? [] : session.queue.splice(at, 1);
      if (entry === undefined) {
        throw new RpcError(CycleErrorCode.NotQueued, "That prompt is not waiting", {
          sessionId: session.id,
          queueId: params.queueId,
        });
      }
      if (!(await this.#publishQueue(session))) {
        // Not on record: the prompt stays where it was, and the person is told it did not come back.
        session.queue.splice(Math.min(at, session.queue.length), 0, entry);
        throw logUnavailable(session.id, session.historyError ?? HISTORY_NOT_SAVED);
      }
      return { prompt: entry.prompt };
    });
    cycle(filesSearch, async (params) => {
      // A conversation with no session yet looks in the folder it has chosen: the same search, the same bounds.
      let cwd: string;
      if (params.cwd !== undefined) {
        if (!isAbsolute(params.cwd) || params.cwd.includes("\0"))
          throw new RpcError(INVALID_PARAMS, "cwd must be an absolute path", { cwd: params.cwd });
        cwd = params.cwd;
      } else {
        cwd = (await this.#session(params.sessionId as string)).entry.cwd;
      }
      const found = await searchFiles(cwd, params.query, params.limit);
      return { root: cwd, ...found };
    });
    cycle(foldersList, (params) => listFolders(params.path, params.hidden === true));
    cycle(fsList, (params) =>
      // Git says what it ignores only for a repository the person trusts, since it reads that repository's
      // configuration (.agents/notes/2026-11-22-files-and-diff-sources.md).
      listFolder(this.#cwdOf(params.sessionId), params.path, (dir, names) =>
        ignoredNames(dir, names, (repository) => this.#trust.of(repository).trusted === true),
      ),
    );
    cycle(fsRead, (params) => readFile(this.#cwdOf(params.sessionId), params.path, params.offset));
    // Git runs only for a repository the person trusts (.agents/notes/2026-11-22-files-and-diff-sources.md).
    const trusted = (repository: string) => this.#trust.of(repository).trusted === true;
    cycle(diffStatus, (params) => workspaceStatus(this.#cwdOf(params.sessionId), trusted));
    cycle(diffFile, (params) => workspaceFile(this.#cwdOf(params.sessionId), params.path, trusted));
    // Terminals (docs/protocol.md §8 "终端"): this connection is where their output goes.
    const sink = (): TerminalSink => {
      const conn = me();
      return { id: conn.id, send: (method, params) => conn.notify(method, params) };
    };
    // From the index: a session does not have to be loaded (its history read) to have terminals.
    cycle(terminalCreate, (params) => {
      const cwd = this.#cwdOf(params.sessionId);
      if (this.#index.get(params.sessionId)?.archived === true)
        throw new RpcError(INVALID_PARAMS, "The session is archived", {
          sessionId: params.sessionId,
          reason: "archived",
        });
      return this.#terminals.create(params.sessionId, cwd, params.cols, params.rows, sink());
    });
    cycle(terminalList, (params) => {
      this.#cwdOf(params.sessionId);
      return { terminals: this.#terminals.list(params.sessionId) };
    });
    cycle(terminalAttach, (params) => this.#terminals.attach(params.terminalId, sink()));
    cycle(terminalDetach, (params) => {
      this.#terminals.detach(params.terminalId, me().id);
      return {};
    });
    cycle(terminalInput, (params) => {
      this.#terminals.input(params.terminalId, params.data);
      return {};
    });
    cycle(terminalResize, (params) => {
      this.#terminals.resize(params.terminalId, params.cols, params.rows);
      return {};
    });
    cycle(terminalClose, async (params) => {
      await this.#terminals.close(params.terminalId);
      return {};
    });
    cycle(trustRead, async (params) => this.#trust.of(await realFolder(params.path)));
    cycle(trustSet, async (params) => {
      const real = await realFolder(params.path);
      const trust = await this.#trust.set(real, params.trusted);
      await this.#applyTrust(real);
      return trust;
    });
    // Plugins (docs/protocol.md §15): each agent's own, done by that agent's machinery.
    cycle(pluginsList, (params) => this.#plugins.list(params.agentId));
    cycle(pluginsAvailable, (params) => this.#plugins.available(params));
    cycle(pluginsInstall, async (params) => ({
      plugin: await this.#plugins.install(params.agentId, params.id),
    }));
    cycle(pluginsUninstall, async (params) => {
      await this.#plugins.uninstall(params.agentId, params.id);
      return {};
    });
    cycle(pluginsUpdate, (params) => this.#plugins.update(params.agentId, params.id));
    cycle(pluginsSetEnabled, async (params) => ({
      plugin: await this.#plugins.setEnabled(params.agentId, params.id, params.enabled),
    }));
    cycle(pluginSourcesAdd, async (params) => ({
      source: await this.#plugins.addSource(params.agentId, params.location),
    }));
    cycle(pluginSourcesRemove, async (params) => {
      await this.#plugins.removeSource(params.agentId, params.id);
      return {};
    });
    cycle(pluginSourcesRefresh, async (params) => {
      await this.#plugins.refreshSource(params.agentId, params.id);
      return {};
    });
    cycle(connectorsList, async () => ({ connectors: await this.#connectors.list() }));
    cycle(connectorsAdd, async (params) => ({ connector: await this.#connectors.add(params) }));
    cycle(connectorsUpdate, async (params) => ({
      connector: await this.#connectors.update(params),
    }));
    cycle(connectorsRemove, async (params) => {
      await this.#connectors.remove(params.id);
      return {};
    });
    cycle(connectorsAuthStart, (params) =>
      this.#connectors.authStart(params.id, params.redirectUri),
    );
    cycle(connectorsAuthFinish, async (params) => ({
      connector: await this.#connectors.authFinish(params),
    }));
    cycle(connectorsAuthClear, async (params) => ({
      connector: await this.#connectors.authClear(params.id),
    }));
    cycle(sessionArchive, (params) =>
      change(async (session) => {
        if (session.status() === "running" || session.status() === "requires_action")
          throw sessionBusy(session.id);
        return { archived: true };
      })(params).then((done) => {
        // An archived session's terminals go with it (docs/protocol.md §8 "终端"): off the list now, their
        // processes ended in the background.
        void this.#terminals.closeSession(params.sessionId);
        return done;
      }),
    );
    cycle(sessionUnarchive, (params) => change(async () => ({ archived: false }))(params));
    cycle(sessionMarkRead, async (params) => {
      const session = await this.#session(params.sessionId);
      const lastSeq = session.log.lastSeq();
      if (params.seq > lastSeq) {
        throw new RpcError(INVALID_PARAMS, "seq is past the session's last record", {
          sessionId: session.id,
          seq: params.seq,
          lastSeq,
        });
      }
      const before = session.entry.readSeq ?? 0;
      if (params.seq <= before) return {};
      const unread = session.unread();
      // On disk first: if that fails, what the list says and what a restart reads stay the same.
      // Decided in the index's queue, so a lower mark that arrives meanwhile cannot undo this one.
      await this.#index.update(session.id, (entry) => ({
        readSeq: Math.max(entry.readSeq ?? 0, params.seq),
      }));
      const readSeq = this.#index.get(session.id)?.readSeq ?? params.seq;
      session.entry = { ...session.entry, readSeq };
      if (session.unread() !== unread) this.#changed();
      return {};
    });
    cycle(sessionSetTitle, (params) =>
      change(async () => ({ title: params.title, titleFromAgent: false }))(params),
    );

    return app;
  }
}

/** A record of something the person said: the agent's echo of a prompt (docs/protocol.md §8). */
const isUserMessage = (record: LogRecord): boolean =>
  record.kind === "update" &&
  (record.data as { sessionUpdate?: unknown } | null)?.sessionUpdate === "user_message";
