import type {
  Agent,
  ApprovalResponse,
  CreateSessionOptions,
  Harness,
  HarnessEvent,
  HarnessSession,
  ModeInfo,
  ModelInfo,
  PromptInput,
  ReviewTarget,
  TurnOptions,
} from "@cycle/protocol";

/**
 * Several agents as one harness. The first is the main one: it is also the
 * machine, the connector and the account, and what a session with no model
 * chosen starts on. A session stays with the agent it began on, which a model
 * decides when the session is made.
 *
 * An agent besides the main one that cannot start, or list, is left out and
 * said so in the log: the daemon runs on without it.
 */
export class Harnesses implements Harness {
  readonly name: string;
  private readonly main: Harness;
  private agents: Agent[];
  private readonly onLog: (line: string) => void;
  private readonly sessions = new Map<string, Agent>();
  private readonly models = new Map<string, Agent>();
  private readonly approvals = new Map<string, Agent>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  constructor(main: Harness, others: Agent[], onLog: (line: string) => void = () => {}) {
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

  // Sessions

  async createSession(options: CreateSessionOptions): Promise<HarnessSession> {
    const agent = options.model ? await this.ofModel(options.model) : this.main;
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

  async configure(sessionId: string, options: TurnOptions): Promise<void> {
    await (await this.of(sessionId)).configure(sessionId, options);
  }

  /** Every agent's modes. One that was left out offers none. */
  listModes(): ModeInfo[] {
    return this.agents.flatMap((agent) => agent.listModes());
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

  // The main agent's alone

  listSkills: Harness["listSkills"] = (cwd) => this.main.listSkills(cwd);
  listMcpServers: Harness["listMcpServers"] = () => this.main.listMcpServers();
  putMcpServer: Harness["putMcpServer"] = (server) => this.main.putMcpServer(server);
  removeMcpServer: Harness["removeMcpServer"] = (name) => this.main.removeMcpServer(name);
  enableMcpServer: Harness["enableMcpServer"] = (name, enabled) =>
    this.main.enableMcpServer(name, enabled);
  enableMcpTool: Harness["enableMcpTool"] = (name, tool, enabled) =>
    this.main.enableMcpTool(name, tool, enabled);
  loginMcpServer: Harness["loginMcpServer"] = (name) => this.main.loginMcpServer(name);
  listPlugins: Harness["listPlugins"] = () => this.main.listPlugins();
  readPlugin: Harness["readPlugin"] = (marketplace, name) =>
    this.main.readPlugin(marketplace, name);
  installPlugin: Harness["installPlugin"] = (marketplace, name) =>
    this.main.installPlugin(marketplace, name);
  uninstallPlugin: Harness["uninstallPlugin"] = (id) => this.main.uninstallPlugin(id);
  enablePlugin: Harness["enablePlugin"] = (id, enabled) => this.main.enablePlugin(id, enabled);
  addMarketplace: Harness["addMarketplace"] = (source) => this.main.addMarketplace(source);
  removeMarketplace: Harness["removeMarketplace"] = (name) => this.main.removeMarketplace(name);
  readFeatures: Harness["readFeatures"] = () => this.main.readFeatures();
  setFeatures: Harness["setFeatures"] = (features) => this.main.setFeatures(features);
  readAccount: Harness["readAccount"] = () => this.main.readAccount();
  login: Harness["login"] = () => this.main.login();
  cancelLogin: Harness["cancelLogin"] = (id) => this.main.cancelLogin(id);
  logout: Harness["logout"] = () => this.main.logout();
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
