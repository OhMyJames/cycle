// What the page asks of one location: its sessions, files, terminals, agents, connectors and plugins. Most go
// straight to its daemon and report what was done (docs/analytics.md); an action whose failure is an answer the page
// shows, rather than a throw, goes through `runAction`.
import { agentOf, renameWhereOf, settingOf, sizeOf, viaOf } from "@cycle/analytics/events";
import type { CycleClient } from "@cycle/client";
import type {
  AgentInfo,
  ConnectorAnswer,
  ConnectorChange,
  ConnectorDraft,
  ConnectorInfo,
  ConnectorProblem,
  Environment,
  EnvironmentRefusal,
  FileContent,
  FileListing,
  FileSearch,
  FolderListing,
  FolderTrust,
  NewSession,
  PlanUsage,
  PluginFailure,
  PluginInfo,
  PluginProblem,
  PluginSourceInfo,
  PromptBlock,
  TerminalAttached,
  TerminalInfo,
  TerminalProblem,
  WorkspacePatch,
  WorkspaceStatus,
} from "@cycle/ui";
import { ENVIRONMENT_REFUSALS } from "@cycle/ui/api";
import { authorizeInBrowser } from "./connector-auth.ts";
import type { Environments } from "./environments.ts";
import { messageOf, type Runtime } from "./runtime.ts";
import type { SessionWatcher } from "./watcher.ts";

const PROBLEMS: readonly ConnectorProblem[] = [
  "invalid_name",
  "reserved_header",
  "invalid_cwd",
  "name_taken",
  "insecure_url",
  "state_mismatch",
  "no_registration",
  "managed",
  "auth_rejected",
  "unreachable",
];

const TERMINAL_REASONS: readonly TerminalProblem[] = [
  "archived",
  "cwd_missing",
  "spawn_failed",
  "daemon_stopping",
  "unknown_action",
];

/**
 * The daemon's refusal of a session's environment (`-32602` with one of its reasons, docs/protocol.md §6 "环境"), as the
 * page is answered it: the reason, and the variable's name when it is about one. Undefined: not one of those.
 */
export const environmentRefusalOf = (error: unknown): EnvironmentRefusal | undefined => {
  const { code, data } = (error ?? {}) as {
    code?: unknown;
    data?: { reason?: unknown; name?: unknown };
  };
  if (code !== -32602) return undefined;
  const reason = ENVIRONMENT_REFUSALS.find((r) => r === data?.reason && r !== "missing");
  if (reason === undefined) return undefined;
  return { reason, ...(typeof data?.name === "string" ? { name: data.name } : {}) };
};

/** Why the daemon would not open a terminal, as a word the page has a sentence for (docs/protocol.md §8 "终端"). */
export const terminalProblemOf = (
  error: unknown,
): { problem: TerminalProblem; message?: string } => {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: { reason?: unknown } };
  const reason = data?.reason;
  if (typeof reason === "string" && (TERMINAL_REASONS as readonly string[]).includes(reason))
    return { problem: reason as TerminalProblem };
  if (code === -32019) return { problem: "limit" };
  if (code === -32002) return { problem: "not_found" };
  return { problem: "failed", message: messageOf(error) };
};

/** What the daemon's error says, as a word the page has a sentence for (docs/protocol.md §14). */
export const connectorProblemOf = (
  error: unknown,
): { problem: ConnectorProblem; message?: string } => {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: { reason?: unknown } };
  const reason = data?.reason;
  if (typeof reason === "string" && (PROBLEMS as readonly string[]).includes(reason))
    return { problem: reason as ConnectorProblem };
  if (code === -32002) return { problem: "not_found" };
  if (code === -32017) return { problem: "unreachable" };
  if (code === -32602) return { problem: "invalid" };
  if (messageOf(error).includes("too old to keep connectors")) return { problem: "unsupported" };
  return { problem: "failed", message: messageOf(error) };
};

const PLUGIN_REASONS: readonly PluginProblem[] = [
  "not_found",
  "needs_command",
  "unavailable",
  "timeout",
];

/**
 * Why an agent's plugin machinery did not do it, as a word the page has a sentence for (docs/protocol.md §15).
 * `message` is what that machinery said: for the person, never for analytics.
 */
export const pluginProblemOf = (error: unknown): PluginFailure => {
  const { code, data } = (error ?? {}) as {
    code?: unknown;
    data?: { reason?: unknown; detail?: unknown };
  };
  const reason = data?.reason;
  const detail = typeof data?.detail === "string" && data.detail !== "" ? data.detail : undefined;
  const said = detail !== undefined ? { message: detail } : {};
  if (typeof reason === "string" && (PLUGIN_REASONS as readonly string[]).includes(reason))
    return { problem: reason as PluginProblem, ...said };
  if (code === -32002) return { problem: "not_found" };
  if (messageOf(error).includes("too old to keep plugins")) return { problem: "unsupported" };
  return { problem: "failed", message: detail ?? messageOf(error) };
};

/**
 * Runs one of the page's actions whose failure is an answer rather than a throw (a connector that will not sign in, a
 * plugin that will not install): what went wrong comes back as `problemOf` words it. `report` is told what came back,
 * whichever it was, once.
 */
const runAction = async <T extends object, F extends object>(
  act: () => Promise<T>,
  problemOf: (error: unknown) => F,
  report?: (answer: T | F) => void,
): Promise<T | F> => {
  let answer: T | F;
  try {
    answer = await act();
  } catch (error) {
    answer = problemOf(error);
  }
  try {
    report?.(answer);
  } catch {
    // A report that fails is a count missed, not an action undone: the answer is what the daemon did.
  }
  return answer;
};

/** The `result` of a plugin event: `ok`, or the word for what went wrong. */
const pluginResultOf = (answer: object): PluginProblem | "ok" =>
  "problem" in answer ? (answer as PluginFailure).problem : "ok";

export class LocationActions {
  readonly #runtime: Runtime;
  readonly #watcher: SessionWatcher;
  /** The environments the person defined: a session is sent the one chosen for it, whole. */
  protected readonly environmentStore: Environments;
  /** The sign-in waiting for the browser: one at a time, a new one stops it. */
  #signIn: AbortController | undefined;

  constructor(runtime: Runtime, watcher: SessionWatcher, environments: Environments) {
    this.#runtime = runtime;
    this.#watcher = watcher;
    this.environmentStore = environments;
  }

  // ---- sessions ----

  /** Without an environment nothing can be refused: the answer is the session's id. */
  createSession(
    locationId: string,
    params: NewSession & { environmentId?: undefined },
  ): Promise<string>;
  createSession(
    locationId: string,
    params: NewSession,
  ): Promise<string | { problem: EnvironmentRefusal }>;
  async createSession(
    locationId: string,
    params: NewSession,
  ): Promise<string | { problem: EnvironmentRefusal }> {
    const connection = this.#runtime.connection(locationId);
    // The environment as it is now: a change made to it later is not this session's (docs/desktop.md "环境").
    let environment: Environment | undefined;
    if (params.environmentId !== undefined) {
      const snapshot = await this.environmentStore.snapshot(params.environmentId);
      if ("problem" in snapshot) return snapshot;
      environment = snapshot;
    }
    const { environmentId: _chosen, ...rest } = params;
    let sessionId: string;
    try {
      sessionId = await connection.client.newSession({
        ...rest,
        ...(environment !== undefined ? { environment } : {}),
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === -32000) {
        this.#runtime.track("agent_auth_required", {
          agent: agentOf(params.agent ?? ""),
          location: this.#runtime.kindOf(locationId),
        });
        const detail = error instanceof Error ? error.message : "Authentication required";
        const authError = new Error(
          detail.includes("-32000") ? detail : `Authentication required (-32000): ${detail}`,
        );
        (authError as { code?: number }).code = -32000;
        throw authError;
      }
      const refused = environmentRefusalOf(error);
      if (refused !== undefined) return { problem: refused };
      throw error;
    }
    // Not in the list until its first message (docs/protocol.md §6): the daemon announces it then, and it is read again.
    connection.made.set(sessionId, params.cwd);
    // Its agent is not in the list yet either, and the reports about it (opened, a prompt) need the word for it.
    connection.madeAgent.set(sessionId, params.agent ?? "");
    this.#runtime.track("session_created", {
      agent: agentOf(params.agent ?? ""),
      location: this.#runtime.kindOf(locationId),
      configured: Object.keys(params.config ?? {}).length > 0,
    });
    return sessionId;
  }

  async prompt(
    locationId: string,
    sessionId: string,
    content: string | PromptBlock[],
    options: { steer?: boolean; via?: unknown } = {},
  ): Promise<void> {
    const blocks =
      typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
    // The page's blocks are the daemon's to check: a block it does not take is refused whole there (decision 0010).
    await this.#runtime
      .connection(locationId)
      .client.prompt(sessionId, blocks as Parameters<CycleClient["prompt"]>[1], {
        ...(options.steer === true ? { steer: true } : {}),
        ...(this.#runtime.options.promptSuggestions !== undefined
          ? { promptSuggestions: this.#runtime.options.promptSuggestions() }
          : {}),
      });
    // How much, never what: the length in three words and the number of images, files and mentions.
    this.#runtime.track("prompt_sent", {
      agent: this.#runtime.agentOf(locationId, sessionId),
      location: this.#runtime.kindOf(locationId),
      size: sizeOf(blocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0)),
      images: blocks.filter((b) => b.type === "image").length,
      files: blocks.filter((b) => b.type === "resource").length,
      mentions: blocks.filter((b) => b.type === "resource_link").length,
      steered: options.steer === true,
      // The page says which key or button; only the dictionary's words are counted, anything else is "other".
      via: viaOf(options.via),
    });
  }

  async cancel(locationId: string, sessionId: string): Promise<void> {
    await this.#runtime.connection(locationId).client.cancel(sessionId);
    this.#runtime.track("prompt_cancelled", {
      agent: this.#runtime.agentOf(locationId, sessionId),
    });
  }

  async listFolders(locationId: string, path?: string, hidden?: boolean): Promise<FolderListing> {
    return this.#runtime.connection(locationId).client.listFolders(path, hidden);
  }

  async planUsage(locationId: string): Promise<Record<string, PlanUsage>> {
    return this.#runtime.connection(locationId).client.readPlanUsage();
  }

  async readTrust(locationId: string, path: string): Promise<FolderTrust> {
    return this.#runtime.connection(locationId).client.readTrust(path);
  }

  async setTrust(locationId: string, path: string, trusted: boolean): Promise<FolderTrust> {
    return this.#runtime.connection(locationId).client.setTrust(path, trusted);
  }

  async searchFiles(
    locationId: string,
    where: { sessionId: string } | { cwd: string },
    query: string,
  ): Promise<FileSearch> {
    return this.#runtime
      .connection(locationId)
      .client.searchFiles("sessionId" in where ? where.sessionId : { cwd: where.cwd }, query);
  }

  async listFiles(locationId: string, sessionId: string, path: string): Promise<FileListing> {
    return this.#runtime.connection(locationId).client.listFiles(sessionId, path);
  }

  async readFile(
    locationId: string,
    sessionId: string,
    path: string,
    offset?: number,
  ): Promise<FileContent> {
    return this.#runtime.connection(locationId).client.readFile(sessionId, path, offset);
  }

  async listTerminals(locationId: string, sessionId: string): Promise<TerminalInfo[]> {
    return this.#runtime.connection(locationId).client.listTerminals(sessionId);
  }

  async createTerminal(
    locationId: string,
    sessionId: string,
    cols: number,
    rows: number,
    actionId?: unknown,
  ): Promise<TerminalAttached | { problem: TerminalProblem; message?: string }> {
    const action = typeof actionId === "string" ? actionId : undefined;
    return runAction(
      () =>
        this.#runtime.connection(locationId).client.createTerminal(sessionId, cols, rows, action),
      terminalProblemOf,
      (answer) => {
        // Which action, never: only that one ran.
        if (action !== undefined && !("problem" in answer))
          this.#runtime.track("environment_action_run", {});
      },
    );
  }

  async attachTerminal(locationId: string, terminalId: string): Promise<TerminalAttached> {
    return this.#runtime.connection(locationId).client.attachTerminal(terminalId);
  }

  async detachTerminal(locationId: string, terminalId: string): Promise<void> {
    await this.#runtime.connection(locationId).client.detachTerminal(terminalId);
  }

  async terminalInput(locationId: string, terminalId: string, data: string): Promise<void> {
    await this.#runtime.connection(locationId).client.terminalInput(terminalId, data);
  }

  async resizeTerminal(
    locationId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    await this.#runtime.connection(locationId).client.resizeTerminal(terminalId, cols, rows);
  }

  async closeTerminal(locationId: string, terminalId: string): Promise<void> {
    await this.#runtime.connection(locationId).client.closeTerminal(terminalId);
  }

  async workspaceStatus(locationId: string, sessionId: string): Promise<WorkspaceStatus> {
    return this.#runtime.connection(locationId).client.workspaceStatus(sessionId);
  }

  async workspaceFile(
    locationId: string,
    sessionId: string,
    path: string,
  ): Promise<WorkspacePatch> {
    return this.#runtime.connection(locationId).client.workspaceFile(sessionId, path);
  }

  async ackReturn(locationId: string, sessionId: string, returnId: string): Promise<void> {
    if (await this.#runtime.connection(locationId).client.ackReturn(sessionId, returnId))
      this.#runtime.track("queue_return_restored", {});
  }

  async dequeue(locationId: string, sessionId: string, queueId: string): Promise<PromptBlock[]> {
    return (await this.#runtime
      .connection(locationId)
      .client.dequeue(sessionId, queueId)) as PromptBlock[];
  }

  async setSessionConfig(locationId: string, sessionId: string, configId: string, value: string) {
    await this.#runtime.connection(locationId).client.setConfig(sessionId, configId, value);
    this.#runtime.track("session_config_changed", { setting: settingOf(configId) });
  }

  /** `where`: what the page says it was edited in; checked here, since the page's word is not trusted. */
  async renameSession(
    locationId: string,
    sessionId: string,
    title: string,
    where?: unknown,
  ): Promise<void> {
    await this.#runtime.connection(locationId).client.rename(sessionId, title);
    this.#runtime.track("session_renamed", { where: renameWhereOf(where) });
  }

  async dismissBackground(locationId: string, sessionId: string, taskIds: string[]): Promise<void> {
    const count = await this.#runtime
      .connection(locationId)
      .client.dismissBackground(sessionId, taskIds);
    if (count > 0) this.#runtime.track("background_dismissed", { count });
  }

  /** Stops one sub-agent of a session (CYCL-143); whether it was running in the background is all that is told. */
  async stopSubagent(
    locationId: string,
    sessionId: string,
    childId: string,
    background: boolean,
  ): Promise<boolean> {
    const stopping = await this.#runtime
      .connection(locationId)
      .client.stopSubagent(sessionId, childId);
    // From the page: only a boolean is told, whatever came.
    if (stopping) this.#runtime.track("subagent_stopped", { background: background === true });
    return stopping;
  }

  async archiveSession(locationId: string, sessionId: string, archived: boolean): Promise<void> {
    await this.#runtime.connection(locationId).client.archive(sessionId, archived);
    this.#runtime.track("session_archived", { archived });
  }

  /**
   * The person has seen the session up to what the daemon has now. Never a seq past the log: the row's own
   * `lastSeq`. A daemon that cannot is not asked.
   */
  async markRead(locationId: string, sessionId: string): Promise<void> {
    const connection = this.#runtime.connection(locationId);
    // The list as the daemon has it now: a row read before the news came in would say a seq below it.
    const row = (await this.#watcher.refresh(locationId, connection)).find(
      (s) => s.sessionId === sessionId,
    );
    if (row === undefined) return;
    await connection.client.markRead(sessionId, row.lastSeq);
  }

  async deleteSession(locationId: string, sessionId: string): Promise<void> {
    const connection = this.#runtime.connection(locationId);
    await connection.client.delete(sessionId);
    this.#watcher.deleted(connection, sessionId);
    this.#runtime.track("session_deleted", {});
  }

  // ---- agents ----

  async agents(locationId: string): Promise<AgentInfo[]> {
    return (await this.#runtime.connection(locationId).client.agents()).agents;
  }

  async agentDefaults(locationId: string, agent: string): Promise<Record<string, string>> {
    return this.#runtime.connection(locationId).client.agentDefaults(agent);
  }

  async setAgentDefaults(
    locationId: string,
    agent: string,
    config: Record<string, string>,
  ): Promise<void> {
    await this.#runtime.connection(locationId).client.setAgentDefaults(agent, config);
    this.#runtime.track("agent_defaults_saved", { agent: agentOf(agent) });
  }

  // ---- connectors (docs/protocol.md §14) ----

  async listConnectors(locationId: string): Promise<ConnectorInfo[]> {
    return this.#runtime.connection(locationId).client.listConnectors();
  }

  async addConnector(locationId: string, draft: ConnectorDraft): Promise<ConnectorAnswer> {
    return runAction(
      async () => ({
        connector: await this.#runtime.connection(locationId).client.addConnector(draft),
      }),
      connectorProblemOf,
      (answer) => {
        if (!("connector" in answer)) return;
        const { connector } = answer;
        this.#runtime.track("connector_added", {
          transport: connector.transport.type,
          auth: connector.auth.type,
          secrets: connector.secrets.headers.length + connector.secrets.env.length,
        });
      },
    );
  }

  async updateConnector(
    locationId: string,
    id: string,
    change: ConnectorChange,
  ): Promise<ConnectorAnswer> {
    const onlyEnabled = Object.keys(change).every((key) => key === "enabled");
    return runAction(
      async () => ({
        connector: await this.#runtime
          .connection(locationId)
          .client.updateConnector({ id, ...change }),
      }),
      connectorProblemOf,
      (answer) => {
        if (!("connector" in answer)) return;
        this.#runtime.track("connector_changed", {
          change:
            onlyEnabled && change.enabled !== undefined
              ? change.enabled
                ? "enabled"
                : "disabled"
              : "edited",
        });
      },
    );
  }

  async removeConnector(
    locationId: string,
    id: string,
  ): Promise<{ removed: true } | { problem: ConnectorProblem; message?: string }> {
    let transport: ConnectorInfo["transport"]["type"] | undefined;
    return runAction(
      async () => {
        const client = this.#runtime.connection(locationId).client;
        transport = (await client.listConnectors()).find((c) => c.id === id)?.transport.type;
        await client.removeConnector(id);
        return { removed: true as const };
      },
      connectorProblemOf,
      (answer) => {
        if ("removed" in answer && transport !== undefined)
          this.#runtime.track("connector_removed", { transport });
      },
    );
  }

  /**
   * Signs in to a connector: a loopback callback here, the page in the browser, the code to the daemon (which keeps the
   * PKCE verifier). The code never reaches the page. A sign-in already waiting is stopped first.
   */
  async authorizeConnector(
    locationId: string,
    id: string,
  ): Promise<ConnectorAnswer | { cancelled: true }> {
    this.#signIn?.abort();
    const signIn = new AbortController();
    this.#signIn = signIn;
    try {
      return await runAction<ConnectorAnswer | { cancelled: true }, ConnectorAnswer>(
        async () => {
          const client = this.#runtime.connection(locationId).client;
          const open = this.#runtime.options.openBrowser;
          if (open === undefined) throw new Error("This app cannot open a browser");
          const outcome = await authorizeInBrowser({
            start: (redirectUri) => client.startConnectorAuth(id, redirectUri),
            finish: (params) => client.finishConnectorAuth(params),
            open,
            signal: signIn.signal,
            ...(this.#runtime.options.authTimeoutMs !== undefined
              ? { timeoutMs: this.#runtime.options.authTimeoutMs }
              : {}),
          });
          if (outcome.kind === "cancelled") return { cancelled: true };
          if (outcome.kind === "refused") return { problem: "auth_rejected" };
          return { connector: outcome.value };
        },
        connectorProblemOf,
        (answer) =>
          this.#runtime.track("connector_authorized", {
            result: "cancelled" in answer ? "cancelled" : "problem" in answer ? "failed" : "ok",
          }),
      );
    } finally {
      if (this.#signIn === signIn) this.#signIn = undefined;
    }
  }

  async cancelConnectorAuth(): Promise<void> {
    this.#signIn?.abort();
  }

  async signOutConnector(locationId: string, id: string): Promise<ConnectorAnswer> {
    return runAction(
      async () => ({
        connector: await this.#runtime.connection(locationId).client.clearConnectorAuth(id),
      }),
      connectorProblemOf,
      (answer) => {
        if ("connector" in answer) this.#runtime.track("connector_signed_out", {});
      },
    );
  }

  // ---- plugins (docs/protocol.md §15) ----

  listPlugins(
    locationId: string,
    agentId: string,
  ): Promise<{ sources: PluginSourceInfo[]; plugins: PluginInfo[] }> {
    return this.#runtime.connection(locationId).client.listPlugins(agentId);
  }

  availablePlugins(
    locationId: string,
    query: { agentId: string; sourceId?: string; query?: string; cursor?: string; limit?: number },
  ): Promise<{ plugins: PluginInfo[]; nextCursor?: string | undefined; total: number }> {
    return this.#runtime.connection(locationId).client.availablePlugins(query);
  }

  /** The page asked the person first: a plugin can run code on that machine. */
  async installPlugin(
    locationId: string,
    agentId: string,
    id: string,
  ): Promise<{ plugin: PluginInfo } | PluginFailure> {
    return runAction(
      async () => ({
        plugin: await this.#runtime.connection(locationId).client.installPlugin(agentId, id),
      }),
      pluginProblemOf,
      (answer) =>
        this.#runtime.track("plugin_installed", {
          agent: agentOf(agentId),
          result: pluginResultOf(answer),
          servers: "plugin" in answer ? (answer.plugin.servers?.length ?? 0) : 0,
        }),
    );
  }

  async uninstallPlugin(
    locationId: string,
    agentId: string,
    id: string,
  ): Promise<{ removed: true } | PluginFailure> {
    return runAction(
      async () => {
        await this.#runtime.connection(locationId).client.uninstallPlugin(agentId, id);
        return { removed: true as const };
      },
      pluginProblemOf,
      (answer) =>
        this.#runtime.track("plugin_removed", {
          agent: agentOf(agentId),
          result: pluginResultOf(answer),
        }),
    );
  }

  async updatePlugin(
    locationId: string,
    agentId: string,
    id: string,
  ): Promise<{ plugin: PluginInfo; updated: boolean } | PluginFailure> {
    return runAction(
      () => this.#runtime.connection(locationId).client.updatePlugin(agentId, id),
      pluginProblemOf,
      (answer) =>
        this.#runtime.track("plugin_updated", {
          agent: agentOf(agentId),
          result: pluginResultOf(answer),
          updated: "updated" in answer && answer.updated,
        }),
    );
  }

  async setPluginEnabled(
    locationId: string,
    agentId: string,
    id: string,
    enabled: boolean,
  ): Promise<{ plugin: PluginInfo } | PluginFailure> {
    const on = enabled === true;
    return runAction(
      async () => ({
        plugin: await this.#runtime.connection(locationId).client.setPluginEnabled(agentId, id, on),
      }),
      pluginProblemOf,
      (answer) =>
        this.#runtime.track("plugin_toggled", {
          agent: agentOf(agentId),
          enabled: on,
          result: pluginResultOf(answer),
        }),
    );
  }

  /** The page asked the person first: what a source lists can be installed and run. */
  async addPluginSource(
    locationId: string,
    agentId: string,
    location: string,
  ): Promise<{ source: PluginSourceInfo } | PluginFailure> {
    return runAction(
      async () => ({
        source: await this.#runtime
          .connection(locationId)
          .client.addPluginSource(agentId, location),
      }),
      pluginProblemOf,
      (answer) =>
        this.#runtime.track("plugin_source_added", {
          agent: agentOf(agentId),
          result: pluginResultOf(answer),
          kind: "source" in answer ? answer.source.kind : "other",
        }),
    );
  }

  async removePluginSource(
    locationId: string,
    agentId: string,
    id: string,
  ): Promise<{ removed: true } | PluginFailure> {
    return runAction(
      async () => {
        await this.#runtime.connection(locationId).client.removePluginSource(agentId, id);
        return { removed: true as const };
      },
      pluginProblemOf,
      (answer) =>
        this.#runtime.track("plugin_source_removed", {
          agent: agentOf(agentId),
          result: pluginResultOf(answer),
        }),
    );
  }

  async refreshPluginSources(
    locationId: string,
    agentId: string,
  ): Promise<{ refreshed: true } | PluginFailure> {
    return runAction(
      async () => {
        await this.#runtime.connection(locationId).client.refreshPluginSources(agentId);
        return { refreshed: true as const };
      },
      pluginProblemOf,
      (answer) =>
        this.#runtime.track("plugin_sources_refreshed", {
          agent: agentOf(agentId),
          result: pluginResultOf(answer),
        }),
    );
  }
}
