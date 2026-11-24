import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type AgentContext,
  type ClientApp,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type McpServer,
  methods,
  type NewSessionRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
  AGENT_AUTH_COMPLETED,
  AGENT_SETUP_CHANGED,
  type AgentAuthMode,
  type AgentRuntimePatchValue,
  type AgentSetupSnapshot,
  CHILD_UPDATE,
  CHILD_UPDATE_KINDS,
  type ChildUpdate,
  CONNECTORS_CHANGED,
  CycleErrorCode,
  META,
  NOTIFICATIONS,
  PLAN_USAGE_CHANGED,
  PLAN_USAGE_UPDATE,
  PLUGINS_CHANGED,
  type PlanUsage,
  PlanUsageSchema,
  type PlanWindow,
  PROMPT_SUGGESTION_UPDATE,
  PromptSuggestionUpdateSchema,
  QUEUE_UPDATE,
  type QueueEntry,
  type QueueReason,
  QueueUpdateSchema,
  type RuntimeProperty,
  SessionUsageSchema,
  TASK_UPDATE,
  TERMINAL_NOTIFICATIONS,
} from "@cycle/protocol";
import {
  asPrompt,
  clientConn,
  elicitationAnswer,
  madeWith,
  PERMISSION_CANCELLED,
  permissionOutcome,
} from "./acp.ts";
import { AgentAuthManager } from "./agent-auth.ts";
import { AgentLink, type LinkHandlers } from "./agent-link.ts";
import {
  AGENT_SETTINGS_UNREADABLE,
  AgentSettings,
  AgentSettingsConflictError,
  AgentSettingsCorruptError,
  AgentSettingsValidationError,
} from "./agent-settings.ts";
import {
  type ConfigFileSnapshotOptions,
  captureConfigMtime,
  loginCommandFor,
  readConfigFileStatus,
} from "./agent-setup.ts";
import type { AgentDefinition } from "./agents.ts";
import { Clients } from "./clients.ts";
import { commandsKey, isCommandsData } from "./commands-update.ts";
import { TERMINAL_DEFAULTS } from "./config.ts";
import { ConnectorService } from "./connectors/service.ts";
import {
  agentSettingsPath,
  blobsDir,
  defaultsPath,
  indexPath,
  optionsCachePath,
  providersPath,
  sessionsDir,
  trustPath,
} from "./data-dir.ts";
import { AgentDefaults } from "./defaults-file.ts";
import { sessionVariables } from "./environment.ts";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  logUnavailable,
  RpcError,
  sessionNotFound,
} from "./errors.ts";
import type { Core } from "./facing/core.ts";
import { facing } from "./facing/index.ts";
import { type SessionEntry, SessionIndex } from "./index-file.ts";
import { BlobLogStore } from "./log/blobs.ts";
import { JsonlLogStore } from "./log/jsonl.ts";
import type { LogRecord, LogStore, NewRecord } from "./log/types.ts";
import { errorText, type Logger, silentLogger } from "./logger.ts";
import { AgentOptionsCache, choicesFromConfigOptions } from "./options-cache.ts";
import { type BuiltinBundle, type PluginProvider, PluginService } from "./plugins.ts";
import { ModelProviders } from "./providers.ts";
import { redactParams, redactRecord } from "./redact.ts";
import {
  type Attachment,
  type ClientConn,
  HISTORY_NOT_SAVED,
  type Pending,
  Session,
  type SessionStatus,
} from "./session.ts";
import { currentValues, orderedConfigEntries } from "./session-config.ts";
import {
  collapseSessionMentions,
  expandSessionMentions,
  type Mentioned,
  mentionsSession,
} from "./session-mentions.ts";
import type { AgentHome } from "./storage.ts";
import {
  accountShell,
  Terminals,
  type TerminalsOptions,
  terminalEnv,
  terminalShell,
} from "./terminals.ts";
import { checkToolResult } from "./tool-result.ts";
import { FolderTrust, realFolder, within } from "./trust-file.ts";
import { type Activity, isUserMessage, opensOrEndsTurn, turnLeftOpen } from "./turns.ts";
import { worktreeHost } from "./worktree-host.ts";

/**
 * Makes the agents with the daemon's own live runtime settings (`<dataDir>/agent-settings.json`): the one instance
 * `_cycle/agent_setup/set_runtime` writes, so what harnesses read at each start (env, `maxAhead`) is what was saved.
 */
export type AgentsFactory = (
  agentSettings: AgentSettings,
  providers: ModelProviders,
) => AgentDefinition[];

export type DaemonOptions = {
  /** Each agent's home as the daemon gives it, for `_cycle/storage/*`. Default: none, so nothing is measured or cleared. */
  agentHomes?: () => AgentHome[];
  /** Where the daemon keeps its data. Always given: nothing here guesses a home. */
  dataDir: string;
  /** The agents it runs (`Daemon.start` also takes an `AgentsFactory`, which is what `agentsFor` returns). */
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
  /**
   * The same for a session a client is still attached to (the desktop never detaches from one it has shown, so
   * without this its agent would live as long as the app does, CYC-297). Never, when not given.
   */
  attachedAgentIdleMs?: number;
  /** How long an agent started ahead (`prewarmAgent`) waits for a session to take it before it is let go. Default 5 minutes. */
  standbyMs?: number;
  /** For tests: the clock idle times are measured by. */
  now?: () => number;
  /** For tests: replaces the connectors kept in `$CYCLE_HOME/connectors/` (docs/protocol.md §14). */
  connectors?: ConnectorService;
  /** Where what it does and what goes wrong is told (docs/daemon.md "日志"): events and ids, never content. */
  log?: Logger;
  /**
   * The terminals' shell, environment and limits (docs/protocol.md §8 "终端"). Default: the daemon's `SHELL`
   * (else the account's) and the default allowlist over its environment, with the default limits.
   */
  terminals?: Omit<TerminalsOptions, "onChanged" | "log">;
  /** Host `config.json` path & startup mtime for read-only diagnostics (docs/protocol.md §16). */
  configFile?: ConfigFileSnapshotOptions;
  /** For tests: override the 10-minute TTL on in-app agent auth flows. */
  authFlowTtlMs?: number;
  /** The plugins that ship with Cycle: installed for each agent in the background once started. Default: none. */
  builtinPlugins?: BuiltinBundle;
};

/** The terminals' settings when the daemon is given none: what `config.json` defaults to. */
export const defaultTerminals = (
  environment: Record<string, string | undefined>,
  settings: typeof TERMINAL_DEFAULTS = TERMINAL_DEFAULTS,
): Omit<TerminalsOptions, "onChanged" | "log"> => ({
  env: terminalEnv(settings.allowEnv, environment),
  shell: terminalShell(environment.SHELL, accountShell),
  maxPerSession: settings.maxPerSession,
  max: settings.max,
  scrollback: settings.scrollback,
});

/** How long an agent started ahead of any session waits to be taken over (`Daemon.prewarmAgent`). */
const STANDBY_MS = 5 * 60_000;

const SESSION_UPDATE = methods.client.session.update;
const REQUEST_PERMISSION = methods.client.session.requestPermission;
const ELICITATION = methods.client.elicitation.create;

const withoutContent = (outcome: unknown): unknown => {
  if (typeof outcome !== "object" || outcome === null) return outcome;
  const { content: _content, ...rest } = outcome as Record<string, unknown>;
  return rest;
};

/**
 * The daemon: Cycle's side of docs/protocol.md. It owns the sessions and their history, runs the
 * agents, and serves any number of clients. A client sees a session through the session's log, so
 * replay and live updates are one path. What a client can ask of it is registered by the modules in
 * src/facing/, one per part of the protocol; the daemon gives them its `Core` and assembles them.
 */
export class Daemon {
  readonly #version: string;
  readonly #dataDir: string;
  readonly #agentHomes: () => AgentHome[];
  readonly #configFile: ConfigFileSnapshotOptions;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #store: LogStore;
  readonly #index: SessionIndex;
  readonly #defaults: AgentDefaults;
  readonly #agentSettings: AgentSettings;
  readonly #auth: AgentAuthManager;
  readonly #optionsCache: AgentOptionsCache;
  readonly #trust: FolderTrust;
  readonly #modelProviders: ModelProviders;
  readonly #connectors: ConnectorService;
  readonly #plugins: PluginService;
  readonly #terminals: Terminals;
  readonly #agentIdleMs: number | undefined;
  readonly #attachedAgentIdleMs: number | undefined;
  readonly #standbyMs: number;
  /** Agents started ahead of any session (`prewarmAgent`): one each at most, taken over by the next session to start. */
  readonly #standby = new Map<string, { link: AgentLink; timer: ReturnType<typeof setTimeout> }>();
  readonly #standbyStarting = new Map<string, Promise<void>>();
  readonly #now: () => number;
  /** When the daemon started, or a client last connected or left: where an idle daemon starts counting. */
  #lastClientAt: number;
  readonly #log: Logger;
  readonly #sessions = new Map<string, Session>();
  /** Sessions being loaded, so a second request for one waits for the first load. */
  readonly #loading = new Map<string, Promise<Session>>();
  readonly #clients: Clients;
  /** What the client-facing modules reach of the daemon (src/facing/). */
  readonly #core: Core;
  /** The latest plan usage each agent told, since the daemon started (docs/protocol.md §8 "套餐用量"). */
  readonly #planUsage = new Map<string, PlanUsage>();
  /** The same, limit by limit, with when each was told: what a newer word replaces. */
  readonly #planLimits = new Map<string, Map<string, { window: PlanWindow; at: number }>>();
  /** Passively-observed subscription tier (e.g. agy `_meta.antigravity.tier`), cleared on sign-out. */
  readonly #observedTier = new Map<string, { plan: string; observedAt: number }>();
  /**
   * Per agent, the reason of each `#markAgentStale` so far, in order: its length is the agent's generation. A start
   * records the generation it began at; one that ends after it moved was started with what changed since, and is
   * marked stale with those reasons (a session still inside session/new is not in #sessions to be marked).
   */
  readonly #staleHistory = new Map<string, string[]>();
  #counter = 0;
  #closing = false;

  private constructor(
    options: DaemonOptions,
    index: SessionIndex,
    defaults: AgentDefaults,
    agentSettings: AgentSettings,
    optionsCache: AgentOptionsCache,
    trust: FolderTrust,
    connectors: ConnectorService,
    modelProviders: ModelProviders,
  ) {
    this.#version = options.version ?? "dev";
    this.#dataDir = options.dataDir;
    this.#agentHomes = options.agentHomes ?? (() => []);
    const defaultConfigPath = join(options.dataDir, "config.json");
    this.#configFile = options.configFile ?? {
      path: defaultConfigPath,
      loadedMtimeMs: captureConfigMtime(defaultConfigPath),
    };
    this.#agentIdleMs = options.agentIdleMs;
    this.#attachedAgentIdleMs = options.attachedAgentIdleMs;
    this.#standbyMs = options.standbyMs ?? STANDBY_MS;
    this.#now = options.now ?? Date.now;
    this.#lastClientAt = this.#now();
    this.#log = options.log ?? silentLogger;
    this.#clients = new Clients(this.#log);
    this.#agents = new Map(options.agents.map((a) => [a.id, a]));
    this.#store =
      options.store ??
      new BlobLogStore(
        new JsonlLogStore({ dir: sessionsDir(options.dataDir) }),
        blobsDir(options.dataDir),
      );
    this.#index = index;
    this.#defaults = defaults;
    this.#agentSettings = agentSettings;
    this.#auth = new AgentAuthManager({
      ttlMs: options.authFlowTtlMs,
      now: this.#now,
      log: this.#log,
      onCompleted: (connectionId, payload) => {
        // Sent ONLY to the initiating connection (docs/protocol.md §16).
        this.#clients.tellOne(connectionId, AGENT_AUTH_COMPLETED, payload);
      },
      onChanged: (agent) => this.#notifyAgentSetupChanged(agent),
      onSignedIn: (agent) => this.#accountChanged(agent),
    });
    this.#optionsCache = optionsCache;
    this.#trust = trust;
    this.#connectors = connectors;
    // Codex and agy have no worktree tools of their own: Cycle gives them the ones Claude has.
    connectors.useWorktrees(
      worktreeHost({
        session: (id) => this.#sessions.get(id),
        remember: (session, patch) => this.#remember(session, patch),
        warn: (event) => this.#log.warn(event, {}),
      }),
      ["codex", "agy"],
    );
    this.#modelProviders = modelProviders;
    modelProviders.onChange(() => this.#clients.broadcast(NOTIFICATIONS.providersChanged, {}));
    this.#terminals = new Terminals({
      ...(options.terminals ?? defaultTerminals(process.env)),
      log: this.#log,
      onChanged: (sessionId, terminals) =>
        this.#clients.broadcast(TERMINAL_NOTIFICATIONS.changed, { sessionId, terminals }),
    });
    const providers = new Map<string, PluginProvider>();
    for (const agent of options.agents) {
      if (agent.plugins !== undefined) providers.set(agent.id, agent.plugins);
    }
    this.#plugins = new PluginService({
      providers,
      connectors,
      now: this.#now,
      onChanged: (agentId) => this.#clients.broadcast(PLUGINS_CHANGED, { agentId }),
      ...(options.builtinPlugins !== undefined ? { builtin: options.builtinPlugins } : {}),
      warn: (agentId, error) =>
        this.#log.warn("builtin_plugins_failed", { agent: agentId, error: errorText(error) }),
    });
    connectors.onChanged(() => this.#clients.broadcast(CONNECTORS_CHANGED, {}));
    this.#core = this.#makeCore();
  }

  /** Reads the index, and refuses to start if it is there and cannot be read. */
  static async start(
    options: Omit<DaemonOptions, "agents"> & { agents: AgentsFactory },
  ): Promise<Daemon>;
  static async start(options: DaemonOptions): Promise<Daemon>;
  static async start(
    options: Omit<DaemonOptions, "agents"> & { agents: AgentDefinition[] | AgentsFactory },
  ): Promise<Daemon> {
    // The daemon owns the one AgentSettings: the harnesses are made with it, so a runtime change it saves is what they read.
    const agentSettings = await AgentSettings.load(agentSettingsPath(options.dataDir), options.log);
    const providers = await ModelProviders.load(providersPath(options.dataDir));
    const agents =
      typeof options.agents === "function"
        ? options.agents(agentSettings, providers)
        : options.agents;
    // What the file holds is checked against each agent's schema: a value out of range is dropped, not used.
    const schemas: Record<string, Record<string, RuntimeProperty>> = {};
    for (const agent of agents) {
      if (agent.setup?.runtimeSchema !== undefined) schemas[agent.id] = agent.setup.runtimeSchema;
    }
    agentSettings.useSchemas(schemas);
    const daemon = new Daemon(
      { ...options, agents },
      await SessionIndex.load(indexPath(options.dataDir)),
      await AgentDefaults.load(defaultsPath(options.dataDir)),
      agentSettings,
      await AgentOptionsCache.load(optionsCachePath(options.dataDir)),
      await FolderTrust.load(trustPath(options.dataDir)),
      options.connectors ?? (await ConnectorService.load(options.dataDir)),
      providers,
    );
    // Quietly, and not waited for: nothing starts later because of it (a failure is tried again as an agent starts).
    void daemon.#plugins.ensureBuiltins();
    return daemon;
  }

  /** Serves one client on a stream. */
  accept(stream: Stream): { closed: Promise<void>; close: () => void } {
    const holder: { value?: ClientConn } = {};
    return this.#register(holder, facing(this.#core, holder).connect(stream));
  }

  /** Serves a client app in this process, with no transport. For tests. */
  acceptApp(clientApp: ClientApp): { closed: Promise<void>; close: () => void } {
    const holder: { value?: ClientConn } = {};
    return this.#register(holder, facing(this.#core, holder).connect(clientApp));
  }

  #register(
    holder: { value?: ClientConn },
    connection: { client: AgentContext; closed: Promise<void>; close: () => void },
  ): { closed: Promise<void>; close: () => void } {
    const conn = clientConn(`c${++this.#counter}`, connection.client);
    holder.value = conn;
    this.#clients.add(conn);
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
  #reclaimable(session: Session, attachedOk = false): boolean {
    return (
      !session.closed &&
      session.link !== undefined &&
      session.starting === undefined &&
      (attachedOk || session.attachments.size === 0) &&
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
    const unattachedLimit = this.#agentIdleMs;
    const attachedLimit = this.#attachedAgentIdleMs;
    if ((unattachedLimit === undefined && attachedLimit === undefined) || this.#closing) return [];
    const now = this.#now();
    const reclaimed: string[] = [];
    for (const session of this.#sessions.values()) {
      const attached = session.attachments.size > 0;
      const limit = attached ? attachedLimit : unattachedLimit;
      if (limit === undefined || !this.#reclaimable(session, attached)) continue;
      if (now - session.lastActive < limit) continue;
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
    if (this.#closing || this.#clients.size > 0 || this.#loading.size > 0) return undefined;
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
    for (const agentId of [...this.#standby.keys()]) this.#dropStandby(agentId);
    const authCleanup = this.#auth.close();
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
    await this.#modelProviders.close();
    // What the sessions noted as they went (an unread mark, a usage) is written by now, not dropped.
    await this.#index.flush();
    await this.#optionsCache.flush();
    await terminals;
    await authCleanup;
  }

  #dropped(conn: ClientConn): void {
    this.#clients.delete(conn);
    this.#terminals.detachAll(conn.id);
    this.#auth.onConnectionClosed(conn.id);
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
    this.#clients.broadcast(NOTIFICATIONS.sessionListChanged, {});
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
      await this.#backfill(session);
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
      session.markStale("trust");
      this.#restartIfStale(session);
    }
  }

  /**
   * Starts `agentId` ahead of any session, when it can be (`AgentDefinition.standby`): the process is up and initialised
   * by the time a session wants it, and the next session to start takes it over instead of starting one (decision 0014,
   * CYC-294). One per agent; it is let go after `standbyMs` with no one to take it, when the agent's account or settings
   * change, or when the daemon stops. Says nothing if it cannot: the session then starts its own, as before.
   */
  async prewarmAgent(agentId: string): Promise<void> {
    const definition = this.#definition(agentId);
    if (definition.standby !== true || this.#closing) return;
    if (this.#standby.has(agentId)) {
      this.#armStandby(agentId);
      return;
    }
    const pending = this.#standbyStarting.get(agentId);
    if (pending !== undefined) return pending;
    const starting = this.#startStandby(definition).finally(() => {
      this.#standbyStarting.delete(agentId);
    });
    this.#standbyStarting.set(agentId, starting);
    return starting;
  }

  async #startStandby(definition: AgentDefinition): Promise<void> {
    const agentId = definition.id;
    const generation = this.#agentGeneration(agentId);
    try {
      if (!((await definition.available?.()) ?? true)) return;
      let connected: AgentLink | undefined;
      let endedEarly = false;
      const link = await AgentLink.connect(definition, {
        // Nothing is asked of it before a session has it: what it sends then is not anyone's.
        update: () => {},
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
        elicitation: async () => ({ action: "cancel" }),
        closed: () => {
          if (connected === undefined) endedEarly = true;
          else if (this.#standby.get(agentId)?.link === connected) this.#takeStandby(agentId);
        },
      });
      connected = link;
      // It ended, or its account or settings changed, while it started: it is not the one to keep.
      if (endedEarly || this.#closing || this.#agentGeneration(agentId) !== generation) {
        link.kill();
        return;
      }
      this.#standby.set(agentId, { link, timer: this.#standbyTimer(agentId) });
      this.#log.info("agent_standby_ready", { agent: agentId });
    } catch (error) {
      // An agent that cannot be started ahead is started by the session, which says why it could not.
      this.#log.warn("agent_standby_failed", {
        agent: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #standbyTimer(agentId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#log.info("agent_standby_expired", { agent: agentId });
      this.#dropStandby(agentId);
    }, this.#standbyMs);
    timer.unref?.();
    return timer;
  }

  /** The wait of an agent started ahead starts over: someone is still about to want it. */
  #armStandby(agentId: string): void {
    const held = this.#standby.get(agentId);
    if (held === undefined) return;
    clearTimeout(held.timer);
    held.timer = this.#standbyTimer(agentId);
  }

  /** The agent started ahead, if there is one, is the caller's now: nothing else will end it. */
  #takeStandby(agentId: string): AgentLink | undefined {
    const held = this.#standby.get(agentId);
    if (held === undefined) return undefined;
    clearTimeout(held.timer);
    this.#standby.delete(agentId);
    return held.link;
  }

  /** The agent started ahead, if there is one, ends. */
  #dropStandby(agentId: string): void {
    this.#takeStandby(agentId)?.kill();
  }

  /**
   * Reconcile unprompted warm processes for `agentId` against its current `maxAhead` limit:
   * - `limit === 0` (e.g. `warmStart: false`) terminates all unprompted idle warm processes immediately;
   * - `limit > 0` terminates the oldest excess warm processes FIFO (keeping `keep` when given).
   * Sessions remain in the index with state `stopped` and history intact.
   */
  #reconcileWarmPool(agentId: string, keep?: Session, overrideLimit?: number): void {
    const rawLimit = this.#agents.get(agentId)?.maxAhead;
    const limit = overrideLimit ?? (typeof rawLimit === "function" ? rawLimit() : rawLimit);
    if (limit === undefined) return;
    const ahead = [...this.#sessions.values()].filter(
      (s) =>
        s.entry.agent === agentId &&
        s.link !== undefined &&
        s.starting === undefined &&
        s.entry.prompted !== true &&
        s.status() === "idle" &&
        s.queue.length === 0,
    );
    const excess = Math.max(0, ahead.length - limit);
    for (const old of ahead.slice(0, excess)) {
      if (limit > 0 && old === keep) continue;
      old.link?.kill();
    }
  }

  /**
   * An agent started for a session that has had no prompt holds a process for nothing yet. Past its agent's
   * `maxAhead` of them, counted among that agent's sessions, the oldest is let go (the session `keep` is the newest, and stays): its next prompt starts one again.
   */
  #letGoOfOldestAhead(keep: Session): void {
    this.#reconcileWarmPool(keep.entry.agent, keep);
  }

  /** Marks all running/starting sessions of `agentId` stale so idle ones recycle immediately and busy ones after their turn. */
  #markAgentStale(agentId: string, reason: string): void {
    const history = this.#staleHistory.get(agentId) ?? [];
    history.push(reason);
    this.#staleHistory.set(agentId, history);
    // What was started ahead was started with what held before.
    this.#dropStandby(agentId);
    for (const session of this.#sessions.values()) {
      if (session.entry.agent !== agentId) continue;
      if (session.link === undefined && session.starting === undefined) continue;
      session.markStale(reason);
      this.#restartIfStale(session);
    }
  }

  #agentGeneration(agentId: string): number {
    return this.#staleHistory.get(agentId)?.length ?? 0;
  }

  /** Marks `session` stale with every reason its agent was made stale for since `generation` (when its start began). */
  #staleSince(session: Session, generation: number): void {
    for (const reason of this.#staleHistory.get(session.entry.agent)?.slice(generation) ?? [])
      session.markStale(reason);
  }

  /**
   * The account an agent is signed in with changed (sign-out, or a sign-in that completed): what was started with the
   * old one goes. Unprompted warm processes end now; the rest are marked stale and recycle once idle (a turn or a
   * background task is never interrupted). What the daemon knows of the old account (plan usage, observed tier) is
   * forgotten, and every client is told the usage is now empty.
   */
  #accountChanged(agentId: string): void {
    this.#reconcileWarmPool(agentId, undefined, 0);
    this.#markAgentStale(agentId, "auth");
    this.#planLimits.delete(agentId);
    this.#observedTier.delete(agentId);
    if (this.#planUsage.delete(agentId)) {
      const usage: PlanUsage = { windows: [], at: this.#now() };
      this.#clients.broadcast(PLAN_USAGE_CHANGED, { agent: agentId, usage });
    }
  }

  /** Stops an agent started with a trust/runtime/auth state that has changed since, once it has nothing to do. */
  #restartIfStale(session: Session): void {
    if (!session.isStale()) return;
    if (session.link === undefined && session.starting === undefined) {
      // No agent: the next one is started with the state as it is then.
      session.clearStale();
      return;
    }
    if (session.link === undefined || session.starting !== undefined) return;
    if (session.status() !== "idle" || session.queue.length > 0) return;
    // A sub-agent is waited for; a task is not: a watcher may never end, and a trust or auth change must not wait on it.
    if (session.backgroundSubagents() > 0) return;
    session.clearStale();
    session.link.kill();
  }

  /** Starts the agent for a session and has it create or resume it. */
  async #startAgent(session: Session, mode: "new" | "resume", create?: NewSessionRequest) {
    const definition = this.#definition(session.entry.agent);
    // Before the process is made: its environment and options are read from what holds now.
    const generation = this.#agentGeneration(session.entry.agent);
    const trust = await this.#trustMeta(session.entry.cwd);
    // The connection can end before connect() has returned the link (an agent that fails to start,
    // or exits at once): the end is noted, and acted on once there is a link to act on.
    let connected: AgentLink | undefined;
    let endedEarly = false;
    const handlers: LinkHandlers = {
      update: (update, sessionId) => {
        // A sub-agent it announced speaks under its own id (ACP v2): that is the sub-agent's conversation. Any other id
        // is taken as the session's own, as before the agent named one.
        if (session.isChild(sessionId)) this.#onChildUpdate(session, sessionId, update);
        else this.#onUpdate(session, update);
      },
      permission: (params, signal) => this.#onPermission(session, params, signal),
      elicitation: (params, signal) => this.#onElicitation(session, params, signal),
      closed: () => {
        if (connected === undefined) endedEarly = true;
        else this.#onAgentClosed(session, connected);
      },
    };
    // An agent already started for it (`prewarmAgent`) is taken over, not started again; one still starting is waited for,
    // since it is that much of the way there. Only a new session: one resumed is not what it was started for.
    if (mode === "new") await this.#standbyStarting.get(session.entry.agent);
    const ahead = mode === "new" ? this.#takeStandby(session.entry.agent) : undefined;
    if (ahead !== undefined) this.#log.info("agent_standby_taken", { agent: session.entry.agent });
    const link =
      ahead ??
      (await AgentLink.connect(
        definition,
        handlers,
        // Its environment's variables, for the commands it runs (docs/protocol.md §6 "环境").
        { sessionId: session.id, sessionEnv: sessionVariables(session.entry) },
      ));
    ahead?.adopt(handlers);
    connected = link;
    session.link = link;
    if (endedEarly) this.#onAgentClosed(session, link);
    try {
      // Cycle's connectors, each through the gateway (docs/protocol.md §14). A session's own servers keep their names.
      const own: McpServer[] =
        (mode === "new" ? create?.mcpServers : undefined) ??
        madeWith(session.entry).mcpServers ??
        [];
      // What its plugins bring is made current first: a plugin can have changed without anyone having looked.
      if (link.mcpHttp) await this.#plugins.beforeAgentStarts(session.entry.agent);
      const connectors = link.mcpHttp
        ? await this.#connectors.serversFor(
            session.id,
            session.entry.cwd,
            new Set(
              own.flatMap((server) => (typeof server.name === "string" ? [server.name] : [])),
            ),
            session.entry.agent,
          )
        : [];
      const mcpServers = [...own, ...connectors];
      if (mode === "new") {
        const created = await link.agent.request(methods.agent.session.new, {
          ...(create ?? { cwd: session.entry.cwd }),
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          _meta: {
            ...(create?._meta ?? {}),
            ...trust,
            [META.sessionId]: session.id,
          },
        });
        this.#noteObservedTier(session.entry.agent, created);
        this.#staleSince(session, generation);
        return { link, created };
      }
      session.resuming = true;
      let resumed: ResumeSessionResponse | undefined;
      try {
        try {
          // What the session was made with goes again: the agent does not keep it across a restart.
          const { additionalDirectories } = session.entry;
          const { systemPrompt } = madeWith(session.entry);
          resumed = await link.agent.request(methods.agent.session.resume, {
            sessionId: session.entry.agentSessionId,
            cwd: session.entry.cwd,
            ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
            ...(mcpServers.length > 0 ? { mcpServers } : {}),
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            _meta: {
              ...trust,
              // Where the session began: an agent that serves the owner's own models resumes it on the same provider.
              ...(session.entry.config?.model !== undefined
                ? { [META.model]: session.entry.config.model }
                : {}),
              // So that an agent that finds no record of a session that had turns says so.
              ...(session.entry.hadTurn === true ? { [META.hadTurn]: true } : {}),
            },
          });
          this.#noteObservedTier(session.entry.agent, resumed);
          const replacement = resumed._meta?.[META.agentSessionId];
          if (replacement !== undefined && replacement !== session.entry.agentSessionId) {
            if (session.entry.hadTurn || typeof replacement !== "string" || !replacement.trim())
              throw new Error("Invalid replacement agent session ID");
            await this.#index.update(session.id, { agentSessionId: replacement });
            session.entry = { ...session.entry, agentSessionId: replacement };
          }
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
        const resumedWith = currentValues(resumed?.configOptions);
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
            })
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
      const resumedModels = choicesFromConfigOptions(resumed?.configOptions, "model");
      if (resumedModels !== undefined) {
        void this.#optionsCache
          .update(session.entry.agent, "model", resumedModels)
          .catch(() => undefined);
      }
      this.#staleSince(session, generation);
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
    if (session.starting !== undefined) return session.starting;
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
    this.#clients.broadcast(PLAN_USAGE_CHANGED, { agent, usage });
  }

  #noteObservedTier(agent: string, response: unknown): void {
    const tier = (response as { _meta?: { antigravity?: { tier?: unknown } } } | undefined)?._meta
      ?.antigravity?.tier;
    if (typeof tier === "string" && tier.trim() !== "") {
      this.#observedTier.set(agent, { plan: tier.trim(), observedAt: this.#now() });
    }
  }

  async #readAgentSetup(params: {
    agent: string;
    refreshUsage?: boolean | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentSetupSnapshot> {
    const definition = this.#agents.get(params.agent);
    if (!definition) {
      throw new RpcError(INVALID_PARAMS, `Unknown agent: ${params.agent}`, {
        reason: "unknown_agent",
        agent: params.agent,
      });
    }
    const configFile = readConfigFileStatus(this.#configFile);
    const setup = definition.setup;
    if (!setup) {
      const available = (await definition.available?.()) ?? true;
      const usage = this.#planUsage.get(definition.id);
      return {
        agent: definition.id,
        name: definition.name,
        available,
        binary: available ? { source: "builtin" } : { source: "missing", problem: "missing" },
        auth: {
          state: available ? "auth_unknown" : "binary_unavailable",
          ...(available ? { unknownReason: "probe_failed" as const } : {}),
          method: available ? "unknown" : "none",
          signInModes: [],
          canSignOut: false,
          loginCommand: loginCommandFor(definition.id, this.#dataDir),
        },
        ...(usage !== undefined ? { planUsage: usage } : {}),
        canRefreshUsage: false,
        runtime: {
          schemaVersion: 1,
          schema: { type: "object", properties: {} },
          values: {},
          overrides: [],
          revision: 0,
        },
        environment: {
          configFile,
          dataDir: join(this.#dataDir, definition.id),
          customDataDir: false,
          allowEnv: [],
          envNames: [],
        },
      };
    }

    const [binary, authProbe] = await Promise.all([
      setup.probeBinary(params.forceRefresh === true ? { forceRefresh: true } : {}),
      setup.readAuth({
        ...(params.refreshUsage !== undefined ? { refreshUsage: params.refreshUsage } : {}),
        ...(params.forceRefresh !== undefined ? { forceRefresh: params.forceRefresh } : {}),
      }),
    ]);

    if (authProbe.planUsage !== undefined) {
      this.#notePlanUsage(definition.id, {
        sessionUpdate: PLAN_USAGE_UPDATE,
        ...authProbe.planUsage,
      });
    }

    const observed = this.#observedTier.get(definition.id);
    let account = authProbe.account;
    if (authProbe.state === "signed_in" && observed !== undefined && account?.plan === undefined) {
      account = {
        ...account,
        plan: observed.plan,
        tierObservedAt: observed.observedAt,
      };
    }

    const planUsage = this.#planUsage.get(definition.id);
    const available = binary.problem === undefined && ((await definition.available?.()) ?? true);
    const liveAuthState = this.#auth.stateFor(definition.id);
    const authState = liveAuthState ?? authProbe.state;

    return {
      agent: definition.id,
      name: definition.name,
      available,
      binary,
      auth: {
        state: authState,
        ...(authState === "auth_unknown" && authProbe.unknownReason !== undefined
          ? { unknownReason: authProbe.unknownReason }
          : {}),
        method: authProbe.method,
        ...(authProbe.viaEnv !== undefined ? { viaEnv: authProbe.viaEnv } : {}),
        ...(account !== undefined ? { account } : {}),
        signInModes: [...setup.signInModes()],
        canSignOut: setup.canSignOut(),
        loginCommand: setup.loginCommand,
      },
      ...(planUsage !== undefined ? { planUsage } : {}),
      canRefreshUsage: setup.canRefreshUsage,
      runtime: setup.runtimeSnapshot(this.#agentSettings),
      environment: {
        configFile,
        ...setup.diagnostics(),
      },
    };
  }

  #notifyAgentSetupChanged(agent: string, revision?: number): void {
    this.#clients.broadcast(
      AGENT_SETUP_CHANGED,
      revision !== undefined ? { agent, revision } : { agent },
    );
  }

  async #setAgentRuntime(params: {
    agent: string;
    patch: Record<string, AgentRuntimePatchValue>;
    expectedRevision: number;
  }) {
    const definition = this.#agents.get(params.agent);
    if (!definition) {
      throw new RpcError(INVALID_PARAMS, `Unknown agent: ${params.agent}`, {
        reason: "unknown_agent",
        agent: params.agent,
      });
    }
    const setup = definition.setup;
    const schema = setup?.runtimeSchema ?? {};
    const before = setup?.runtimeSnapshot(this.#agentSettings).values ?? {};

    try {
      await this.#agentSettings.patch(params.agent, params.patch, params.expectedRevision, schema);
    } catch (error) {
      if (error instanceof AgentSettingsConflictError) {
        throw new RpcError(INVALID_PARAMS, error.message, {
          reason: "revision_conflict",
          currentRevision: error.currentRevision,
        });
      }
      if (error instanceof AgentSettingsCorruptError) {
        // The path and the parse error are in daemon.log (agent_settings_unreadable), never sent to a client.
        throw new RpcError(CycleErrorCode.InvalidConfig, AGENT_SETTINGS_UNREADABLE, {
          reason: "file_corrupt",
        });
      }
      if (error instanceof AgentSettingsValidationError) {
        throw new RpcError(CycleErrorCode.InvalidConfig, error.message, {
          reason: error.reason,
          ...(error.field !== undefined ? { field: error.field } : {}),
        });
      }
      throw error;
    }

    const after = setup?.runtimeSnapshot(this.#agentSettings) ?? {
      values: {} as Record<string, string | number | boolean>,
      overrides: [] as string[],
      revision: this.#agentSettings.revisionOf(params.agent),
    };

    let reconcileWarm = false;
    let markStale = false;
    for (const [key, prop] of Object.entries(schema)) {
      if (before[key] === after.values[key]) continue;
      const scope = prop._meta?.[META.applyScope];
      if (scope === "immediate") reconcileWarm = true;
      else if (scope === "next_idle_restart") markStale = true;
    }
    if (reconcileWarm) this.#reconcileWarmPool(params.agent);
    if (markStale) this.#markAgentStale(params.agent, "runtime_config");

    this.#notifyAgentSetupChanged(params.agent, after.revision);
    return {
      values: after.values,
      overrides: after.overrides,
      revision: after.revision,
    };
  }

  #setupProviderFor(agent: string) {
    const definition = this.#agents.get(agent);
    if (!definition) {
      throw new RpcError(INVALID_PARAMS, `Unknown agent: ${agent}`, {
        reason: "unknown_agent",
        agent,
      });
    }
    if (definition.setup === undefined) {
      throw new RpcError(INVALID_PARAMS, `Setup not supported for agent: ${agent}`, {
        reason: "unsupported_mode",
        agent,
      });
    }
    return definition.setup;
  }

  async #startAgentAuth(
    connectionId: string,
    params: { agent: string; mode?: AgentAuthMode | undefined },
  ) {
    const setup = this.#setupProviderFor(params.agent);
    return this.#auth.start(connectionId, params.agent, params.mode, setup);
  }

  async #submitAgentAuth(connectionId: string, params: { flowId: string; code: string }) {
    return this.#auth.submit(connectionId, params.flowId, params.code);
  }

  async #cancelAgentAuth(connectionId: string, params: { flowId: string }) {
    await this.#auth.cancel(connectionId, params.flowId);
    return {};
  }

  async #logoutAgent(params: { agent: string }) {
    const setup = this.#setupProviderFor(params.agent);
    await this.#auth.logout(params.agent, setup, () => {
      // Sign-out lifecycle (docs/protocol.md §16), shared with a completed sign-in.
      this.#accountChanged(params.agent);
    });
    return {};
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

  /**
   * An update the agent sent of the session itself. What is not the session's (the account's plan usage, a child
   * update an agent should not make) goes elsewhere or nowhere; what is, is kept (`#persistUpdate`), and a turn's end is
   * acted on (`#onTurnEnd`).
   */
  #onUpdate(session: Session, update: SessionUpdate): void {
    const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
    // The account's, not the session's: kept for the agent and told to every client, never written to a history.
    if (kind === PLAN_USAGE_UPDATE) {
      // A process started before the account changed speaks for the old one until it is recycled: not kept.
      if (!session.isStaleFor("auth")) this.#notePlanUsage(session.entry.agent, update);
      return;
    }
    // The daemon's to make from a sub-agent's own updates: an agent does not say it for one.
    if (kind === CHILD_UPDATE) return;
    // Known as a sub-agent even when its announce is not kept (a resume replays, say): what it says later under its own
    // id is then dropped as a sub-agent's, never written as the session's own.
    const announced = update as { sessionId?: unknown };
    if (kind === "subagent_update" && typeof announced.sessionId === "string")
      session.noteChild(announced.sessionId);
    // Once the daemon is stopping, the turn's end is on record: what the agent says after it is not.
    if (session.resuming || session.historyError !== undefined || this.#closing) return;
    // What to say next belongs to the turn that ended: not kept once another has been taken, nor when none was wanted.
    if (
      kind === PROMPT_SUGGESTION_UPDATE &&
      (session.promptSuggestions !== true ||
        session.status() !== "idle" ||
        !PromptSuggestionUpdateSchema.safeParse(update).success)
    )
      return;
    const state = update as { state?: unknown };
    if (
      kind === "state_update" &&
      (state.state === "running" || state.state === "idle" || state.state === "requires_action")
    )
      session.agentState = state.state;
    if (!this.#persistUpdate(session, update)) return;
    const ended = turnEnd(update);
    if (ended !== undefined) this.#onTurnEnd(session, ended);
  }

  /**
   * Keeps an update in the session's history, with what it tells the daemon (`#learn`), and announces the list when it
   * changes it. False for one that is not to be kept. Called in the order the updates arrive, so seq follows the
   * agent's order.
   */
  #persistUpdate(session: Session, update: SessionUpdate): boolean {
    if (!this.#learn(session, update)) return false;
    const kind = (update as { sessionUpdate: string }).sessionUpdate;
    // What the agent was given for a mention of another session is kept as the mention, not as that session's record.
    const echo = update as { content?: unknown };
    const content = kind === "user_message" ? collapseSessionMentions(echo.content) : echo.content;
    const kept = content === echo.content ? update : { ...update, content };
    // The list shows what a session is doing, not what it said: only a change of state is announced
    // (docs/protocol.md §6). Anything else that changes the list says so where it changes it.
    // Update before yielding to storage so a concurrent dismissal checks the latest agent signal.
    const backgroundChanged =
      (kind === "subagent_update" &&
        session.noteSubagent(update as unknown as Record<string, unknown>)) ||
      (kind === TASK_UPDATE && session.noteTask(update as unknown as Record<string, unknown>));
    const announce = kind === "state_update" || backgroundChanged;
    void this.#write(session, { kind: "update", data: kept }).then((written) => {
      if (written && announce) this.#changed();
      if (written && backgroundChanged) this.#restartIfStale(session);
    });
    return true;
  }

  /** A turn ended (an idle that says why, not a snapshot): it is logged, what is queued goes on, and a stale agent can go. */
  #onTurnEnd(session: Session, ended: TurnEnd): void {
    // How it ended, and the code of a failure: what the agent said about it is in the history, not here.
    if (ended.stopReason === "error")
      this.#log.warn("turn_ended", {
        session: session.id,
        stopReason: ended.stopReason,
        code: ended.code,
      });
    else this.#log.info("turn_ended", { session: session.id, stopReason: ended.stopReason });
    this.#queueAfterTurn(session, ended.stopReason);
    // A turn that ended with nothing behind it: an agent started with an old trust decision can go now.
    this.#restartIfStale(session);
  }

  /** What waits goes on after a turn that ended well, and is handed back after one that did not. */
  #queueAfterTurn(session: Session, stopReason: string): void {
    if (session.queue.length === 0) return;
    if (stopReason === "end_turn") this.#dispatchNext(session);
    else this.#returnQueue(session, stopReason === "cancelled" ? "cancelled" : "error");
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
    if (!first?.[1].durable || !recipient) return;
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
    this.#send(session, asPrompt(next.prompt)).catch((error: unknown) => {
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
  async #steer(session: Session, prompt: ContentBlock[]): Promise<PromptResponse | undefined> {
    const link = session.link;
    if (this.#definition(session.entry.agent).steer !== true || link === undefined) return;
    try {
      const answer = await link.agent.request(methods.agent.session.prompt, {
        sessionId: session.entry.agentSessionId,
        prompt: await this.#expand(session, prompt),
        _meta: { [META.steer]: true },
      });
      return { ...answer, _meta: { ...(answer._meta ?? {}), [META.steered]: true } };
    } catch {
      return undefined;
    }
  }

  async #send(session: Session, given: ContentBlock[]): Promise<PromptResponse> {
    const stopsBefore = session.startingCancels;
    // Asked for first: the session is starting from now, so a prompt that comes in meanwhile is queued behind this one.
    const starting = this.#ensureAgent(session);
    // Its failure is met below, once the prompt is ready; not reported as unhandled while the prompt is read.
    starting.catch(() => undefined);
    session.preparing++;
    let prompt: ContentBlock[];
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
      ...(session.promptSuggestions !== undefined
        ? { _meta: { [META.promptSuggestions]: session.promptSuggestions } }
        : {}),
    });
  }

  /**
   * The prompt as the agent is given it: a mention of another session of this daemon becomes that session's record, as
   * it is now (docs/protocol.md §8 "提及(@)另一个 session"). One that mentions none is given as it is.
   */
  async #expand(session: Session, prompt: ContentBlock[]): Promise<ContentBlock[]> {
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
    // What is put in for a mention is a text or resource block (`expandSessionMentions`).
    const expanded = asPrompt(await expandSessionMentions(prompt, read, embedded != null));
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
      // The list of commands is long (15 KB on average) and agents repeat it unchanged: the same
      // one as the last on record is not written, and clients, who have that one, are sent nothing.
      // Nothing is awaited here, so what is written keeps the order the updates came in.
      if (record.kind === "update" && isCommandsData(data)) {
        const key = commandsKey(data);
        if ((session.lastCommands ?? session.log.lastCommands()) === key) return true;
        session.lastCommands = key;
      }
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
      this.#tellResolved(session, pending, pending.cancelled);
    }
    session.agentState = "idle";
    void session.link?.agent
      .notify(methods.agent.session.cancel, { sessionId: session.entry.agentSessionId })
      .catch(() => undefined);
    // Not logged: the log is what failed. Like a snapshot it carries no seq.
    const update = {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: CycleErrorCode.LogUnavailable, message: HISTORY_NOT_SAVED },
    };
    for (const attachment of session.attachments)
      this.#clients.tell(attachment.conn, SESSION_UPDATE, { sessionId: session.id, update });
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
      if (attachment.ready)
        this.#clients.tell(attachment.conn, SESSION_UPDATE, { sessionId: session.id, update });
    }
  }

  /**
   * Puts a request to the clients, waits for the answer, and writes the request to the log. What the agent is told is
   * `how.cancelled`, or what `how.answer` makes of a client's answer, or something the daemon settles it with itself
   * (`#settle`, `#abandonForms`): each of the same kind, so the outcome is `T`.
   */
  async #ask<T>(
    session: Session,
    method: string,
    params: { _meta?: Record<string, unknown> | null },
    how: { cancelled: T; answer: (response: unknown) => T },
    signal?: AbortSignal,
  ): Promise<T> {
    // A stopping daemon puts nothing more to anyone: the agent is told no, as at a cancel.
    if (this.#closing || signal?.aborted) return how.cancelled;
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
    const outcome = new Promise<T>((r) => {
      resolve = r as (outcome: unknown) => void;
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
    // The agent took it back (its turn ended without it, a form it no longer needs): nobody is left asked.
    const withdraw = () => this.#settle(session, pending, pending.cancelled);
    if (signal?.aborted) withdraw();
    else signal?.addEventListener("abort", withdraw, { once: true });
    // A request written while nobody is attached waits here until a client attaches.
    return outcome.finally(() => signal?.removeEventListener("abort", withdraw));
  }

  async #onPermission(
    session: Session,
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    // Which sub-agent asks, when one does: the agent asks in that sub-agent's session (ACP v2), clients are asked in
    // the parent's and told whose it is (docs/protocol.md §9). Only the daemon says so: an agent's own word is dropped.
    const { [META.subagentId]: _said, ...meta } = params._meta ?? {};
    const asker = session.isChild(params.sessionId) ? params.sessionId : undefined;
    const outcome = await this.#ask(
      session,
      REQUEST_PERMISSION,
      { ...params, _meta: asker !== undefined ? { ...meta, [META.subagentId]: asker } : meta },
      { cancelled: PERMISSION_CANCELLED, answer: permissionOutcome(params.options) },
      signal,
    );
    return { outcome };
  }

  /**
   * The agent asks for a form (docs/protocol.md §9, decision 0011). Only a client that said it can
   * answer one is asked, and if none is attached the agent is told so at once instead of waiting:
   * a question is not worth holding a turn for, and a client without the screen would never answer.
   */
  async #onElicitation(
    session: Session,
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    if (!this.#canAskForms(session)) return { action: "cancel", _meta: { [META.noClient]: true } };
    return this.#ask(
      session,
      ELICITATION,
      params,
      { cancelled: { action: "cancel" }, answer: elicitationAnswer },
      signal,
    );
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
      this.#tellResolved(session, pending, told, by);
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

  /** The clients that were asked a request (but `by`, who answered it) are told it is settled, and how. */
  #tellResolved(session: Session, pending: Pending, outcome: unknown, by?: Attachment): void {
    for (const asked of pending.asked) {
      if (asked === by) continue;
      this.#clients.tell(asked.conn, NOTIFICATIONS.requestResolved, {
        sessionId: session.id,
        requestId: pending.requestId,
        outcome,
      });
    }
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
      this.#tellResolved(session, pending, pending.cancelled);
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
   * What a session's log says that the index may not, read once as the session loads (CYCL-261), and kept in the index
   * so that the next load does not read for it:
   * - a turn that never ended: the daemon before this one stopped in the middle of it without saying so (it crashed,
   *   was killed, or was older than this rule). Its end is put on record now. The index says whether to look.
   * - whether the person has said anything, for an entry from before the index kept it (`#prompted`).
   */
  async #backfill(session: Session): Promise<void> {
    const { turnOpen, prompted } = session.entry;
    if (turnOpen === false && prompted !== undefined) return;
    let records: LogRecord[];
    try {
      // As stored: an image is not read back from its blob to find any of this out.
      records = await session.log.read(undefined, { stored: true });
    } catch {
      // A log that cannot be read is reported where it is read; there is nothing to end here.
      return;
    }
    if (prompted === undefined)
      this.#remember(session, { prompted: records.some(isUserMessage) }, false);
    if (turnOpen === false) return;
    if (turnLeftOpen(records))
      await this.#interrupt(session, "Cycle stopped while this turn was running");
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

  /** What the registration modules reach of the daemon (src/facing/core.ts). Made once. */
  #makeCore(): Core {
    return {
      version: this.#version,
      dataDir: this.#dataDir,
      agentHomes: () => this.#agentHomes(),
      log: this.#log,
      agents: this.#agents,
      store: this.#store,
      index: this.#index,
      sessions: this.#sessions,
      defaults: this.#defaults,
      optionsCache: this.#optionsCache,
      trust: this.#trust,
      providers: this.#modelProviders,
      connectors: this.#connectors,
      plugins: this.#plugins,
      terminals: this.#terminals,
      clients: this.#clients,
      planUsage: this.#planUsage,
      now: () => this.#now(),
      definition: (id) => this.#definition(id),
      session: (sessionId) => this.#session(sessionId),
      cwdOf: (sessionId) => this.#cwdOf(sessionId),
      watch: (session) => this.#watch(session),
      startAgent: (session, create) => this.#startAgent(session, "new", create),
      ensureAgent: (session) => this.#ensureAgent(session),
      letGoOfOldestAhead: (keep) => this.#letGoOfOldestAhead(keep),
      restartIfStale: (session) => this.#restartIfStale(session),
      applyTrust: (folder) => this.#applyTrust(folder),
      write: (session, record) => this.#write(session, record),
      remember: (session, patch, announce) => this.#remember(session, patch, announce),
      changed: () => this.#changed(),
      send: (session, prompt) => this.#send(session, prompt),
      steer: (session, prompt) => this.#steer(session, prompt),
      promptFailed: (session, error) => this.#promptFailed(session, error),
      publishQueue: (session, back) => this.#publishQueue(session, back),
      returnQueue: (session, reason, force) => this.#returnQueue(session, reason, force),
      returnStale: (session) => this.#returnStale(session),
      offerReturn: (session) => this.#offerReturn(session),
      ackReturn: (session, conn, id) => this.#ackReturn(session, conn, id),
      offer: (session, pending, attachment) => this.#offer(session, pending, attachment),
      settle: (session, pending, outcome, by) => this.#settle(session, pending, outcome, by),
      readAgentSetup: (params) => this.#readAgentSetup(params),
      setAgentRuntime: (params) => this.#setAgentRuntime(params),
      startAgentAuth: (connectionId, params) => this.#startAgentAuth(connectionId, params),
      submitAgentAuth: (connectionId, params) => this.#submitAgentAuth(connectionId, params),
      cancelAgentAuth: (connectionId, params) => this.#cancelAgentAuth(connectionId, params),
      logoutAgent: (params) => this.#logoutAgent(params),
      prewarmAgent: (agent) => this.prewarmAgent(agent),
    };
  }
}

/** How a turn ended, from an update that ends one. */
type TurnEnd = { stopReason: string; code: number | undefined };

/** The end of a turn: an idle that says why. The idle an agent sends on resume is a snapshot, and says no reason. */
const turnEnd = (update: SessionUpdate): TurnEnd | undefined => {
  const u = update as {
    sessionUpdate?: unknown;
    state?: unknown;
    stopReason?: unknown;
    error?: { code?: unknown } | null;
  };
  if (u.sessionUpdate !== "state_update" || u.state !== "idle" || typeof u.stopReason !== "string")
    return undefined;
  return {
    stopReason: u.stopReason,
    code: typeof u.error?.code === "number" ? u.error.code : undefined,
  };
};
