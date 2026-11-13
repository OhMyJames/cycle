import type {
  AccountInfo,
  AccountLogin,
  Approval,
  ApprovalResponse,
  CreateSessionOptions,
  DirectoryEntry,
  ExecOptions,
  ExecResult,
  FileMatch,
  Harness,
  HarnessEvent,
  HarnessSession,
  McpServerInfo,
  McpServerInput,
  ModelInfo,
  PluginCatalog,
  PluginDetail,
  PromptInput,
  RateLimitWindow,
  SkillInfo,
  TerminalHandle,
  TerminalOptions,
  Turn,
  TurnOptions,
  Usage,
} from "@cycle/protocol";
import { type CodexConfig, CodexProcess } from "./process.ts";
import type { JsonRpcPeer, RpcId } from "./rpc.ts";
import {
  checkServerName,
  mcpServerEdits,
  modePolicy,
  toInput,
  toCatalog,
  toItem,
  toMcpServers,
  toModel,
  toPluginDetail,
  toSession,
  toSkill,
  toTurn,
  toUsage,
} from "./translate.ts";
import type {
  WireItem,
  WireConfigEdit,
  WireMcpConfig,
  WireMcpServer,
  WirePluginDetail,
  WirePluginList,
  WireModel,
  WireRateLimitWindow,
  WireSkill,
  WireThread,
  WireThreadResponse,
  WireTokenUsage,
  WireTurn,
  WireUnknownItem,
} from "./wire.ts";

/**
 * A model provider of the owner's that codex reaches at an address on this
 * machine. Codex keeps a conversation with the provider it began on and runs
 * one provider per process, so its sessions get a process of their own.
 */
export interface ExtraProvider {
  /** What codex knows the provider by, in its config and on each thread. */
  id: string;
  name: string;
  /** Where it answers the Responses API. */
  baseUrl: string;
  /** The bearer it expects. It reaches codex in the environment, never in its arguments. */
  token: string;
  /** The models it serves now, and how much each can read. */
  models(): { info: ModelInfo; contextWindow: number }[];
}

export interface CodexHarnessOptions {
  /** Path to the `codex` executable. Defaults to the bundled `@openai/codex`. */
  bin?: string;
  /** `-c key=value` config overrides passed to `codex app-server`. */
  config?: CodexConfig;
  env?: Record<string, string | undefined>;
  /** Receives the app-server's stderr (its log output), line by line. */
  onLog?: (line: string) => void;
  provider?: ExtraProvider;
  /** An MCP server of the client's own that every session reaches, behind a key. */
  tools?: OwnTools;
}

/** The client's own MCP server: where it is, and the key codex sends it. */
export interface OwnTools {
  name: string;
  url: string;
  /** The environment variable codex reads the key from. */
  keyEnv: string;
  key: string;
}

const PROVIDER_TOKEN_ENV = "CYCLE_PROVIDER_TOKEN";

interface PendingApproval {
  rpc: JsonRpcPeer;
  rpcId: RpcId;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

interface OpenTerminal {
  onData(bytes: Uint8Array): void;
  onExit(exitCode: number | null): void;
}

type Json = Record<string, unknown>;

const EXEC_OUTPUT_CAP = 8 * 1024 * 1024;
const LIST_PAGE = 100;
const LIST_LIMIT = 2000;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toWindow(raw: WireRateLimitWindow | null | undefined): RateLimitWindow | null {
  if (!raw) return null;
  return {
    usedPercent: raw.usedPercent,
    windowMinutes: raw.windowDurationMins,
    resetsAt: raw.resetsAt === null ? null : raw.resetsAt * 1000,
  };
}

/**
 * Drives `codex app-server` over stdio. One process hosts many threads; each
 * Cycle session maps 1:1 onto a codex thread. Sessions on a model of the
 * owner's own provider live in a second process, started when first needed.
 * Should a process die it is started again on the next request, and each
 * session is brought back into it the next time it is used.
 */
export class CodexHarness implements Harness {
  readonly name = "codex";
  private readonly provider: ExtraProvider | null;
  /** Codex's own models, and the machine: files, commands, terminals, the account. */
  private readonly main: CodexProcess;
  /** The owner's provider's sessions. Null when there is no such provider. */
  private readonly extra: CodexProcess | null;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  /** Which sessions are the extra process's, as far as is known. */
  private readonly ofExtra = new Map<string, boolean>();
  private readonly activeTurns = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** The client's own MCP server, which is not the owner's to change. */
  private readonly ownServer: string | null;
  private readonly terminals = new Map<string, OpenTerminal>();

  constructor(options: CodexHarnessOptions = {}) {
    const provider = options.provider ?? null;
    this.provider = provider;
    const spec = { bin: options.bin, onLog: options.onLog };
    const tools = options.tools;
    this.ownServer = tools?.name ?? null;
    // Codex hands its environment to the commands the agent runs. Not a key of ours.
    const secrets = [...(tools ? [tools.keyEnv] : []), ...(provider ? [PROVIDER_TOKEN_ENV] : [])];
    const shared: CodexConfig = {
      ...options.config,
      ...(tools
        ? {
            [`mcp_servers.${tools.name}.url`]: tools.url,
            [`mcp_servers.${tools.name}.bearer_token_env_var`]: tools.keyEnv,
          }
        : {}),
      ...(secrets.length ? { "shell_environment_policy.exclude": secrets } : {}),
    };
    const env = { ...options.env, ...(tools ? { [tools.keyEnv]: tools.key } : {}) };
    this.main = new CodexProcess(
      { ...spec, config: shared, env },
      {
        onNotification: (method, params) => this.handleNotification(method, params, true),
        onRequest: (rpc, id, method, params) => this.handleServerRequest(rpc, id, method, params),
        onExit: (error) => this.handleExit(false, error),
      },
    );
    this.extra = provider
      ? new CodexProcess(
          {
            ...spec,
            config: {
              ...shared,
              model_provider: provider.id,
              [`model_providers.${provider.id}.name`]: provider.name,
              [`model_providers.${provider.id}.base_url`]: provider.baseUrl,
              [`model_providers.${provider.id}.wire_api`]: "responses",
              [`model_providers.${provider.id}.env_key`]: PROVIDER_TOKEN_ENV,
            },
            env: { ...env, [PROVIDER_TOKEN_ENV]: provider.token },
          },
          {
            onNotification: (method, params) => this.handleNotification(method, params, false),
            onRequest: (rpc, id, method, params) =>
              this.handleServerRequest(rpc, id, method, params),
            onExit: (error) => this.handleExit(true, error),
          },
        )
      : null;
  }

  async start(): Promise<void> {
    await this.main.peer();
  }

  async dispose(): Promise<void> {
    await Promise.all([this.main.dispose(), this.extra?.dispose()]);
  }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Sessions

  async createSession(options: CreateSessionOptions): Promise<HarnessSession> {
    const policy = options.mode ? modePolicy(options.mode) : null;
    const served = this.served(options.model);
    const proc = served && this.extra ? this.extra : this.main;
    const config = {
      ...(options.effort ? { model_reasoning_effort: options.effort } : {}),
      ...(served ? { model_context_window: served.contextWindow } : {}),
    };
    const response = await proc.request<WireThreadResponse>("thread/start", {
      cwd: options.cwd,
      model: options.model ?? null,
      approvalPolicy: policy?.approvalPolicy ?? null,
      sandbox: policy?.sandbox ?? null,
      ...(Object.keys(config).length ? { config } : {}),
    });
    this.adopt(proc, response.thread);
    return toSession(response.thread, {
      model: response.model,
      effort: response.reasoningEffort,
    });
  }

  async listSessions(filter: { archived: boolean }): Promise<HarnessSession[]> {
    // Codex lists the threads of the provider it runs on, or of the ones it is asked for.
    const lists = await Promise.all([
      this.listThreads(filter.archived, null),
      this.provider ? this.listThreads(filter.archived, this.provider.id) : [],
    ]);
    return lists.flat().toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  private async listThreads(archived: boolean, provider: string | null): Promise<HarnessSession[]> {
    const sessions: HarnessSession[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: WireThread[]; nextCursor: string | null } = await this.main.request(
        "thread/list",
        {
          cursor,
          limit: LIST_PAGE,
          archived,
          sortKey: "updated_at",
          sourceKinds: ["cli", "vscode", "appServer"],
          ...(provider ? { modelProviders: [provider] } : {}),
        },
      );
      for (const thread of page.data) {
        this.ofExtra.set(thread.id, provider !== null);
        sessions.push(toSession(thread));
      }
      cursor = page.nextCursor;
    } while (cursor && sessions.length < LIST_LIMIT);
    return sessions;
  }

  async loadSession(
    sessionId: string,
    options: TurnOptions,
  ): Promise<{ session: HarnessSession; turns: Turn[]; usage: Usage | null }> {
    const response = await this.resume(await this.processOf(sessionId), sessionId, options);
    return {
      session: toSession(response.thread, {
        model: response.model,
        effort: response.reasoningEffort,
      }),
      turns: response.thread.turns.map(toTurn),
      usage: null,
    };
  }

  async forkSession(sessionId: string, turnId: string | null): Promise<HarnessSession> {
    const proc = await this.processOf(sessionId);
    const response = await proc.request<WireThreadResponse>("thread/fork", {
      threadId: sessionId,
      ...(turnId ? { lastTurnId: turnId } : {}),
    });
    this.adopt(proc, response.thread);
    return toSession(response.thread, {
      model: response.model,
      effort: response.reasoningEffort,
    });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const proc = await this.processOf(sessionId);
    await proc.request("thread/name/set", { threadId: sessionId, name: title });
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    const proc = await this.processOf(sessionId);
    await proc.request(archived ? "thread/archive" : "thread/unarchive", { threadId: sessionId });
    if (archived) proc.loaded.delete(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const proc = await this.processOf(sessionId);
    await proc.request("thread/delete", { threadId: sessionId });
    proc.loaded.delete(sessionId);
    this.ofExtra.delete(sessionId);
  }

  async compactSession(sessionId: string): Promise<void> {
    const proc = await this.ensureLoaded(sessionId, {});
    await proc.request("thread/compact/start", { threadId: sessionId });
  }

  // Turns

  async send(
    sessionId: string,
    input: PromptInput,
    options: TurnOptions,
  ): Promise<{ turnId: string }> {
    const proc = await this.ensureLoaded(sessionId, options);
    if (proc === this.main && this.served(options.model)) {
      throw new Error(
        "This conversation began on one of Codex's own models, and codex keeps it there. " +
          "Start a new session to use a model of your own provider.",
      );
    }
    const policy = options.mode ? modePolicy(options.mode) : null;
    const response = await proc.request<{ turn: WireTurn }>("turn/start", {
      threadId: sessionId,
      input: toInput(input),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(policy
        ? { approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy }
        : {}),
    });
    this.activeTurns.set(sessionId, response.turn.id);
    return { turnId: response.turn.id };
  }

  async steer(sessionId: string, input: PromptInput): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) throw new Error("No turn is running to steer.");
    const proc = await this.processOf(sessionId);
    await proc.request("turn/steer", {
      threadId: sessionId,
      input: toInput(input),
      expectedTurnId: turnId,
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return;
    const proc = await this.processOf(sessionId);
    await proc.request("turn/interrupt", { threadId: sessionId, turnId });
  }

  respondApproval(approvalId: string, response: ApprovalResponse): void {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error(`unknown approval: ${approvalId}`);
    this.approvals.delete(approvalId);
    pending.rpc.respond(pending.rpcId, this.approvalResult(pending, response));
    this.emit({ type: "approval.resolved", sessionId: pending.sessionId, approvalId });
  }

  // What the agent offers

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: WireModel[]; nextCursor: string | null } = await this.request(
        "model/list",
        { cursor, limit: LIST_PAGE },
      );
      for (const model of page.data) if (!model.hidden) models.push(toModel(model));
      cursor = page.nextCursor;
    } while (cursor);
    for (const { info } of this.provider?.models() ?? []) models.push(info);
    return models;
  }

  async listSkills(cwd: string): Promise<SkillInfo[]> {
    const response = await this.request<{ data: { skills: WireSkill[] }[] }>("skills/list", {
      cwds: [cwd],
    });
    return response.data.flatMap((entry) => entry.skills.map(toSkill));
  }

  // The connector

  private async mcpConfig(): Promise<Record<string, WireMcpConfig | undefined>> {
    const { config } = await this.request<{
      config: { mcp_servers?: Record<string, WireMcpConfig> | null };
    }>("config/read", {});
    return config.mcp_servers ?? {};
  }

  async listMcpServers(): Promise<McpServerInfo[]> {
    const [configured, statuses] = await Promise.all([
      this.mcpConfig(),
      this.request<{ data: WireMcpServer[] }>("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
      }),
    ]);
    // The client's own server is part of it, not one of the owner's connections.
    return toMcpServers(configured, statuses.data).filter(
      (server) => server.name !== this.ownServer,
    );
  }

  /** Writes the owner's configuration and has codex's sessions take it up. */
  private async writeConfig(edits: WireConfigEdit[]): Promise<void> {
    await this.request("config/batchWrite", { edits, reloadUserConfig: true });
    await this.request("config/mcpServer/reload", undefined);
  }

  async putMcpServer(server: McpServerInput): Promise<void> {
    const configured = await this.mcpConfig();
    await this.writeConfig(mcpServerEdits(server, configured[server.name]));
  }

  async removeMcpServer(name: string): Promise<void> {
    checkServerName(name);
    await this.writeConfig([
      { keyPath: `mcp_servers.${name}`, value: null, mergeStrategy: "replace" },
    ]);
  }

  async enableMcpServer(name: string, enabled: boolean): Promise<void> {
    checkServerName(name);
    const configured = await this.mcpConfig();
    if (!configured[name]) throw new Error(`No MCP server named ${name}.`);
    await this.writeConfig([
      { keyPath: `mcp_servers.${name}.enabled`, value: enabled, mergeStrategy: "replace" },
    ]);
  }

  async loginMcpServer(name: string): Promise<{ url: string }> {
    checkServerName(name);
    const response = await this.request<{ authorizationUrl: string }>("mcpServer/oauth/login", {
      name,
    });
    return { url: response.authorizationUrl };
  }

  private pluginList(): Promise<WirePluginList> {
    return this.request<WirePluginList>("plugin/list", {});
  }

  async listPlugins(): Promise<PluginCatalog> {
    return toCatalog(await this.pluginList());
  }

  /** Codex names a plugin's marketplace by the file it was read from. */
  private async marketplacePath(marketplace: string): Promise<string> {
    const list = await this.pluginList();
    const path = list.marketplaces.find((entry) => entry.name === marketplace)?.path;
    if (!path) throw new Error(`No marketplace named ${marketplace}.`);
    return path;
  }

  async readPlugin(marketplace: string, name: string): Promise<PluginDetail> {
    const marketplacePath = await this.marketplacePath(marketplace);
    const { plugin } = await this.request<{ plugin: WirePluginDetail }>("plugin/read", {
      marketplacePath,
      pluginName: name,
    });
    return toPluginDetail(plugin);
  }

  async installPlugin(marketplace: string, name: string): Promise<void> {
    const marketplacePath = await this.marketplacePath(marketplace);
    await this.request("plugin/install", { marketplacePath, pluginName: name });
  }

  async uninstallPlugin(id: string): Promise<void> {
    await this.request("plugin/uninstall", { pluginId: id });
  }

  async enablePlugin(id: string, enabled: boolean): Promise<void> {
    if (!/^[\w.-]+@[\w.-]+$/.test(id)) throw new Error(`${id} is not a plugin.`);
    await this.writeConfig([
      { keyPath: `plugins."${id}".enabled`, value: enabled, mergeStrategy: "replace" },
    ]);
  }

  async addMarketplace(source: string): Promise<void> {
    await this.request("marketplace/add", { source: source.trim() });
  }

  async removeMarketplace(name: string): Promise<void> {
    await this.request("marketplace/remove", { marketplaceName: name });
  }

  async readAccount(): Promise<AccountInfo> {
    const { account } = await this.request<{ account: Json | null }>("account/read", {});
    if (!account) return { kind: null, email: null, plan: null, limits: null };
    const kind =
      account["type"] === "apiKey" || account["type"] === "chatgpt" ? account["type"] : "other";
    let limits: AccountInfo["limits"] = null;
    if (kind === "chatgpt") {
      try {
        const { rateLimits } = await this.request<{
          rateLimits: {
            primary: WireRateLimitWindow | null;
            secondary: WireRateLimitWindow | null;
          };
        }>("account/rateLimits/read", {});
        limits = {
          primary: toWindow(rateLimits.primary),
          secondary: toWindow(rateLimits.secondary),
        };
      } catch {
        // Limits are a courtesy: an account without them still works.
      }
    }
    return { kind, email: text(account["email"]), plan: text(account["planType"]), limits };
  }

  async login(): Promise<AccountLogin> {
    const response = await this.request<{ loginId: string; authUrl: string }>(
      "account/login/start",
      { type: "chatgpt" },
    );
    return { id: response.loginId, url: response.authUrl };
  }

  async cancelLogin(id: string): Promise<void> {
    await this.request("account/login/cancel", { loginId: id });
  }

  async logout(): Promise<void> {
    await this.request("account/logout", {});
  }

  // The agent's machine

  async exec(argv: string[], options: ExecOptions): Promise<ExecResult> {
    return this.request<ExecResult>("command/exec", {
      command: argv,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 30_000,
      outputBytesCap: EXEC_OUTPUT_CAP,
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  }

  async readDirectory(path: string): Promise<DirectoryEntry[]> {
    const response = await this.request<{
      entries: { fileName: string; isDirectory: boolean }[];
    }>("fs/readDirectory", { path });
    return response.entries.map((entry) => ({
      name: entry.fileName,
      directory: entry.isDirectory,
    }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this.request<{ dataBase64: string }>("fs/readFile", { path });
    return new Uint8Array(Buffer.from(response.dataBase64, "base64"));
  }

  async searchFiles(root: string, query: string): Promise<FileMatch[]> {
    const response = await this.request<{
      files: { path: string; match_type: string }[];
    }>("fuzzyFileSearch", { query, roots: [root], cancellationToken: `cycle:${root}` });
    return response.files.map((file) => ({
      path: file.path,
      directory: file.match_type === "directory",
    }));
  }

  async openTerminal(options: TerminalOptions): Promise<TerminalHandle> {
    const rpc = await this.main.peer();
    const processId = options.id;
    const finish = (exitCode: number | null) => {
      if (this.terminals.delete(processId)) options.onExit(exitCode);
    };
    this.terminals.set(processId, { onData: options.onData, onExit: options.onExit });
    rpc
      .request<ExecResult>("command/exec", {
        command: options.argv,
        processId,
        tty: true,
        streamStdin: true,
        streamStdoutStderr: true,
        disableTimeout: true,
        disableOutputCap: true,
        cwd: options.cwd,
        env: options.env ?? null,
        size: { rows: options.rows, cols: options.cols },
        sandboxPolicy: { type: "dangerFullAccess" },
      })
      .then(
        (result) => finish(result.exitCode),
        () => finish(null),
      );
    const quietly = (method: string, params: Json) => {
      // A terminal that already exited refuses these, which is the answer wanted.
      rpc.request(method, params).catch(() => {});
    };
    return {
      write: (bytes) =>
        quietly("command/exec/write", {
          processId,
          deltaBase64: Buffer.from(bytes).toString("base64"),
        }),
      resize: (cols, rows) => quietly("command/exec/resize", { processId, size: { rows, cols } }),
      kill: () => quietly("command/exec/terminate", { processId }),
    };
  }

  // The processes

  /** The extra provider's model of this id, when it serves one. */
  private served(model: string | undefined): { contextWindow: number } | null {
    if (!model || !this.provider) return null;
    return this.provider.models().find(({ info }) => info.id === model) ?? null;
  }

  private adopt(proc: CodexProcess, thread: WireThread): void {
    proc.loaded.add(thread.id);
    this.ofExtra.set(thread.id, proc === this.extra);
  }

  /** The process a session lives in: the one that runs the provider it began on. */
  private async processOf(sessionId: string): Promise<CodexProcess> {
    if (!this.extra || !this.provider) return this.main;
    let extra = this.ofExtra.get(sessionId);
    if (extra === undefined) {
      const { thread } = await this.main.request<{ thread: WireThread }>("thread/read", {
        threadId: sessionId,
        includeTurns: false,
      });
      extra = thread.modelProvider === this.provider.id;
      this.ofExtra.set(sessionId, extra);
    }
    return extra ? this.extra : this.main;
  }

  private handleExit(extra: boolean, error: Error | undefined): void {
    const message = `codex app-server exited${error ? `: ${error.message}` : ""}`;
    const mine = (sessionId: string) => (this.ofExtra.get(sessionId) ?? false) === extra;
    for (const [approvalId, pending] of this.approvals) {
      if (mine(pending.sessionId)) this.approvals.delete(approvalId);
    }
    // The other process carries on, so only this one's turns are told they ended.
    if (this.extra) {
      for (const [sessionId, turnId] of this.activeTurns) {
        if (!mine(sessionId)) continue;
        this.activeTurns.delete(sessionId);
        this.emit({
          type: "turn.completed",
          sessionId,
          turnId,
          status: "failed",
          error: `${message}. It starts again with your next message.`,
          durationMs: null,
        });
      }
    }
    if (extra) return;
    for (const [id, terminal] of this.terminals) {
      this.terminals.delete(id);
      terminal.onData(new TextEncoder().encode("\r\n[the agent process exited]\r\n"));
      terminal.onExit(null);
    }
    // With one process, its end is every session's, and the daemon is told so in one event.
    if (this.extra) return;
    this.activeTurns.clear();
    this.emit({ type: "harness.exited", message });
  }

  /** Asks the main process, which answers for everything that is not one session's. */
  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.main.request<T>(method, params);
  }

  private async resume(
    proc: CodexProcess,
    sessionId: string,
    options: TurnOptions,
  ): Promise<WireThreadResponse> {
    const policy = options.mode ? modePolicy(options.mode) : null;
    const served = proc === this.extra ? this.served(options.model) : null;
    const response = await proc.request<WireThreadResponse>("thread/resume", {
      threadId: sessionId,
      model: options.model ?? null,
      approvalPolicy: policy?.approvalPolicy ?? null,
      sandbox: policy?.sandbox ?? null,
      // shortcut: the window is the one of the model a session is loaded with; upgrade when
      // codex takes a window with each turn, or reads the provider's models from a catalog.
      ...(served ? { config: { model_context_window: served.contextWindow } } : {}),
    });
    proc.loaded.add(sessionId);
    return response;
  }

  private async ensureLoaded(sessionId: string, options: TurnOptions): Promise<CodexProcess> {
    const proc = await this.processOf(sessionId);
    await proc.peer();
    if (!proc.loaded.has(sessionId)) await this.resume(proc, sessionId, options);
    return proc;
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // What codex tells us

  private handleNotification(method: string, params: Json, main: boolean): void {
    const sessionId = text(params["threadId"]) ?? "";
    const turnId = text(params["turnId"]) ?? "";
    switch (method) {
      case "turn/started": {
        const turn = params["turn"] as WireTurn;
        this.activeTurns.set(sessionId, turn.id);
        this.emit({
          type: "turn.started",
          sessionId,
          turnId: turn.id,
          startedAt: turn.startedAt === null ? null : turn.startedAt * 1000,
        });
        break;
      }
      case "turn/completed": {
        const turn = params["turn"] as WireTurn;
        this.activeTurns.delete(sessionId);
        for (const [approvalId, pending] of this.approvals) {
          if (pending.sessionId === sessionId) this.approvals.delete(approvalId);
        }
        this.emit({
          type: "turn.completed",
          sessionId,
          turnId: turn.id,
          status: turn.status === "inProgress" ? "completed" : turn.status,
          error: turn.error?.message ?? null,
          durationMs: turn.durationMs,
        });
        break;
      }
      case "item/started":
      case "item/completed":
        this.emit({
          type: method === "item/started" ? "item.started" : "item.completed",
          sessionId,
          turnId,
          item: toItem(params["item"] as WireItem | WireUnknownItem),
        });
        break;
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/commandExecution/outputDelta":
        this.emit({
          type: "item.delta",
          sessionId,
          turnId,
          itemId: text(params["itemId"]) ?? "",
          delta: text(params["delta"]) ?? "",
        });
        break;
      case "item/reasoning/summaryPartAdded":
        if (typeof params["summaryIndex"] === "number" && params["summaryIndex"] > 0) {
          this.emit({
            type: "item.delta",
            sessionId,
            turnId,
            itemId: text(params["itemId"]) ?? "",
            delta: "\n\n",
          });
        }
        break;
      case "turn/plan/updated":
        this.emit({
          type: "plan.updated",
          sessionId,
          plan: {
            explanation: text(params["explanation"]),
            steps: params["plan"] as {
              step: string;
              status: "pending" | "inProgress" | "completed";
            }[],
          },
        });
        break;
      case "turn/diff/updated":
        this.emit({ type: "diff.updated", sessionId, turnId, diff: text(params["diff"]) ?? "" });
        break;
      case "thread/tokenUsage/updated":
        this.emit({
          type: "usage.updated",
          sessionId,
          usage: toUsage(params["tokenUsage"] as WireTokenUsage),
        });
        break;
      case "mcpServer/oauthLogin/completed":
      case "mcpServer/startupStatus/updated":
        this.emit({ type: "mcp.changed" });
        break;
      case "thread/name/updated":
        this.emit({
          type: "session.changed",
          sessionId,
          patch: { title: text(params["threadName"])?.trim() || null },
        });
        break;
      case "serverRequest/resolved": {
        const approvalId = `${sessionId}:${String(params["requestId"])}`;
        if (this.approvals.delete(approvalId)) {
          this.emit({ type: "approval.resolved", sessionId, approvalId });
        }
        break;
      }
      case "command/exec/outputDelta": {
        const terminal = this.terminals.get(text(params["processId"]) ?? "");
        const data = text(params["deltaBase64"]);
        if (terminal && data) terminal.onData(new Uint8Array(Buffer.from(data, "base64")));
        break;
      }
      case "error": {
        const error = params["error"] as { message?: string } | undefined;
        if (params["willRetry"] && sessionId && error?.message) {
          this.emit({ type: "notice", sessionId, level: "warning", message: error.message });
        }
        break;
      }
      case "warning":
        // Codex knows nothing of a provider's models, and says so every session. It is expected:
        // the window it needs comes with the session, and the rest of its fallback serves.
        if (!main && /^Model metadata for .* not found/.test(text(params["message"]) ?? "")) break;
        if (sessionId) {
          this.emit({
            type: "notice",
            sessionId,
            level: "warning",
            message: text(params["message"]) ?? "",
          });
        }
        break;
      case "account/login/completed":
        if (main) {
          this.emit({
            type: "account.changed",
            error: params["success"]
              ? null
              : (text(params["error"]) ?? "The sign-in did not finish."),
          });
        }
        break;
      case "account/updated":
        if (main) this.emit({ type: "account.changed", error: null });
        break;
      case "model/rerouted":
        this.emit({
          type: "notice",
          sessionId,
          level: "info",
          message: `This turn ran on ${String(params["toModel"])} instead of ${String(params["fromModel"])}.`,
        });
        break;
      default:
      // Everything else is state this harness does not show.
    }
  }

  private handleServerRequest(rpc: JsonRpcPeer, id: RpcId, method: string, params: Json): void {
    const sessionId = text(params["threadId"]);
    const approval = sessionId ? this.toApproval(`${sessionId}:${id}`, method, params) : null;
    if (!sessionId || !approval) {
      if (method === "mcpServer/elicitation/request") {
        // No form for these yet: declining lets the tool carry on without one.
        rpc.respond(id, { action: "decline", content: null, _meta: null });
      } else {
        rpc.respondError(id, -32601, `cycle does not handle ${method}`);
      }
      return;
    }
    this.approvals.set(approval.id, { rpc, rpcId: id, sessionId, method, params });
    this.emit({
      type: "approval.requested",
      sessionId,
      turnId: text(params["turnId"]),
      approval,
    });
  }

  private toApproval(id: string, method: string, params: Json): Approval | null {
    const itemId = text(params["itemId"]) ?? "";
    const reason = text(params["reason"]);
    switch (method) {
      case "item/commandExecution/requestApproval":
        return {
          id,
          kind: "command",
          itemId,
          command: text(params["command"]),
          cwd: text(params["cwd"]),
          reason,
        };
      case "item/fileChange/requestApproval":
        return { id, kind: "fileChange", itemId, reason };
      case "item/permissions/requestApproval":
        return {
          id,
          kind: "permissions",
          itemId,
          reason,
          summary: JSON.stringify(params["permissions"] ?? {}, null, 2),
        };
      case "item/tool/requestUserInput": {
        const questions = (params["questions"] ?? []) as {
          id: string;
          header: string;
          question: string;
          isOther: boolean;
          isSecret: boolean;
          options: { label: string; description: string }[] | null;
        }[];
        return {
          id,
          kind: "question",
          itemId,
          questions: questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options ?? [],
            allowOther: question.isOther || !question.options?.length,
            secret: question.isSecret,
          })),
        };
      }
      default:
        return null;
    }
  }

  private approvalResult(pending: PendingApproval, response: ApprovalResponse): unknown {
    if (pending.method === "item/tool/requestUserInput") {
      const answers = "answers" in response ? response.answers : {};
      return {
        answers: Object.fromEntries(
          Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
        ),
      };
    }
    const decision = "decision" in response ? response.decision : "cancel";
    if (pending.method === "item/permissions/requestApproval") {
      const granted = decision === "accept" || decision === "acceptForSession";
      return {
        permissions: granted ? (pending.params["permissions"] ?? {}) : {},
        scope: decision === "acceptForSession" ? "session" : "turn",
      };
    }
    return { decision };
  }
}
