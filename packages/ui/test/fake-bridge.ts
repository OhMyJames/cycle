import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type {
  AccountStatus,
  AnalyticsStatus,
  AppEvent,
  ConnectionState,
  ConnectorInfo,
  CycleBridge,
  Environment,
  EnvironmentsState,
  GitBranches,
  LocationConfig,
  LoopAction,
  LoopActResult,
  LoopBoardAnswer,
  LoopNoticesAnswer,
  LoopProjectsAnswer,
  LoopTicketAnswer,
  PlanUsage,
  PluginFailure,
  PluginInfo,
  PluginSourceInfo,
  Preferences,
  ProviderInfo,
  ProviderKind,
  ProviderModel,
  SessionSnapshot,
  SessionSummary,
  StorageAgent,
  StorageCleanAnswer,
  TerminalInfo,
  TerminalProblem,
  UpdateState,
} from "../src/api.ts";
import { environmentProblem, workspaceKey } from "../src/environments.ts";
import { emptyConversation } from "../src/model/index.ts";

export const LOCAL: LocationConfig = { id: "local", name: "Local", kind: "local" };
export const summary = (sessionId: string, locationId = "local"): SessionSummary => ({
  locationId,
  sessionId,
  cwd: "/work",
  archived: false,
  agent: "fake",
  state: "idle",
  lastSeq: 0,
  // This computer's is the newer, so that it is the workspace shown unless a test says otherwise.
  updatedAt: locationId === "local" ? "2020-01-02T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
});
export const text = (t: string, id = "a") =>
  ({
    sessionUpdate: "agent_message_chunk",
    messageId: id,
    content: { type: "text", text: t },
  }) as SessionUpdate;
export const idle = (extra: object = {}) =>
  ({ sessionUpdate: "state_update", state: "idle", ...extra }) as SessionUpdate;

const off: AnalyticsStatus = { available: false, enabled: false, noticed: true };

/** Signed in, as every test but the account's own starts. */
export const SIGNED_IN: AccountStatus = {
  state: "signed-in",
  open: true,
  signingIn: false,
  user: { name: "Ada Lovelace", email: "ada@example.com" },
};

/** A bridge that records what it is asked, answers from a script, and lets a test send events. */
export const fakeBridge = (
  options: {
    snapshot?: () => SessionSnapshot | Promise<SessionSnapshot>;
    connected?: boolean;
    update?: UpdateState;
    /** Whether usage statistics are on. Default: nowhere to report to. */
    analytics?: AnalyticsStatus;
    loopProjects?: LoopProjectsAnswer;
    loopBoards?: Record<string, LoopBoardAnswer>;
    loopTickets?: Record<string, LoopTicketAnswer>;
    /** What a state button comes to. Default: it worked. */
    loopAct?: LoopActResult;
    loopNotices?: Record<string, LoopNoticesAnswer>;
    /** What the daemon says it can do. Default: all of it. */
    capabilities?: {
      queue: boolean;
      steer?: boolean;
      files: boolean;
      folders: boolean;
      filesInFolder?: boolean;
      trust?: boolean;
      connectors?: boolean;
      plugins?: string[];
      agentSetup?: boolean;
      storage?: boolean;
      agentPrewarm?: boolean;
      sessionMentions?: boolean;
      fs?: boolean;
      diff?: boolean;
      terminal?: boolean;
      worktrees?: boolean;
      stopSubagent?: boolean;
      environments?: boolean;
    };
    /** The environments main keeps, and each workspace's default. Changed in place by what the page asks. */
    environments?: EnvironmentsState;
    /** The terminals the daemon has, by session. Changed by what the page asks; a test may change it and emit. */
    terminals?: Map<string, TerminalInfo[]>;
    /** Why the next terminal cannot be opened, if it cannot. */
    terminalProblem?: TerminalProblem;
    /** The connectors the daemon keeps. Changed in place by what the page asks. */
    connectors?: ConnectorInfo[];
    /** What each agent keeps in its home, and what clearing answers. Changed in place; clearing empties the caches. */
    storage?: { agents: StorageAgent[]; cleanAnswer?: StorageCleanAnswer };
    /** The owner's model providers, the known services, and what each known service serves. Changed in place. */
    providers?: {
      list: ProviderInfo[];
      kinds?: ProviderKind[];
      catalog?: Record<string, ProviderModel[]>;
    };
    /** The keys of the location's vault. Changed in place; a value is not kept, as the daemon never gives one back. */
    vault?: { keys: string[]; fail?: string };
    /**
     * An agent's plugins: what can be installed (the installed ones among them) and where it comes from. Changed in
     * place by what the page asks. `fail`: what the next change comes to instead of being done.
     */
    plugins?: { sources: PluginSourceInfo[]; all: PluginInfo[]; fail?: PluginFailure | undefined };
    /** The agent can take a message into a running turn. */
    steer?: boolean;
    /** More locations than the local one, and how each stands (by id; the local one's is `connected`). */
    locations?: LocationConfig[];
    states?: Record<string, ConnectionState>;
    /** The look and the language chosen, and the system's language. Default: follow the system, which is en-US. */
    preferences?: Partial<Preferences> & { systemLanguage?: string };
    /** What the daemon answers a stop of one sub-agent with (CYCL-143). Default: it is being stopped. */
    stopSubagent?: (childId: string) => Promise<boolean>;
    /** What `gitBranches` answers: the branches of the folder, or null for no repository. */
    branches?: GitBranches | null;
    /** How the account stands. Default: signed in. `signIn` answers with `signInAs` (default: signed in) and says so. */
    account?: AccountStatus;
    signInAs?: AccountStatus;
  } = {},
) => {
  const preferences = {
    theme: "system" as Preferences["theme"],
    language: "system" as Preferences["language"],
    promptSuggestions: true,
    worktreeAgents: [] as string[],
    systemLanguage: "en-US",
    ...options.preferences,
  };
  const calls: [string, ...unknown[]][] = [];
  const connectors = options.connectors ?? [];
  const providers = options.providers ?? { list: [] };
  const vault = options.vault ?? { keys: [] };
  const storage = options.storage ?? { agents: [] };
  const plugins = options.plugins ?? { sources: [], all: [] };
  /** A change to the plugins: refused as the test said, or done. */
  const pluginChange = <T>(done: () => T): T | PluginFailure => {
    if (plugins.fail !== undefined) return plugins.fail;
    return done();
  };
  const pluginAt = (id: string): number => plugins.all.findIndex((p) => p.id === id);
  const terminals = options.terminals ?? new Map<string, TerminalInfo[]>();
  const environments: EnvironmentsState = options.environments ?? {
    environments: [],
    defaults: {},
  };
  const environmentsNow = (): EnvironmentsState => structuredClone(environments);
  let made = 0;
  let account = options.account ?? SIGNED_IN;
  let listener: ((event: AppEvent) => void) | undefined;
  const record =
    <A extends unknown[], R>(name: string, result: (...args: A) => R) =>
    (...args: A): R => {
      calls.push([name, ...args]);
      return result(...args);
    };
  const bridge: CycleBridge = {
    onEvent: (l) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    locations: record("locations", async () => {
      const locations = [LOCAL, ...(options.locations ?? [])];
      return {
        locations,
        status: locations.map((h) => {
          const state =
            options.states?.[h.id] ?? (options.connected === false ? "closed" : "connected");
          return {
            locationId: h.id,
            state,
            ...(state === "connected"
              ? {
                  capabilities: options.capabilities ?? { queue: true, files: true, folders: true },
                }
              : {}),
          };
        }),
        // What main has read of each location, through the same call a test may replace to say what a list holds.
        sessions: Object.fromEntries(
          await Promise.all(
            locations.map(async (h) => [h.id, await bridge.sessions(h.id)] as const),
          ),
        ),
      };
    }),
    saveLocation: record("saveLocation", async () => {}),
    removeLocation: record("removeLocation", async () => {}),
    connect: record("connect", async () => {}),
    disconnect: record("disconnect", async () => {}),
    sessions: record("sessions", async (locationId: string) => [summary("s1", locationId)]),
    createSession: record("createSession", async () => "s2"),
    openSession: record(
      "openSession",
      async () =>
        (await options.snapshot?.()) ?? {
          conversation: emptyConversation(),
          permissions: [],
          version: 0,
        },
    ),
    prompt: record("prompt", async () => {}),
    cancel: record("cancel", async () => {}),
    ackReturn: record("ackReturn", async () => {}),
    dequeue: record("dequeue", async () => []),
    listFolders: record("listFolders", async () => ({
      path: "/home/me",
      parent: "/home",
      home: "/home/me",
      folders: [{ name: "app" }, { name: "docs" }],
      truncated: false,
    })),
    planUsage: record("planUsage", async (_location: string) => ({}) as Record<string, PlanUsage>),
    readTrust: record("readTrust", async (_location: string, path: string) => ({
      path,
      trusted: true,
      from: path,
    })),
    setTrust: record("setTrust", async (_location: string, path: string, trusted: boolean) => ({
      path,
      trusted,
      from: path,
    })),
    listFiles: record("listFiles", async (_e: string, _s: string, path: string) => ({
      root: "/work",
      path,
      entries: [],
      truncated: false,
    })),
    readFile: record("readFile", async (_e: string, _s: string, path: string) => ({
      path,
      size: 0,
      mtimeMs: 0,
      kind: "text" as const,
      text: "",
      offset: 0,
      next: null,
    })),
    workspaceStatus: record("workspaceStatus", async () => ({ state: "not_git" as const })),
    workspaceFile: record("workspaceFile", async (_e: string, _s: string, path: string) => ({
      path,
      patch: "",
      truncated: false,
      binary: false,
    })),
    listTerminals: record("listTerminals", async (_e: string, sessionId: string) => [
      ...(terminals.get(sessionId) ?? []),
    ]),
    createTerminal: record(
      "createTerminal",
      async (
        locationId: string,
        sessionId: string,
        cols: number,
        rows: number,
        actionId?: string,
      ) => {
        if (options.terminalProblem !== undefined) return { problem: options.terminalProblem };
        made += 1;
        const terminal: TerminalInfo = {
          terminalId: `t${made}`,
          sessionId,
          title: actionId ?? "zsh",
          cols,
          rows,
          status: "running",
        };
        const list = [...(terminals.get(sessionId) ?? []), terminal];
        terminals.set(sessionId, list);
        listener?.({ type: "terminals", locationId, sessionId, terminals: list });
        return { terminal, screen: "", seq: 0 };
      },
    ),
    attachTerminal: record("attachTerminal", async (_e: string, terminalId: string) => {
      const terminal = [...terminals.values()].flat().find((t) => t.terminalId === terminalId);
      if (terminal === undefined) throw new Error(`No terminal ${terminalId}`);
      return { terminal, screen: `screen of ${terminalId}\r\n`, seq: 3 };
    }),
    detachTerminal: record("detachTerminal", async () => {}),
    terminalInput: record("terminalInput", async () => {}),
    resizeTerminal: record("resizeTerminal", async () => {}),
    closeTerminal: record("closeTerminal", async (locationId: string, terminalId: string) => {
      for (const [sessionId, list] of terminals) {
        if (!list.some((t) => t.terminalId === terminalId)) continue;
        const rest = list.filter((t) => t.terminalId !== terminalId);
        terminals.set(sessionId, rest);
        listener?.({ type: "terminals", locationId, sessionId, terminals: rest });
      }
    }),
    searchFiles: record("searchFiles", async () => ({
      root: "/work",
      entries: [],
      truncated: false,
    })),
    setSessionConfig: record("setSessionConfig", async () => {}),
    renameSession: record("renameSession", async () => {}),
    dismissBackground: record("dismissBackground", async () => {}),
    stopSubagent: record(
      "stopSubagent",
      async (_locationId: string, _sessionId: string, childId: string, _background: boolean) =>
        options.stopSubagent?.(childId) ?? true,
    ),
    archiveSession: record("archiveSession", async () => {}),
    markRead: record("markRead", async () => {}),
    deleteSession: record("deleteSession", async () => undefined),
    gitBranches: record("gitBranches", async () => options.branches ?? null),
    answerPermission: record("answerPermission", async () => {}),
    answerForm: record("answerForm", async () => {}),
    copyText: record("copyText", async () => true),
    copyImage: record("copyImage", async () => true),
    saveImage: record("saveImage", async () => "saved" as const),
    agents: record("agents", async () => [
      {
        id: "fake",
        name: "Fake",
        available: true,
        configSchema: {},
        ...(options.steer === true ? { steer: true } : {}),
      },
    ]),
    agentDefaults: record("agentDefaults", async () => ({})),
    setAgentDefaults: record("setAgentDefaults", async () => {}),
    readAgentSetup: record("readAgentSetup", async (_locationId: string, agent: string) => ({
      agent,
      name:
        agent === "claude"
          ? "Claude"
          : agent === "codex"
            ? "Codex"
            : agent === "agy"
              ? "Antigravity"
              : agent,
      available: true,
      binary: { source: "builtin" as const, path: `/opt/cycle/${agent}`, version: "1.0.0" },
      auth: {
        state: "signed_out" as const,
        method: "none" as const,
        signInModes: [],
        canSignOut: false,
        loginCommand: `cycle login ${agent}`,
      },
      canRefreshUsage: agent === "codex",
      runtime: {
        schemaVersion: 1 as const,
        schema: { type: "object" as const, properties: {} },
        values: {},
        overrides: [],
        revision: 0,
      },
      environment: {
        configFile: { path: "/tmp/cycle/config.json", exists: true, stale: false },
        dataDir: `/tmp/cycle/${agent}`,
        customDataDir: false,
        allowEnv: ["PATH", "LANG"],
        envNames: [],
      },
    })),
    setAgentRuntimeSettings: record(
      "setAgentRuntimeSettings",
      async (
        _locationId: string,
        _agent: string,
        patch: Record<string, boolean | number | string | null>,
        expectedRevision: number,
      ) => {
        const values: Record<string, boolean | number | string> = {};
        const overrides: string[] = [];
        for (const [k, v] of Object.entries(patch)) {
          if (v !== null) {
            values[k] = v;
            overrides.push(k);
          }
        }
        return { saved: true as const, values, overrides, revision: expectedRevision + 1 };
      },
    ),
    prewarmAgent: record("prewarmAgent", async () => {}),
    revealDaemonConfig: record("revealDaemonConfig", async () => true),
    startAgentAuth: record("startAgentAuth", async () => ({
      started: false as const,
      reason: "unsupported_mode" as const,
    })),
    openAgentAuthUrl: record("openAgentAuthUrl", async () => true),
    submitAgentAuth: record("submitAgentAuth", async () => ({ ok: true as const })),
    cancelAgentAuth: record("cancelAgentAuth", async () => {}),
    logoutAgent: record("logoutAgent", async () => ({ ok: true as const })),
    listConnectors: record("listConnectors", async () => connectors.map((c) => ({ ...c }))),
    addConnector: record("addConnector", async (_location: string, draft) => {
      const connector: ConnectorInfo = {
        id: `c${connectors.length + 1}`,
        name: draft.name,
        enabled: draft.enabled ?? true,
        transport: draft.transport,
        auth: draft.auth,
        secrets: {
          headers: Object.keys(draft.secrets?.headers ?? {}),
          env: Object.keys(draft.secrets?.env ?? {}),
        },
        authorized: false,
        status: { state: draft.auth.type === "oauth" ? "needs_auth" : "ready" },
      };
      connectors.push(connector);
      return { connector };
    }),
    updateConnector: record("updateConnector", async (_location: string, id: string, change) => {
      const at = connectors.findIndex((c) => c.id === id);
      const before = connectors[at];
      if (before === undefined) return { problem: "not_found" as const };
      const { secrets: _secrets, ...rest } = change;
      const connector: ConnectorInfo = { ...before, ...rest };
      connectors[at] = connector;
      return { connector };
    }),
    removeConnector: record("removeConnector", async (_location: string, id: string) => {
      const at = connectors.findIndex((c) => c.id === id);
      if (at >= 0) connectors.splice(at, 1);
      return { removed: true as const };
    }),
    authorizeConnector: record("authorizeConnector", async (_location: string, id: string) => {
      const connector = connectors.find((c) => c.id === id);
      if (connector === undefined) return { problem: "not_found" as const };
      connector.authorized = true;
      connector.status = { state: "ready" };
      return { connector: { ...connector } };
    }),
    cancelConnectorAuth: record("cancelConnectorAuth", async () => {}),
    signOutConnector: record("signOutConnector", async (_location: string, id: string) => {
      const connector = connectors.find((c) => c.id === id);
      if (connector === undefined) return { problem: "not_found" as const };
      connector.authorized = false;
      connector.status = { state: "needs_auth" };
      return { connector: { ...connector } };
    }),
    readStorage: record("readStorage", async () =>
      storage.agents.map((a) => ({ ...a, items: a.items.map((i) => ({ ...i })) })),
    ),
    cleanStorage: record("cleanStorage", async (_location: string, agent: string) => {
      const answer = storage.cleanAnswer ?? { cleaned: true as const, freedBytes: 0 };
      if (answer.cleaned) {
        const found = storage.agents.find((a) => a.agent === agent);
        if (found) found.items = found.items.filter((i) => i.kind !== "cache");
      }
      return answer;
    }),
    listProviders: record("listProviders", async () => ({
      providers: providers.list.map((p) => ({ ...p, models: [...p.models] })),
      kinds: providers.kinds ?? [],
    })),
    providerCatalog: record(
      "providerCatalog",
      async (_location: string, kind: string) => providers.catalog?.[kind] ?? [],
    ),
    saveProvider: record("saveProvider", async (_location: string, draft) => {
      const before = providers.list.find((p) => p.id === draft.id);
      if (draft.id !== undefined && before === undefined) return { problem: "not_found" as const };
      // A key is only ever written: what comes back says there is one, as the daemon's answer does.
      const provider: ProviderInfo = {
        id: before?.id ?? `p${providers.list.length + 1}`,
        name: draft.name,
        kind: before?.kind ?? draft.kind,
        api: draft.api,
        baseUrl: draft.baseUrl,
        hasKey:
          draft.apiKey === undefined
            ? before !== undefined && before.baseUrl === draft.baseUrl && before.hasKey
            : draft.apiKey !== "",
        models: draft.models,
      };
      const at = providers.list.findIndex((p) => p.id === provider.id);
      if (at < 0) providers.list.push(provider);
      else providers.list[at] = provider;
      return { provider };
    }),
    removeProvider: record("removeProvider", async (_location: string, id: string) => {
      const at = providers.list.findIndex((p) => p.id === id);
      if (at >= 0) providers.list.splice(at, 1);
      return { removed: true as const };
    }),
    listVault: record("listVault", async () => {
      if (vault.fail !== undefined) throw new Error(vault.fail);
      return [...vault.keys];
    }),
    setVaultItem: record("setVaultItem", async (_location: string, key: string) => {
      if (!vault.keys.includes(key)) vault.keys.push(key);
      return { done: true as const };
    }),
    removeVaultItem: record("removeVaultItem", async (_location: string, key: string) => {
      vault.keys = vault.keys.filter((k) => k !== key);
      return { done: true as const };
    }),
    listPlugins: record("listPlugins", async () => ({
      sources: plugins.sources.map((s) => ({ ...s })),
      plugins: plugins.all.filter((p) => p.installed).map((p) => ({ ...p })),
    })),
    availablePlugins: record(
      "availablePlugins",
      async (
        _location: string,
        asked: { sourceId?: string; query?: string; cursor?: string; limit?: number },
      ) => {
        const query = asked.query?.toLowerCase() ?? "";
        const found = plugins.all.filter(
          (p) =>
            (asked.sourceId === undefined || p.sourceId === asked.sourceId) &&
            (query === "" ||
              p.name.toLowerCase().includes(query) ||
              (p.description?.toLowerCase().includes(query) ?? false)),
        );
        const from = Number(asked.cursor ?? "0");
        const to = from + (asked.limit ?? 50);
        return {
          plugins: found.slice(from, to).map((p) => ({ ...p })),
          ...(to < found.length ? { nextCursor: String(to) } : {}),
          total: found.length,
        };
      },
    ),
    installPlugin: record("installPlugin", async (_location: string, _agent: string, id: string) =>
      pluginChange(() => {
        const at = pluginAt(id);
        const before = plugins.all[at];
        if (before === undefined) return { problem: "not_found" as const };
        const plugin: PluginInfo = {
          contents: { skills: 1, commands: 0, agents: 0, hooks: 0, mcpServers: 0 },
          ...before,
          installed: true,
          enabled: true,
          scope: "user",
        };
        plugins.all[at] = plugin;
        return { plugin: { ...plugin } };
      }),
    ),
    uninstallPlugin: record(
      "uninstallPlugin",
      async (_location: string, _agent: string, id: string) =>
        pluginChange(() => {
          const at = pluginAt(id);
          const before = plugins.all[at];
          if (before !== undefined) plugins.all[at] = { ...before, installed: false };
          return { removed: true as const };
        }),
    ),
    updatePlugin: record("updatePlugin", async (_location: string, _agent: string, id: string) =>
      pluginChange(() => {
        const plugin = plugins.all[pluginAt(id)];
        if (plugin === undefined) return { problem: "not_found" as const };
        return { plugin: { ...plugin }, updated: false };
      }),
    ),
    setPluginEnabled: record(
      "setPluginEnabled",
      async (_location: string, _agent: string, id: string, enabled: boolean) =>
        pluginChange(() => {
          const at = pluginAt(id);
          const before = plugins.all[at];
          if (before === undefined) return { problem: "not_found" as const };
          const plugin = { ...before, enabled };
          plugins.all[at] = plugin;
          return { plugin: { ...plugin } };
        }),
    ),
    addPluginSource: record(
      "addPluginSource",
      async (_location: string, agentId: string, location: string) =>
        pluginChange(() => {
          const source: PluginSourceInfo = {
            agentId,
            id: `source-${plugins.sources.length + 1}`,
            name: location.split("/").at(-1) ?? location,
            kind: "git",
            location,
            removable: true,
          };
          plugins.sources.push(source);
          return { source: { ...source } };
        }),
    ),
    removePluginSource: record(
      "removePluginSource",
      async (_location: string, _agent: string, id: string) =>
        pluginChange(() => {
          const at = plugins.sources.findIndex((s) => s.id === id);
          if (at >= 0) plugins.sources.splice(at, 1);
          return { removed: true as const };
        }),
    ),
    refreshPluginSources: record("refreshPluginSources", async () =>
      pluginChange(() => ({ refreshed: true as const })),
    ),
    chooseDirectory: record("chooseDirectory", async () => "/chosen"),
    updateState: record(
      "updateState",
      async () => options.update ?? { current: "0.1.0", kind: "idle" as const },
    ),
    checkForUpdate: record(
      "checkForUpdate",
      async () => options.update ?? { current: "0.1.0", kind: "up-to-date" as const, checkedAt: 0 },
    ),
    installUpdate: record("installUpdate", async () => {}),
    upgradeDaemon: record("upgradeDaemon", async () => {}),
    environments: record("environments", async () => environmentsNow()),
    saveEnvironment: record("saveEnvironment", async (environment: Environment) => {
      const problem = environmentProblem(environment);
      if (problem !== undefined) return problem;
      const at = environments.environments.findIndex((e) => e.id === environment.id);
      if (at === -1) environments.environments.push(structuredClone(environment));
      else environments.environments[at] = structuredClone(environment);
      return { state: environmentsNow() };
    }),
    removeEnvironment: record("removeEnvironment", async (environmentId: string) => {
      environments.environments = environments.environments.filter((e) => e.id !== environmentId);
      for (const folders of Object.values(environments.defaults))
        for (const [cwd, id] of Object.entries(folders))
          if (id === environmentId) delete folders[cwd];
      return environmentsNow();
    }),
    setEnvironmentDefault: record(
      "setEnvironmentDefault",
      async (locationId: string, cwd: string, environmentId: string | null) => {
        const folders = environments.defaults[locationId] ?? {};
        environments.defaults[locationId] = folders;
        if (environmentId === null) delete folders[workspaceKey(cwd)];
        else folders[workspaceKey(cwd)] = environmentId;
        return environmentsNow();
      },
    ),
    preferences: record("preferences", async () => ({ ...preferences })),
    setPreferences: record("setPreferences", async (change: Partial<Preferences>) => {
      Object.assign(preferences, change);
      return { ...preferences };
    }),
    account: record("account", async () => account),
    signIn: record("signIn", async () => {
      account = options.signInAs ?? SIGNED_IN;
      listener?.({ type: "account", account });
      return account;
    }),
    cancelSignIn: record("cancelSignIn", async () => {}),
    signOut: record("signOut", async () => {
      account = { state: "signed-out", open: false, signingIn: false };
      listener?.({ type: "account", account });
    }),
    track: record("track", async () => {}),
    analytics: record("analytics", async () => options.analytics ?? off),
    setAnalytics: record("setAnalytics", async (enabled: boolean) => ({
      available: true,
      enabled,
      noticed: true,
    })),
    loopProjects: record(
      "loopProjects",
      async (): Promise<LoopProjectsAnswer> => options.loopProjects ?? { kind: "disconnected" },
    ),
    loopBoard: record(
      "loopBoard",
      async (projectKey: string): Promise<LoopBoardAnswer> =>
        options.loopBoards?.[projectKey] ?? { kind: "no_key" },
    ),
    loopTicket: record(
      "loopTicket",
      async (_projectKey: string, identifier: string): Promise<LoopTicketAnswer> =>
        options.loopTickets?.[identifier] ?? { kind: "no_key" },
    ),
    loopNotices: record(
      "loopNotices",
      async (projectKey: string): Promise<LoopNoticesAnswer> =>
        options.loopNotices?.[projectKey] ?? { kind: "no_key" },
    ),
    loopAct: record(
      "loopAct",
      async (
        _projectKey: string,
        _identifier: string,
        _action: LoopAction,
        _confirmed?: boolean,
      ): Promise<LoopActResult> => options.loopAct ?? { kind: "ok" },
    ),
  };
  return {
    bridge,
    calls,
    emit: (event: AppEvent) => listener?.(event),
    named: (n: string) => calls.filter((c) => c[0] === n),
  };
};
