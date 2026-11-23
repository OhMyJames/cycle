import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type {
  AnalyticsStatus,
  AppEvent,
  ConnectionState,
  ConnectorInfo,
  CycleBridge,
  EnvironmentConfig,
  PlanUsage,
  PluginFailure,
  PluginInfo,
  PluginSourceInfo,
  Preferences,
  SessionSnapshot,
  SessionSummary,
  TerminalInfo,
  TerminalProblem,
  UpdateState,
} from "../src/api.ts";
import { emptyConversation } from "../src/model/index.ts";

export const LOCAL: EnvironmentConfig = { id: "local", name: "This computer", kind: "local" };
export const summary = (sessionId: string, environmentId = "local"): SessionSummary => ({
  environmentId,
  sessionId,
  cwd: "/work",
  archived: false,
  agent: "fake",
  state: "idle",
  lastSeq: 0,
  // This computer's is the newer, so that it is the workspace shown unless a test says otherwise.
  updatedAt: environmentId === "local" ? "2020-01-02T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
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

/** A bridge that records what it is asked, answers from a script, and lets a test send events. */
export const fakeBridge = (
  options: {
    snapshot?: () => SessionSnapshot | Promise<SessionSnapshot>;
    connected?: boolean;
    update?: UpdateState;
    /** Whether usage statistics are on. Default: nowhere to report to. */
    analytics?: AnalyticsStatus;
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
      sessionMentions?: boolean;
      fs?: boolean;
      diff?: boolean;
      terminal?: boolean;
      stopSubagent?: boolean;
    };
    /** The terminals the daemon has, by session. Changed by what the page asks; a test may change it and emit. */
    terminals?: Map<string, TerminalInfo[]>;
    /** Why the next terminal cannot be opened, if it cannot. */
    terminalProblem?: TerminalProblem;
    /** The connectors the daemon keeps. Changed in place by what the page asks. */
    connectors?: ConnectorInfo[];
    /**
     * An agent's plugins: what can be installed (the installed ones among them) and where it comes from. Changed in
     * place by what the page asks. `fail`: what the next change comes to instead of being done.
     */
    plugins?: { sources: PluginSourceInfo[]; all: PluginInfo[]; fail?: PluginFailure | undefined };
    /** The agent can take a message into a running turn. */
    steer?: boolean;
    /** More environments than the local one, and how each stands (by id; the local one's is `connected`). */
    environments?: EnvironmentConfig[];
    states?: Record<string, ConnectionState>;
    /** The look and the language chosen, and the system's language. Default: follow the system, which is en-US. */
    preferences?: Partial<Preferences> & { systemLanguage?: string };
  } = {},
) => {
  const preferences = {
    theme: "system" as Preferences["theme"],
    language: "system" as Preferences["language"],
    systemLanguage: "en-US",
    ...options.preferences,
  };
  const calls: [string, ...unknown[]][] = [];
  const connectors = options.connectors ?? [];
  const plugins = options.plugins ?? { sources: [], all: [] };
  /** A change to the plugins: refused as the test said, or done. */
  const pluginChange = <T>(done: () => T): T | PluginFailure => {
    if (plugins.fail !== undefined) return plugins.fail;
    return done();
  };
  const pluginAt = (id: string): number => plugins.all.findIndex((p) => p.id === id);
  const terminals = options.terminals ?? new Map<string, TerminalInfo[]>();
  let made = 0;
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
    environments: record("environments", async () => {
      const environments = [LOCAL, ...(options.environments ?? [])];
      return {
        environments,
        status: environments.map((h) => {
          const state =
            options.states?.[h.id] ?? (options.connected === false ? "closed" : "connected");
          return {
            environmentId: h.id,
            state,
            ...(state === "connected"
              ? {
                  capabilities: options.capabilities ?? { queue: true, files: true, folders: true },
                }
              : {}),
          };
        }),
        // What main has read of each environment, through the same call a test may replace to say what a list holds.
        sessions: Object.fromEntries(
          await Promise.all(
            environments.map(async (h) => [h.id, await bridge.sessions(h.id)] as const),
          ),
        ),
      };
    }),
    saveEnvironment: record("saveEnvironment", async () => {}),
    removeEnvironment: record("removeEnvironment", async () => {}),
    connect: record("connect", async () => {}),
    disconnect: record("disconnect", async () => {}),
    sessions: record("sessions", async (environmentId: string) => [summary("s1", environmentId)]),
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
    planUsage: record(
      "planUsage",
      async (_environment: string) => ({}) as Record<string, PlanUsage>,
    ),
    readTrust: record("readTrust", async (_environment: string, path: string) => ({
      path,
      trusted: true,
      from: path,
    })),
    setTrust: record("setTrust", async (_environment: string, path: string, trusted: boolean) => ({
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
      async (environmentId: string, sessionId: string, cols: number, rows: number) => {
        if (options.terminalProblem !== undefined) return { problem: options.terminalProblem };
        made += 1;
        const terminal: TerminalInfo = {
          terminalId: `t${made}`,
          sessionId,
          title: "zsh",
          cols,
          rows,
          status: "running",
        };
        const list = [...(terminals.get(sessionId) ?? []), terminal];
        terminals.set(sessionId, list);
        listener?.({ type: "terminals", environmentId, sessionId, terminals: list });
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
    closeTerminal: record("closeTerminal", async (environmentId: string, terminalId: string) => {
      for (const [sessionId, list] of terminals) {
        if (!list.some((t) => t.terminalId === terminalId)) continue;
        const rest = list.filter((t) => t.terminalId !== terminalId);
        terminals.set(sessionId, rest);
        listener?.({ type: "terminals", environmentId, sessionId, terminals: rest });
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
    stopSubagent: record("stopSubagent", async () => {}),
    archiveSession: record("archiveSession", async () => {}),
    markRead: record("markRead", async () => {}),
    deleteSession: record("deleteSession", async () => {}),
    answerPermission: record("answerPermission", async () => {}),
    answerForm: record("answerForm", async () => {}),
    copyText: record("copyText", async () => true),
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
    listConnectors: record("listConnectors", async () => connectors.map((c) => ({ ...c }))),
    addConnector: record("addConnector", async (_environment: string, draft) => {
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
    updateConnector: record("updateConnector", async (_environment: string, id: string, change) => {
      const at = connectors.findIndex((c) => c.id === id);
      const before = connectors[at];
      if (before === undefined) return { problem: "not_found" as const };
      const { secrets: _secrets, ...rest } = change;
      const connector: ConnectorInfo = { ...before, ...rest };
      connectors[at] = connector;
      return { connector };
    }),
    removeConnector: record("removeConnector", async (_environment: string, id: string) => {
      const at = connectors.findIndex((c) => c.id === id);
      if (at >= 0) connectors.splice(at, 1);
      return { removed: true as const };
    }),
    authorizeConnector: record("authorizeConnector", async (_environment: string, id: string) => {
      const connector = connectors.find((c) => c.id === id);
      if (connector === undefined) return { problem: "not_found" as const };
      connector.authorized = true;
      connector.status = { state: "ready" };
      return { connector: { ...connector } };
    }),
    cancelConnectorAuth: record("cancelConnectorAuth", async () => {}),
    signOutConnector: record("signOutConnector", async (_environment: string, id: string) => {
      const connector = connectors.find((c) => c.id === id);
      if (connector === undefined) return { problem: "not_found" as const };
      connector.authorized = false;
      connector.status = { state: "needs_auth" };
      return { connector: { ...connector } };
    }),
    listPlugins: record("listPlugins", async () => ({
      sources: plugins.sources.map((s) => ({ ...s })),
      plugins: plugins.all.filter((p) => p.installed).map((p) => ({ ...p })),
    })),
    availablePlugins: record(
      "availablePlugins",
      async (
        _environment: string,
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
    installPlugin: record(
      "installPlugin",
      async (_environment: string, _agent: string, id: string) =>
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
      async (_environment: string, _agent: string, id: string) =>
        pluginChange(() => {
          const at = pluginAt(id);
          const before = plugins.all[at];
          if (before !== undefined) plugins.all[at] = { ...before, installed: false };
          return { removed: true as const };
        }),
    ),
    updatePlugin: record("updatePlugin", async (_environment: string, _agent: string, id: string) =>
      pluginChange(() => {
        const plugin = plugins.all[pluginAt(id)];
        if (plugin === undefined) return { problem: "not_found" as const };
        return { plugin: { ...plugin }, updated: false };
      }),
    ),
    setPluginEnabled: record(
      "setPluginEnabled",
      async (_environment: string, _agent: string, id: string, enabled: boolean) =>
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
      async (_environment: string, agentId: string, location: string) =>
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
      async (_environment: string, _agent: string, id: string) =>
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
    preferences: record("preferences", async () => ({ ...preferences })),
    setPreferences: record("setPreferences", async (change: Partial<Preferences>) => {
      Object.assign(preferences, change);
      return { ...preferences };
    }),
    track: record("track", async () => {}),
    analytics: record("analytics", async () => options.analytics ?? off),
    setAnalytics: record("setAnalytics", async (enabled: boolean) => ({
      available: true,
      enabled,
      noticed: true,
    })),
  };
  return {
    bridge,
    calls,
    emit: (event: AppEvent) => listener?.(event),
    named: (n: string) => calls.filter((c) => c[0] === n),
  };
};
