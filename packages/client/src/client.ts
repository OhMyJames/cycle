import {
  client as acpClient,
  type ClientContext,
  type ContentBlock,
  methods,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
  AGENT_AUTH_COMPLETED,
  AGENT_SETUP_CHANGED,
  type AgentAuthCompleted,
  AgentAuthCompletedSchema,
  type AgentAuthMode,
  type AgentAuthStartResult,
  type AgentRuntimePatchValue,
  AgentSetupChangedSchema,
  type AgentSetupSnapshot,
  agentAuthCancel,
  agentAuthLogout,
  agentAuthStart,
  agentAuthSubmit,
  agentDefaultsRead,
  agentDefaultsSet,
  agentPrewarm,
  agentSetupRead,
  agentSetupSetRuntime,
  agentsList,
  CONNECTORS_CHANGED,
  type Connector,
  type ConnectorAuth,
  type ConnectorSecrets,
  type ConnectorTransport,
  CYCLE_PROTOCOL_VERSION,
  CycleErrorCode,
  type CycleMethod,
  connectorsAdd,
  connectorsAuthClear,
  connectorsAuthFinish,
  connectorsAuthStart,
  connectorsList,
  connectorsRemove,
  connectorsUpdate,
  diffFile,
  diffStatus,
  type FolderList,
  filesSearch,
  foldersList,
  fsList,
  fsRead,
  gitBranches,
  META,
  type ModelProvider,
  type ModelProviderDraft,
  NOTIFICATIONS,
  type ParamsOf,
  PLAN_USAGE_CHANGED,
  PLUGINS_CHANGED,
  type PlanUsage,
  PlanUsageChangedSchema,
  type Plugin,
  type PluginSource,
  PluginsChangedSchema,
  type ProviderKind,
  type ProviderModel,
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
  providersCatalog,
  providersList,
  providersRemove,
  providersSave,
  type ResultOf,
  type SessionPageOptions,
  seqOf,
  sessionArchive,
  sessionDismissBackground,
  sessionMarkRead,
  sessionSetTitle,
  sessionStopSubagent,
  sessionUnarchive,
  TERMINAL_NOTIFICATIONS,
  type TerminalAttached,
  TerminalChangedSchema,
  type TerminalInfo,
  type TerminalOutput,
  TerminalOutputSchema,
  type TerminalReset,
  TerminalResetSchema,
  type Trust,
  terminalAttach,
  terminalClose,
  terminalCreate,
  terminalDetach,
  terminalInput,
  terminalList,
  terminalResize,
  trustRead,
  trustSet,
  tsOf,
} from "@cycle/protocol";
import type { Channel } from "./transport.ts";

/** ACP's "resource not found": the daemon has no such session. */
const RESOURCE_NOT_FOUND = -32002;

/** ACP's "unsupported protocol version" (-32022): the daemon refused `initialize` because the major version differs. */
const UNSUPPORTED_VERSION = -32022;

/**
 * The daemon speaks another major version of Cycle's protocol, so nothing can be asked of it (docs/protocol.md §3).
 * `supported` is what it said it speaks, `requested` what this client asked for.
 */
export class ProtocolMismatchError extends Error {
  readonly code = UNSUPPORTED_VERSION;
  constructor(
    readonly supported: string[],
    readonly requested: string,
    options?: { cause?: unknown },
  ) {
    super(
      `The daemon speaks Cycle protocol ${supported.join(" or ") || "an unknown version"}; this client speaks ${requested}.`,
      options,
    );
    this.name = "ProtocolMismatchError";
  }
}

const isSessionGone = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === RESOURCE_NOT_FOUND;

const isLogUnavailable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === CycleErrorCode.LogUnavailable;

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

/** What the daemon asks of the user. Resolve with the chosen option, or `cancelled`. */
export type PermissionAnswer = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** What a user answered to a form: ACP's `elicitation/create` response. */
export type ElicitationAnswer =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export type ClientEvents = {
  /**
   * The agent asks the user for structured input. Having this says the client can show a form:
   * the daemon asks no form of a client that does not (docs/protocol.md §9). `resolved` closes it
   * when someone else answers first.
   */
  elicitation?: (
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
  ) => Promise<ElicitationAnswer>;
  /**
   * An update of a session, once each: a replay after a reconnect never repeats one. `at` is when the daemon logged it
   * (`cycle/ts`, milliseconds since the epoch); undefined when not known (a synthesized update, an older daemon).
   */
  update?: (
    sessionId: string,
    update: SessionUpdate,
    seq: number | undefined,
    at: number | undefined,
  ) => void;
  /** The agent wants permission. If this is missing, the request is answered "cancelled". */
  permission?: (
    sessionId: string,
    request: Record<string, unknown>,
    /** The daemon's id for it: `resolved` names the same one. Absent from an older daemon. */
    requestId: string | undefined,
  ) => Promise<PermissionAnswer>;
  /** A request this client was asked has been answered somewhere else: close its dialog. */
  resolved?: (sessionId: string, requestId: string | number, outcome: unknown) => void;
  /** Sessions were created, deleted, archived, renamed or changed state: list them again. */
  listChanged?: () => void;
  /** A connector was added, changed or removed, or its status moved: list them again (docs/protocol.md §14). */
  connectorsChanged?: () => void;
  /** The owner's model providers were added, changed or removed: read them and the agents again (docs/protocol.md §10). */
  providersChanged?: () => void;
  /** An agent's plugins or their sources changed: list them again (docs/protocol.md §15). */
  pluginsChanged?: (agentId: string) => void;
  /** An agent's defaults were changed, here or by another client. */
  defaultsChanged?: (agent: string) => void;
  /** An agent's setup snapshot changed (runtime settings saved, sign-in, or sign-out). */
  agentSetupChanged?: (agent: string, revision?: number) => void;
  /** An in-app auth flow initiated by THIS connection finished (docs/protocol.md §16). */
  agentAuthCompleted?: (completed: AgentAuthCompleted) => void;
  /** An agent told how much of its account's plan limits is used (docs/protocol.md §8 "套餐用量"). */
  planUsage?: (agent: string, usage: PlanUsage) => void;
  /**
   * Output of a terminal this client is attached to (docs/protocol.md §8 "终端"). Not ordered against the answer of an
   * `attach` or `create`: whoever shows it drops a piece whose `seq` the answer's screen already holds.
   */
  terminalOutput?: (output: TerminalOutput) => void;
  /** Draw the terminal again from `screen`, then take the output after `seq`: this client fell behind. */
  terminalReset?: (reset: TerminalReset) => void;
  /** A session's terminals, whole, after one was opened, closed, renamed, resized or ended. */
  terminalsChanged?: (sessionId: string, terminals: TerminalInfo[]) => void;
  /**
   * A session this client was watching no longer exists on the daemon (another client deleted it
   * while this one was away). It is not watched any more; the others carry on.
   */
  gone?: (sessionId: string) => void;
  /**
   * A session this client was watching has a history the daemon cannot read, so it could not be
   * attached again after a reconnect. It is not watched any more; the others carry on, and the
   * connection is up. Opening the session says what is wrong with it.
   */
  unreadable?: (sessionId: string, error: unknown) => void;
  /**
   * A watched session was attached again after a reconnect. `pending` is the `requestId` of every request
   * the daemon still waits on, asked of this client again; undefined from a daemon that does not say.
   */
  resumed?: (sessionId: string, pending: string[] | undefined) => void;
  connection?: (state: ConnectionState, error?: unknown) => void;
};

export type ClientOptions = {
  /** Makes a new connection to the daemon. Called again after each loss. */
  connect: () => Promise<Channel>;
  events?: ClientEvents;
  ackReturns?: boolean;
  /** The protocol version asked for in `initialize`. Default: this build's. Another is for tests. */
  protocolVersion?: string;
  /** Waits between attempts to reconnect, in ms. */
  backoff?: { first: number; max: number };
  name?: string;
};

export type SessionRow = {
  sessionId: string;
  cwd: string;
  /** When the session last had something happen in it. Absent from a daemon older than protocol 0.2. */
  updatedAt?: string | null;
  _meta?: Record<string, unknown> | null;
};

/**
 * A client of the daemon that keeps its place. It remembers the last `cycle/seq` of every session it
 * watches; when the connection is lost it reconnects, and asks for what it missed, so the caller sees
 * each update once, in order, as if nothing had happened (docs/protocol.md §7).
 */
export class CycleClient {
  readonly #options: ClientOptions;
  readonly #events: ClientEvents;
  /** Sessions being watched: where each is up to, and where it runs. */
  readonly #watched = new Map<string, { cwd: string; lastSeq: number; replayed: boolean }>();
  #agent: ClientContext | undefined;
  #channel: Channel | undefined;
  #closing = false;
  #state: ConnectionState = "closed";
  #reconnecting: Promise<void> | undefined;
  #capabilities: Record<string, unknown> = {};
  #serverVersion: string | undefined;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.#events = options.events ?? {};
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** What the daemon said it can do, from `initialize`. */
  /** What the daemon says it is (its release, or `dev`), as of the last connection. */
  get serverVersion(): string | undefined {
    return this.#serverVersion;
  }

  get capabilities(): Record<string, unknown> {
    return this.#capabilities;
  }

  /** Connects. Fails if the first attempt does; later losses are retried. */
  async start(): Promise<void> {
    this.#setState("connecting");
    try {
      await this.#connectOnce();
    } catch (error) {
      this.#setState("closed", error);
      throw error;
    }
    this.#setState("connected");
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#channel?.close();
    this.#setState("closed");
  }

  // ---- what to ask the daemon ----

  async agents(): Promise<ResultOf<typeof agentsList>> {
    return this.#call(agentsList, {});
  }

  /** What new sessions of an agent start with. */
  async agentDefaults(agent: string): Promise<Record<string, string>> {
    return (await this.#call(agentDefaultsRead, { agent })).config;
  }

  async setAgentDefaults(agent: string, config: Record<string, string>): Promise<void> {
    await this.#call(agentDefaultsSet, { agent, config });
  }

  /** Read-only setup status, auth state, runtime config, and host diagnostics for one agent (docs/protocol.md §16). */
  async readAgentSetup(
    agent: string,
    options?: { refreshUsage?: boolean; forceRefresh?: boolean },
  ): Promise<AgentSetupSnapshot> {
    return (await this.#call(agentSetupRead, {
      agent,
      ...(options?.refreshUsage !== undefined ? { refreshUsage: options.refreshUsage } : {}),
      ...(options?.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
    })) as AgentSetupSnapshot;
  }

  /** Patch hot-reloadable runtime settings for one agent (`null` unsets an override). */
  async setAgentRuntimeSettings(
    agent: string,
    patch: Record<string, AgentRuntimePatchValue>,
    expectedRevision: number,
  ): Promise<ResultOf<typeof agentSetupSetRuntime>> {
    return this.#call(agentSetupSetRuntime, { agent, patch, expectedRevision });
  }

  /** Asks the daemon to start an agent ahead of the session that will want it (docs/protocol.md §16). */
  async prewarmAgent(agent: string): Promise<void> {
    await this.#call(agentPrewarm, { agent });
  }

  /** Starts an in-app subscription sign-in flow for an agent (docs/protocol.md §16). */
  async startAgentAuth(agent: string, mode?: AgentAuthMode): Promise<AgentAuthStartResult> {
    return this.#call(agentAuthStart, {
      agent,
      ...(mode !== undefined ? { mode } : {}),
    });
  }

  /** Submits a short-lived one-time hosted-callback authorization code for a `"code"` mode flow. */
  async submitAgentAuth(flowId: string, code: string): Promise<{ ok: true }> {
    return this.#call(agentAuthSubmit, { flowId, code });
  }

  /** Cancels an active in-app sign-in flow initiated by this connection. */
  async cancelAgentAuth(flowId: string): Promise<void> {
    await this.#call(agentAuthCancel, { flowId });
  }

  /** Signs out an agent's subscription on the daemon and recycles idle/warm processes. */
  async logoutAgent(agent: string): Promise<void> {
    await this.#call(agentAuthLogout, { agent });
  }

  /**
   * The sessions, without those nothing has been said in yet: a new session is a blank conversation until its first
   * message (docs/protocol.md §6). An older daemon lists them all.
   */
  async listSessions(): Promise<SessionRow[]> {
    const rows: SessionRow[] = [];
    for await (const page of this.sessionPages()) {
      for (const row of page.sessions) rows.push(row);
    }
    return rows;
  }

  /** Each bounded response, including empty intermediate pages. Older daemons answer once. */
  async *sessionPages(
    options: SessionPageOptions & { cwd?: string } = {},
  ): AsyncGenerator<{ sessions: SessionRow[]; hasMore: boolean }> {
    const api = this.#api();
    const { cwd, ...page } = options;
    const paged = this.capabilities.sessionListPages === true;
    if (
      !paged &&
      (cwd !== undefined ||
        page.agent !== undefined ||
        page.createdFrom !== undefined ||
        page.createdBefore !== undefined)
    )
      throw new Error("This daemon does not support session list filters");
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const answer = await api.request(methods.agent.session.list, {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        _meta: { [META.onlyPrompted]: true, ...(paged ? { [META.page]: page } : {}) },
      });
      cursor = answer.nextCursor ?? undefined;
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new Error("The daemon repeated a session list cursor");
        seen.add(cursor);
      }
      yield { sessions: answer.sessions, hasMore: cursor !== undefined };
    } while (cursor !== undefined);
  }

  async newSession(params: {
    cwd: string;
    agent?: string;
    config?: Record<string, string>;
    mcpServers?: unknown[];
    /** The session's environment, whole (docs/protocol.md §6 "环境"). Only to a daemon that has `environments`. */
    environment?: unknown;
    /** Make a worktree and run the session in it (docs/protocol.md §6 "Worktree"). Only to a daemon that has `worktrees`. */
    worktree?: { base?: string; name?: string };
  }): Promise<string> {
    const meta: Record<string, unknown> = {};
    if (params.agent !== undefined) meta[META.agent] = params.agent;
    if (params.config !== undefined) meta[META.config] = params.config;
    if (params.environment !== undefined) {
      if (this.#capabilities.environments !== true)
        throw new Error("This daemon is too old to take an environment");
      meta[META.environment] = params.environment;
    }
    if (params.worktree !== undefined) {
      if (this.#capabilities.worktrees !== true)
        throw new Error("This daemon is too old to make a worktree");
      meta[META.worktree] = params.worktree;
    }
    const answer = (await this.#request(methods.agent.session.new, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      _meta: meta,
    })) as { sessionId: string };
    return answer.sessionId;
  }

  /**
   * Starts watching a session. The first time, its whole history is sent; after a reconnect, only
   * what was missed. Resolves when the replay is done.
   */
  async watch(sessionId: string, cwd: string): Promise<void> {
    const entry = this.#watched.get(sessionId) ?? { cwd, lastSeq: 0, replayed: false };
    this.#watched.set(sessionId, entry);
    try {
      await this.#attach(sessionId, entry);
    } catch (error) {
      // A session that is not there is not kept to be asked for at every reconnect.
      if (isSessionGone(error) || isLogUnavailable(error)) this.#watched.delete(sessionId);
      throw error;
    }
  }

  unwatch(sessionId: string): void {
    this.#watched.delete(sessionId);
  }

  /**
   * Sends a prompt. While the agent works it is queued, or with `steer` put into the running turn
   * where the agent can take it (docs/protocol.md §8); a daemon that cannot queues it. `promptSuggestions`: whether the
   * agent should suggest what to say next once the turn ends (§8); left out, the daemon keeps what was said last.
   */
  async prompt(
    sessionId: string,
    content: ContentBlock[],
    options: { steer?: boolean; promptSuggestions?: boolean } = {},
  ): Promise<string> {
    const meta = {
      ...(options.steer === true ? { [META.steer]: true } : {}),
      ...(options.promptSuggestions !== undefined
        ? { [META.promptSuggestions]: options.promptSuggestions }
        : {}),
    };
    const answer = (await this.#request(methods.agent.session.prompt, {
      sessionId,
      prompt: content,
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    })) as { messageId: string };
    return answer.messageId;
  }

  /** Takes a queued prompt back (docs/protocol.md §8). Rejects if it was sent, or handed back, meanwhile. */
  async ackReturn(sessionId: string, returnId: string): Promise<boolean> {
    return (await this.#call(promptAckReturn, { sessionId, returnId })).acknowledged;
  }

  async dequeue(sessionId: string, queueId: string): Promise<unknown[]> {
    return (await this.#call(promptDequeue, { sessionId, queueId })).prompt;
  }

  /**
   * Finds files and folders in the session's folder on the daemon's machine, or in a folder given for a conversation that
   * has no session yet: that needs a daemon that says `filesInFolder` (docs/protocol.md §8).
   */
  async searchFiles(
    where: string | { cwd: string },
    query: string,
    limit?: number,
  ): Promise<ResultOf<typeof filesSearch>> {
    return this.#call(filesSearch, {
      ...(typeof where === "string" ? { sessionId: where } : { cwd: where.cwd }),
      query,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  /** Only a daemon that says it reads a session's folder is asked to: an older one is not. */
  #canShowFiles(): void {
    if (this.#capabilities.fs !== true) throw new Error("This daemon is too old to show files");
  }

  /**
   * One folder of the session's folder, for the Files tab (docs/protocol.md §8 "浏览和预览文件"): `path` is relative to
   * the session's `cwd`, `""` for the folder itself. A daemon that does not say it can is older: it is not asked.
   */
  async listFiles(sessionId: string, path: string): Promise<ResultOf<typeof fsList>> {
    this.#canShowFiles();
    return this.#call(fsList, { sessionId, path });
  }

  /** A file of the session's folder: text a piece at a time from `offset`, an image whole, anything else by its size. */
  async readFile(
    sessionId: string,
    path: string,
    offset?: number,
  ): Promise<ResultOf<typeof fsRead>> {
    this.#canShowFiles();
    return this.#call(fsRead, { sessionId, path, ...(offset !== undefined ? { offset } : {}) });
  }

  /**
   * Which files of the session's folder differ from HEAD (docs/protocol.md §8 "工作区的改动"), or why that cannot be said
   * (no repository, or one not trusted). A daemon that does not say it can is older: it is not asked.
   */
  async workspaceStatus(sessionId: string): Promise<ResultOf<typeof diffStatus>> {
    if (this.#capabilities.diff !== true) throw new Error("This daemon is too old to show changes");
    return this.#call(diffStatus, { sessionId });
  }

  /** One file's patch against HEAD; a file not tracked is all added. */
  async workspaceFile(sessionId: string, path: string): Promise<ResultOf<typeof diffFile>> {
    if (this.#capabilities.diff !== true) throw new Error("This daemon is too old to show changes");
    return this.#call(diffFile, { sessionId, path });
  }

  /**
   * The folders in a folder on the daemon's machine, for choosing where a session works (docs/protocol.md §8). Without a
   * path: the daemon's user's home. A daemon that does not say it can is older: it is not asked.
   */
  async listFolders(path?: string, hidden?: boolean): Promise<FolderList> {
    if (this.#capabilities.folders !== true)
      throw new Error("This daemon is too old to list its folders");
    return this.#call(foldersList, {
      ...(path !== undefined ? { path } : {}),
      ...(hidden === true ? { hidden } : {}),
    });
  }

  /**
   * Whether a folder on the daemon's machine may run the commands its own configuration names, and where that was
   * decided (docs/protocol.md §8 "信任文件夹"). A daemon that does not say it can is older: it is not asked.
   */
  async readTrust(path: string): Promise<Trust> {
    if (this.#capabilities.trust !== true)
      throw new Error("This daemon is too old to keep folder trust");
    return this.#call(trustRead, { path });
  }

  /**
   * The latest plan usage of each agent that told one since the daemon started. A daemon that does not say it keeps
   * them is older: it is not asked, and the answer is none.
   */
  async readPlanUsage(): Promise<Record<string, PlanUsage>> {
    if (this.#capabilities.planUsage !== true) return {};
    return (await this.#call(planUsageRead, {})).agents as Record<string, PlanUsage>;
  }

  /** Records whether a folder on the daemon's machine may run its own configuration's commands. */
  async setTrust(path: string, trusted: boolean): Promise<Trust> {
    if (this.#capabilities.trust !== true)
      throw new Error("This daemon is too old to keep folder trust");
    return this.#call(trustSet, { path, trusted });
  }

  // ---- connectors (docs/protocol.md §14) ----

  #connectors(): void {
    if (this.#capabilities.connectors !== true)
      throw new Error("This daemon is too old to keep connectors");
  }

  /** The daemon's connectors. Secrets are named, never given. */
  async listConnectors(): Promise<Connector[]> {
    this.#connectors();
    return (await this.#call(connectorsList, {})).connectors;
  }

  async addConnector(params: {
    name: string;
    enabled?: boolean;
    transport: ConnectorTransport;
    auth: ConnectorAuth;
    secrets?: ConnectorSecrets;
  }): Promise<Connector> {
    this.#connectors();
    return (await this.#call(connectorsAdd, params)).connector;
  }

  /** What is not given stays as it is; a secret given as null is removed. */
  async updateConnector(params: {
    id: string;
    name?: string;
    enabled?: boolean;
    transport?: ConnectorTransport;
    auth?: ConnectorAuth;
    secrets?: ConnectorSecrets;
  }): Promise<Connector> {
    this.#connectors();
    return (await this.#call(connectorsUpdate, params)).connector;
  }

  /** Removes a connector and its credentials for good. The caller asks the user first. */
  async removeConnector(id: string): Promise<void> {
    this.#connectors();
    await this.#call(connectorsRemove, { id });
  }

  /** Starts signing in: the daemon keeps the PKCE verifier and gives the URL to open. */
  async startConnectorAuth(
    id: string,
    redirectUri: string,
  ): Promise<ResultOf<typeof connectorsAuthStart>> {
    this.#connectors();
    return this.#call(connectorsAuthStart, { id, redirectUri });
  }

  /** Ends signing in with what the browser brought back. */
  async finishConnectorAuth(params: {
    flowId: string;
    code?: string;
    state?: string;
    error?: string;
  }): Promise<Connector> {
    this.#connectors();
    return (await this.#call(connectorsAuthFinish, params)).connector;
  }

  /** Forgets the connector's token. */
  async clearConnectorAuth(id: string): Promise<Connector> {
    this.#connectors();
    return (await this.#call(connectorsAuthClear, { id })).connector;
  }

  // ---- the owner's model providers (docs/protocol.md §10 "自带模型") ----

  /** The owner's providers, and the known services one can be made for. A key is named (`hasKey`), never given. */
  async listProviders(): Promise<{ providers: ModelProvider[]; kinds: ProviderKind[] }> {
    return this.#call(providersList, {});
  }

  /** The models a known service is known to serve. */
  async providerCatalog(kind: string): Promise<ProviderModel[]> {
    return (await this.#call(providersCatalog, { kind })).models;
  }

  /** Adds a provider, or changes the one the draft's `id` names. The key in the draft goes in and never comes out. */
  async saveProvider(provider: ModelProviderDraft): Promise<ModelProvider> {
    return (await this.#call(providersSave, { provider })).provider;
  }

  async removeProvider(id: string): Promise<void> {
    await this.#call(providersRemove, { id });
  }

  // ---- plugins (docs/protocol.md §15) ----

  /** The agents of this daemon that have plugins. None for a daemon that does not know of plugins. */
  get pluginAgents(): string[] {
    const agents = this.#capabilities.plugins;
    return Array.isArray(agents) ? agents.filter((a): a is string => typeof a === "string") : [];
  }

  #plugins(agentId: string): void {
    if (!this.pluginAgents.includes(agentId))
      throw new Error("This daemon is too old to keep plugins, or this agent has none");
  }

  /** An agent's installed plugins, and where its plugins come from. */
  async listPlugins(agentId: string): Promise<{ sources: PluginSource[]; plugins: Plugin[] }> {
    this.#plugins(agentId);
    return this.#call(pluginsList, { agentId });
  }

  /** What can be installed, a page at a time. */
  async availablePlugins(params: {
    agentId: string;
    sourceId?: string;
    query?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ plugins: Plugin[]; nextCursor?: string | undefined; total: number }> {
    this.#plugins(params.agentId);
    return this.#call(pluginsAvailable, params);
  }

  /** Installs a plugin, which can run code on the daemon's machine. The caller asks the user first. */
  async installPlugin(agentId: string, id: string): Promise<Plugin> {
    this.#plugins(agentId);
    return (await this.#call(pluginsInstall, { agentId, id, acknowledged: true })).plugin;
  }

  /** Removes a plugin, and the connectors it brought with their credentials. The caller asks the user first. */
  async uninstallPlugin(agentId: string, id: string): Promise<void> {
    this.#plugins(agentId);
    await this.#call(pluginsUninstall, { agentId, id });
  }

  async updatePlugin(agentId: string, id: string): Promise<{ plugin: Plugin; updated: boolean }> {
    this.#plugins(agentId);
    return this.#call(pluginsUpdate, { agentId, id });
  }

  async setPluginEnabled(agentId: string, id: string, enabled: boolean): Promise<Plugin> {
    this.#plugins(agentId);
    return (await this.#call(pluginsSetEnabled, { agentId, id, enabled })).plugin;
  }

  /** Adds a place plugins come from. What it lists can be installed and run. The caller asks the user first. */
  async addPluginSource(agentId: string, location: string): Promise<PluginSource> {
    this.#plugins(agentId);
    return (await this.#call(pluginSourcesAdd, { agentId, location, acknowledged: true })).source;
  }

  async removePluginSource(agentId: string, id: string): Promise<void> {
    this.#plugins(agentId);
    await this.#call(pluginSourcesRemove, { agentId, id });
  }

  /** Fetches a source's list again; every source when none is named. */
  async refreshPluginSources(agentId: string, id?: string): Promise<void> {
    this.#plugins(agentId);
    await this.#call(pluginSourcesRefresh, { agentId, ...(id !== undefined ? { id } : {}) });
  }

  // ---- terminals (docs/protocol.md §8 "终端") ----

  #canOpenTerminals(): void {
    if (this.#capabilities.terminal !== true)
      throw new Error("This daemon is too old to open terminals");
  }

  /**
   * Opens a shell in the session's folder; this client is attached to it. `actionId`: runs that action of the session's
   * environment in it instead (docs/protocol.md §6 "环境").
   */
  async createTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    actionId?: string,
  ): Promise<TerminalAttached> {
    this.#canOpenTerminals();
    if (actionId === undefined) return this.#call(terminalCreate, { sessionId, cols, rows });
    if (this.#capabilities.environments !== true)
      throw new Error("This daemon is too old to run an environment's actions");
    return this.#call(terminalCreate, { sessionId, cols, rows, actionId });
  }

  /** A session's terminals, oldest first. A daemon without terminals has none. */
  async listTerminals(sessionId: string): Promise<TerminalInfo[]> {
    if (this.#capabilities.terminal !== true) return [];
    return (await this.#call(terminalList, { sessionId })).terminals;
  }

  /**
   * The terminal's screen now; its output from then on comes as `terminalOutput`. A lost connection lets go of every
   * terminal: unlike a session, a terminal is not attached again by the client, but by whoever shows it.
   */
  async attachTerminal(terminalId: string): Promise<TerminalAttached> {
    this.#canOpenTerminals();
    return this.#call(terminalAttach, { terminalId });
  }

  async detachTerminal(terminalId: string): Promise<void> {
    await this.#call(terminalDetach, { terminalId });
  }

  /** Keys and pastes, as they are. */
  async terminalInput(terminalId: string, data: string): Promise<void> {
    await this.#call(terminalInput, { terminalId, data });
  }

  async resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    await this.#call(terminalResize, { terminalId, cols, rows });
  }

  /** Ends the shell and what runs in it. The daemon answers at once; the processes end after. */
  async closeTerminal(terminalId: string): Promise<void> {
    await this.#call(terminalClose, { terminalId });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#api().notify(methods.agent.session.cancel, { sessionId } as never);
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<void> {
    await this.#request(methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      type: "id",
      value,
    });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.#call(sessionSetTitle, { sessionId, title });
  }

  /**
   * Says this client has seen the session up to `seq`: its unread mark clears (protocol 0.2).
   * A daemon that does not say it takes `markRead` is older, and is not asked.
   */
  async markRead(sessionId: string, seq: number): Promise<void> {
    const ops = this.#capabilities.sessionOps;
    if (!Array.isArray(ops) || !ops.includes("markRead")) return;
    await this.#call(sessionMarkRead, { sessionId, seq });
  }

  /** The daemon says it can stop one sub-agent alone (`sessionOps` has `stopSubagent`, docs/protocol.md §9). */
  get canStopSubagent(): boolean {
    const ops = this.#capabilities.sessionOps;
    return Array.isArray(ops) && ops.includes("stopSubagent");
  }

  /**
   * Stops one sub-agent of a session (CYCL-143). False when there was nothing to stop (it ended, or its agent cannot),
   * and from a daemon that does not say it can, which is not asked.
   */
  async stopSubagent(sessionId: string, childId: string): Promise<boolean> {
    if (!this.canStopSubagent) return false;
    return (await this.#call(sessionStopSubagent, { sessionId, childId })).stopping;
  }

  async dismissBackground(sessionId: string, taskIds: string[]): Promise<number> {
    return (await this.#call(sessionDismissBackground, { sessionId, taskIds })).dismissed;
  }

  async archive(sessionId: string, archived = true): Promise<void> {
    if (archived) await this.#call(sessionArchive, { sessionId });
    else await this.#call(sessionUnarchive, { sessionId });
  }

  /** The branches a worktree for a session in `cwd` could start from (docs/protocol.md §6 "Worktree"). */
  async gitBranches(cwd: string): Promise<ResultOf<typeof gitBranches>> {
    if (this.#capabilities.worktrees !== true)
      throw new Error("This daemon is too old to make a worktree");
    return this.#call(gitBranches, { cwd });
  }

  /**
   * Removes a session's history for good. The caller asks the user first. `discardWorktree`: also removes the worktree
   * Cycle made for it when it holds work nothing else has (the daemon refuses with `unsaved_changes` otherwise).
   */
  async delete(sessionId: string, options: { discardWorktree?: boolean } = {}): Promise<void> {
    try {
      await this.#request(methods.agent.session.delete, {
        sessionId,
        ...(options.discardWorktree === true
          ? { _meta: { [META.worktree]: { discard: true } } }
          : {}),
      });
    } catch (error) {
      // Refused (a turn is running): the session is still there and still watched, so a reconnect
      // asks for what comes next. Only one that is not there any more is let go.
      if (isSessionGone(error)) this.unwatch(sessionId);
      throw error;
    }
    this.unwatch(sessionId);
  }

  // ---- the connection ----

  #api(): ClientContext {
    if (this.#agent === undefined || this.#state !== "connected") {
      throw new Error("Not connected to the daemon");
    }
    return this.#agent;
  }

  /** A method Cycle defines: what it takes and what it answers are what its definition says. */
  async #call<M extends CycleMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    return (await this.#request(method.name, params)) as ResultOf<M>;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    return this.#api().request(method as never, params as never);
  }

  async #attach(
    sessionId: string,
    entry: { cwd: string; lastSeq: number; replayed: boolean },
    api: ClientContext = this.#api(),
  ) {
    // The first attach asks for everything; after that, only what came after what was seen.
    const replayFrom = entry.replayed
      ? { type: "_cycle.seq", after: entry.lastSeq }
      : { type: "start" };
    const answer = (await api.request(methods.agent.session.resume, {
      sessionId,
      cwd: entry.cwd,
      replayFrom,
    } as never)) as { _meta?: Record<string, unknown> | null } | undefined;
    const waiting = answer?._meta?.[META.pending];
    const wasAttached = entry.replayed;
    entry.replayed = true;
    if (wasAttached) {
      // A list that is not all ids is not read: closing a card on a half-read list would lose one still waited on.
      const ids =
        Array.isArray(waiting) && waiting.every((id) => typeof id === "string")
          ? (waiting as string[])
          : undefined;
      try {
        this.#events.resumed?.(sessionId, ids);
      } catch {
        // The consumer's bookkeeping failing is not the attach failing: the daemon took the resume.
      }
    }
  }

  async #connectOnce(): Promise<void> {
    const channel = await this.#options.connect();
    // Closed while dialling: a channel that arrives now is nobody's, and must not bring it back.
    if (this.#closing) {
      channel.close();
      throw new Error("The client was closed");
    }
    const app = acpClient({ name: this.#options.name ?? "cycle-client" })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.#onUpdate(params.sessionId, params.update, seqOf(params._meta), tsOf(params._meta));
      })
      .onRequest(methods.client.elicitation.create, async ({ params }) => {
        const handler = this.#events.elicitation;
        const sessionId = (params as { sessionId?: string }).sessionId;
        const id = (params._meta as Record<string, unknown> | null | undefined)?.[META.requestId];
        if (handler === undefined || sessionId === undefined) return { action: "cancel" } as never;
        return (await handler(
          sessionId,
          params as unknown as Record<string, unknown>,
          typeof id === "string" ? id : undefined,
        )) as never;
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        const handler = this.#events.permission;
        const id = (params._meta as Record<string, unknown> | null | undefined)?.[META.requestId];
        const answer = handler
          ? await handler(
              params.sessionId,
              params as unknown as Record<string, unknown>,
              typeof id === "string" ? id : undefined,
            )
          : { outcome: "cancelled" as const };
        return { outcome: answer } as never;
      })
      .onNotification(
        NOTIFICATIONS.requestResolved,
        (p: unknown) => p as { sessionId: string; requestId: string | number; outcome: unknown },
        ({ params }) => this.#events.resolved?.(params.sessionId, params.requestId, params.outcome),
      )
      .onNotification(
        NOTIFICATIONS.agentDefaultsChanged,
        (p: unknown) => p as { agent: string },
        ({ params }) => this.#events.defaultsChanged?.(params.agent),
      )
      .onNotification(
        AGENT_SETUP_CHANGED,
        (p: unknown) => p,
        ({ params }) => {
          const told = AgentSetupChangedSchema.safeParse(params);
          if (told.success) {
            this.#events.agentSetupChanged?.(told.data.agent, told.data.revision);
          }
        },
      )
      .onNotification(
        AGENT_AUTH_COMPLETED,
        (p: unknown) => p,
        ({ params }) => {
          const told = AgentAuthCompletedSchema.safeParse(params);
          if (told.success) {
            this.#events.agentAuthCompleted?.(told.data);
          }
        },
      )
      .onNotification(
        PLAN_USAGE_CHANGED,
        (p: unknown) => p,
        ({ params }) => {
          const told = PlanUsageChangedSchema.safeParse(params);
          if (told.success) this.#events.planUsage?.(told.data.agent, told.data.usage);
        },
      )
      .onNotification(
        TERMINAL_NOTIFICATIONS.output,
        (p: unknown) => p,
        ({ params }) => {
          const told = TerminalOutputSchema.safeParse(params);
          if (told.success) this.#events.terminalOutput?.(told.data);
        },
      )
      .onNotification(
        TERMINAL_NOTIFICATIONS.reset,
        (p: unknown) => p,
        ({ params }) => {
          const told = TerminalResetSchema.safeParse(params);
          if (told.success) this.#events.terminalReset?.(told.data);
        },
      )
      .onNotification(
        TERMINAL_NOTIFICATIONS.changed,
        (p: unknown) => p,
        ({ params }) => {
          const told = TerminalChangedSchema.safeParse(params);
          if (told.success)
            this.#events.terminalsChanged?.(told.data.sessionId, told.data.terminals);
        },
      )
      .onNotification(
        CONNECTORS_CHANGED,
        (p: unknown) => p as object,
        () => this.#events.connectorsChanged?.(),
      )
      .onNotification(
        NOTIFICATIONS.providersChanged,
        (p: unknown) => p as object,
        () => this.#events.providersChanged?.(),
      )
      .onNotification(
        PLUGINS_CHANGED,
        (p: unknown) => p,
        ({ params }) => {
          const told = PluginsChangedSchema.safeParse(params);
          if (told.success) this.#events.pluginsChanged?.(told.data.agentId);
        },
      )
      .onNotification(
        NOTIFICATIONS.sessionListChanged,
        (p: unknown) => p as object,
        () => this.#events.listChanged?.(),
      );
    const connection = app.connect(channel.stream);
    try {
      const answer = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: this.#options.name ?? "cycle-client", version: "0.0.0" },
        capabilities: this.#events.elicitation !== undefined ? { elicitation: { form: {} } } : {},
        _meta: {
          [META.protocolVersion]: this.#options.protocolVersion ?? CYCLE_PROTOCOL_VERSION,
          ...(this.#options.ackReturns ? { [META.ackReturns]: true } : {}),
        },
      } as never);
      const info = (answer as { info?: { version?: unknown } }).info;
      this.#serverVersion = typeof info?.version === "string" ? info.version : undefined;
      this.#capabilities =
        ((answer as { _meta?: Record<string, unknown> })._meta?.[META.capabilities] as Record<
          string,
          unknown
        >) ?? {};
    } catch (error) {
      // The daemon answered, and said what protocol it does speak: that is the reason, whole. A refusal that names
      // none (ACP's own, of the integer version) is not about Cycle's protocol, and is told as any other.
      if ((error as { code?: unknown } | null)?.code === UNSUPPORTED_VERSION) {
        const data = (error as { data?: { supported?: unknown } }).data;
        const supported = Array.isArray(data?.supported)
          ? data.supported.filter((v): v is string => typeof v === "string")
          : [];
        if (supported.length > 0) {
          channel.close();
          throw new ProtocolMismatchError(
            supported,
            this.#options.protocolVersion ?? CYCLE_PROTOCOL_VERSION,
            { cause: error },
          );
        }
      }
      // Whatever the far side said is the reason; the protocol's own error is only that it hung up.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const said = channel.diagnostics?.() ?? "";
      channel.close();
      if (said === "") throw error;
      throw new Error(said, { cause: error });
    }
    // Closed while the daemon was being greeted: the same.
    if (this.#closing) {
      channel.close();
      throw new Error("The client was closed");
    }
    this.#channel = channel;
    this.#agent = connection.agent;
    void connection.closed.then(() => this.#lost(channel));
  }

  #onUpdate(
    sessionId: string,
    update: SessionUpdate,
    seq: number | undefined,
    at: number | undefined,
  ): void {
    const entry = this.#watched.get(sessionId);
    // `replay_complete` carries the seq it replayed up to, as a place; it is not a record, and a
    // second one after a reconnect has the same seq as the last record seen.
    const isRecord = seq !== undefined && update.sessionUpdate !== "replay_complete";
    if (isRecord && entry !== undefined) {
      // A replay after a reconnect can overlap what was already seen: show each record once.
      if (seq <= entry.lastSeq) return;
      entry.lastSeq = seq;
    }
    this.#events.update?.(sessionId, update, seq, at);
  }

  #lost(channel: Channel): void {
    if (this.#closing || this.#channel !== channel) return;
    this.#agent = undefined;
    this.#channel = undefined;
    this.#setState("reconnecting");
    this.#reconnecting ??= this.#reconnect().finally(() => {
      this.#reconnecting = undefined;
    });
  }

  async #reconnect(): Promise<void> {
    const backoff = this.#options.backoff ?? { first: 250, max: 5_000 };
    let wait = backoff.first;
    while (!this.#closing) {
      try {
        await this.#connectOnce();
        // Back in the same place: ask for what was missed in every session being watched. The
        // client is not "connected" to anyone until that is done.
        const api = this.#agent;
        if (api === undefined) throw new Error("The connection was lost again");
        for (const [sessionId, entry] of [...this.#watched]) {
          // Dropped (unwatched, or gone) since the list was taken: not asked for.
          if (this.#watched.get(sessionId) !== entry) continue;
          try {
            await this.#attach(sessionId, entry, api);
          } catch (error) {
            // One session that is gone is that session's end, not the host's: the rest are
            // attached. Anything else (the connection itself) is tried again from the start.
            // One whose history cannot be read is the same: its own error to show, not a reason to
            // dial again, which would meet it again.
            if (isLogUnavailable(error)) {
              this.#watched.delete(sessionId);
              this.#events.unreadable?.(sessionId, error);
              continue;
            }
            if (!isSessionGone(error)) throw error;
            this.#watched.delete(sessionId);
            this.#events.gone?.(sessionId);
          }
        }
        if (this.#closing) return;
        this.#setState("connected");
        return;
      } catch (error) {
        // Closed meanwhile: it stays closed, and does not go back to reconnecting.
        if (this.#closing) return;
        this.#agent = undefined;
        this.#channel?.close();
        this.#channel = undefined;
        this.#state = "reconnecting";
        this.#events.connection?.("reconnecting", error);
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, backoff.max);
      }
    }
  }

  #setState(state: ConnectionState, error?: unknown): void {
    this.#state = state;
    this.#events.connection?.(state, error);
  }
}
