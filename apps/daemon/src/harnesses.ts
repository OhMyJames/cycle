import type {
  Account,
  Agent,
  AgentCapabilities,
  AgentReads,
  Agents,
  ApprovalResponse,
  Connector,
  ContextUsage,
  CreateSessionOptions,
  FileRewind,
  Harness,
  HarnessEvent,
  HarnessInfo,
  HarnessSession,
  ModelInfo,
  PromptInput,
  ReviewTarget,
  SlashCommand,
  TurnOptions,
} from "@cycle/protocol";

/** An agent beside the main one, with what it may read of its own Connector and Account. */
export type OtherAgent = Agent & AgentReads;

/** What an agent cannot do, said so, rather than done by another agent in its place. */
export class NotSupported extends Error {}

function unsupported(agent: string, what: string): never {
  throw new NotSupported(`${what} is not supported for ${agent} in Cycle yet.`);
}

/**
 * Several agents as one. The first is the main one: it is also the machine, and what a session
 * with no model chosen starts on. A session stays with the agent it began on, which a model decides
 * when the session is made. A Connector and an Account are each agent's own, chosen by its name;
 * another agent's may only be read, and what it cannot do is refused, never sent to the main one.
 *
 * An agent besides the main one that cannot start, or list, is left out and
 * said so in the log: the daemon runs on without it.
 */
export class Harnesses implements Agents {
  readonly name: string;
  private readonly main: Harness;
  private agents: OtherAgent[];
  private readonly onLog: (line: string) => void;
  private readonly sessions = new Map<string, Agent>();
  private readonly models = new Map<string, Agent>();
  private readonly approvals = new Map<string, Agent>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  constructor(main: Harness, others: OtherAgent[], onLog: (line: string) => void = () => {}) {
    this.name = main.name;
    this.main = main;
    this.agents = [main, ...others];
    this.onLog = onLog;
    for (const agent of this.agents) {
      agent.onEvent((event) => {
        if (event.type === "approval.requested") this.approvals.set(event.approval.id, agent);
        if (event.type === "approval.resolved") this.approvals.delete(event.approvalId);
        for (const listener of this.listeners) listener(event);
      });
    }
  }

  async start(): Promise<void> {
    await this.main.start();
    const started = await Promise.all(
      this.agents.slice(1).map((agent) =>
        agent.start().then(
          () => agent,
          (error: unknown) => {
            this.onLog(`${agent.name} is left out: ${message(error)}`);
            return null;
          },
        ),
      ),
    );
    this.agents = [this.main, ...started.filter((agent) => agent !== null)];
  }

  async dispose(): Promise<void> {
    await Promise.all(this.agents.map((agent) => agent.dispose()));
  }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  harnesses(): HarnessInfo[] {
    return this.agents.map((agent) => ({ name: agent.name, capabilities: agent.capabilities }));
  }

  // Sessions

  async createSession(options: CreateSessionOptions): Promise<HarnessSession> {
    const agent = options.model ? await this.ofModel(options.model) : this.main;
    if (options.directories?.length && !agent.capabilities.directories) {
      return unsupported(agent.name, "Reaching folders beyond the session's own");
    }
    return this.own(agent, await agent.createSession(options));
  }

  async listSessions(filter: { archived: boolean }): Promise<HarnessSession[]> {
    const lists = await Promise.all(
      this.agents.map((agent) =>
        agent.listSessions(filter).then(
          (sessions) => sessions.map((session) => this.own(agent, session)),
          (error: unknown) => {
            if (agent === this.main) throw error;
            this.onLog(`${agent.name} could not list its sessions: ${message(error)}`);
            return [];
          },
        ),
      ),
    );
    return lists.flat();
  }

  async loadSession(sessionId: string, options: TurnOptions) {
    const agent = await this.of(sessionId);
    return agent.loadSession(sessionId, options);
  }

  async forkSession(sessionId: string, turnId: string | null): Promise<HarnessSession> {
    const agent = await this.of(sessionId);
    return this.own(agent, await agent.forkSession(sessionId, turnId));
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await (await this.of(sessionId)).renameSession(sessionId, title);
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    await (await this.of(sessionId)).archiveSession(sessionId, archived);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await (await this.of(sessionId)).deleteSession(sessionId);
    this.sessions.delete(sessionId);
  }

  async compactSession(sessionId: string): Promise<void> {
    await (await this.of(sessionId)).compactSession(sessionId);
  }

  async rewindSession(sessionId: string, turnId: string): Promise<{ from: string }> {
    return (await this.of(sessionId)).rewindSession(sessionId, turnId);
  }

  async rewindFiles(sessionId: string, turnId: string, dryRun: boolean): Promise<FileRewind> {
    const agent = await this.of(sessionId);
    if (!agent.capabilities.rewindFiles || !agent.rewindFiles) {
      return unsupported(agent.name, "Putting files back");
    }
    return agent.rewindFiles(sessionId, turnId, dryRun);
  }

  async listCommands(target: { sessionId: string } | { harness: string }): Promise<SlashCommand[]> {
    const agent =
      "sessionId" in target ? await this.of(target.sessionId) : this.named(target.harness);
    if (!agent.capabilities.commands || !agent.listCommands) {
      return unsupported(agent.name, "Listing commands");
    }
    return agent.listCommands("sessionId" in target ? target.sessionId : null);
  }

  async readContext(sessionId: string): Promise<ContextUsage | null> {
    const agent = await this.of(sessionId);
    return agent.readContext ? agent.readContext(sessionId) : null;
  }

  async capabilitiesOf(sessionId: string): Promise<AgentCapabilities> {
    return (await this.of(sessionId)).capabilities;
  }

  async send(sessionId: string, input: PromptInput, options: TurnOptions) {
    return (await this.of(sessionId)).send(sessionId, input, options);
  }

  async review(sessionId: string, target: ReviewTarget, options: TurnOptions) {
    return (await this.of(sessionId)).review(sessionId, target, options);
  }

  async steer(sessionId: string, input: PromptInput): Promise<void> {
    await (await this.of(sessionId)).steer(sessionId, input);
  }

  async interrupt(sessionId: string): Promise<void> {
    await (await this.of(sessionId)).interrupt(sessionId);
  }

  respondApproval(approvalId: string, response: ApprovalResponse): void {
    (this.approvals.get(approvalId) ?? this.main).respondApproval(approvalId, response);
  }

  async listModels(): Promise<ModelInfo[]> {
    const lists = await Promise.all(
      this.agents.map((agent) =>
        agent.listModels().then(
          // Only the main agent's choice is what a session with no model chosen runs on.
          (models) =>
            agent === this.main ? models : models.map((model) => ({ ...model, isDefault: false })),
          (error: unknown) => {
            if (agent === this.main) throw error;
            this.onLog(`${agent.name} could not list its models: ${message(error)}`);
            return [];
          },
        ),
      ),
    );
    this.models.clear();
    this.agents.forEach((agent, index) => {
      for (const model of lists[index] ?? []) {
        if (!this.models.has(model.id)) this.models.set(model.id, agent);
      }
    });
    return lists.flat();
  }

  // Each agent's own

  connector(harness?: string): Connector {
    const agent = this.named(harness);
    if (agent === this.main) return this.main;
    const no = (what: string) => async () => unsupported(agent.name, what);
    const change = no("Changing the connector");
    return {
      listSkills: agent.listSkills?.bind(agent) ?? no("Listing skills"),
      listMcpServers: agent.listMcpServers?.bind(agent) ?? no("Listing MCP servers"),
      putMcpServer: change,
      removeMcpServer: change,
      enableMcpServer: change,
      enableMcpTool: change,
      loginMcpServer: no("Signing in to an MCP server"),
      listPlugins: no("Listing plugins"),
      readPlugin: no("Reading a plugin"),
      installPlugin: change,
      uninstallPlugin: change,
      enablePlugin: change,
      addMarketplace: change,
      removeMarketplace: change,
      readFeatures: no("Reading features"),
      setFeatures: change,
    };
  }

  account(harness?: string): Account {
    const agent = this.named(harness);
    if (agent === this.main) return this.main;
    const signIn = async () => unsupported(agent.name, "Signing in");
    return {
      readAccount:
        agent.readAccount?.bind(agent) ??
        (async () => unsupported(agent.name, "Reading the account")),
      login: signIn,
      cancelLogin: signIn,
      logout: signIn,
    };
  }

  // The main agent's alone

  exec: Harness["exec"] = (argv, options) => this.main.exec(argv, options);
  readDirectory: Harness["readDirectory"] = (path) => this.main.readDirectory(path);
  readFile: Harness["readFile"] = (path) => this.main.readFile(path);
  searchFiles: Harness["searchFiles"] = (root, query) => this.main.searchFiles(root, query);
  openTerminal: Harness["openTerminal"] = (options) => this.main.openTerminal(options);

  // Inside

  private own(agent: Agent, session: HarnessSession): HarnessSession {
    this.sessions.set(session.id, agent);
    return session;
  }

  /** The agent of this name, the main one when none is given. */
  private named(harness: string | undefined): OtherAgent {
    if (harness === undefined) return this.main;
    const found = this.agents.find((agent) => agent.name === harness);
    if (!found) throw new Error(`No agent named ${harness} is running.`);
    return found;
  }

  /** The agent that keeps a session. One nobody has listed yet is looked for once. */
  private async of(sessionId: string): Promise<Agent> {
    const known = this.sessions.get(sessionId);
    if (known) return known;
    if (this.agents.length > 1) {
      await this.listSessions({ archived: false });
      if (!this.sessions.has(sessionId)) await this.listSessions({ archived: true });
    }
    const found = this.sessions.get(sessionId) ?? this.main;
    this.sessions.set(sessionId, found);
    return found;
  }

  private async ofModel(model: string): Promise<Agent> {
    if (!this.models.has(model)) await this.listModels();
    return this.models.get(model) ?? this.main;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
