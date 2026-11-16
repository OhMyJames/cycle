import type {
  Agent,
  AgentCapabilities,
  Agents,
  ContextUsage,
  FileRewind,
  Harness,
  HarnessEvent,
  HarnessSession,
  ModelInfo,
  PromptInput,
  Turn,
  Usage,
} from "@cycle/protocol";

/** A harness that runs nothing: tests say what it reports. */
export class FakeHarness implements Harness {
  readonly name: string;
  capabilities: AgentCapabilities = {
    attachments: ["image"],
    rewindFiles: false,
    commands: false,
    directories: false,
    connector: "edit",
    login: true,
    features: true,
  };
  readonly sent: { sessionId: string; text: string }[] = [];
  readonly steered: string[] = [];
  readonly calls: string[] = [];
  stored: HarnessSession[] = [];
  history: Turn[] = [];
  /** What the next loaded session says it used before. */
  loadedUsage: Usage | null = null;
  failSend: string | null = null;
  execResults: Record<string, { exitCode: number; stdout: string; stderr?: string }> = {};
  private listener: (event: HarnessEvent) => void = () => {};
  private ids = 0;

  constructor(name = "fake") {
    this.name = name;
  }

  emit(event: HarnessEvent): void {
    this.listener(event);
  }

  session(id: string, patch: Partial<HarnessSession> = {}): HarnessSession {
    return {
      id,
      harness: this.name,
      title: null,
      preview: "",
      cwd: "/project",
      model: "model-a",
      effort: null,
      branch: null,
      sandbox: null,
      sandboxCwd: null,
      createdAt: 1,
      updatedAt: 1,
      forkedFrom: null,
      ...patch,
    };
  }

  start = async () => {};
  dispose = async () => {};
  onEvent(listener: (event: HarnessEvent) => void) {
    this.listener = listener;
    return () => {};
  }
  createSession: Harness["createSession"] = async (options) =>
    this.session(`${this.name === "fake" ? "s" : `${this.name}-`}${++this.ids}`, {
      cwd: options.cwd,
    });
  listSessions = async () => this.stored;
  loadSession = async (sessionId: string) => {
    this.calls.push(`load ${sessionId}`);
    return { session: this.session(sessionId), turns: this.history, usage: this.loadedUsage };
  };
  forkSession = async (sessionId: string) => this.session(`${sessionId}-fork`);
  renameSession = async (sessionId: string, title: string) => {
    this.calls.push(`rename ${sessionId} ${title}`);
  };
  archiveSession = async (sessionId: string, archived: boolean) => {
    this.calls.push(`archive ${sessionId} ${archived}`);
  };
  deleteSession = async (sessionId: string) => {
    this.calls.push(`delete ${sessionId}`);
  };
  compactSession = async () => {};
  rewindSession = async (sessionId: string, turnId: string) => {
    this.calls.push(`rewind ${sessionId} ${turnId}`);
    return { from: turnId };
  };
  review: Harness["review"] = async (sessionId, target) => {
    this.calls.push(`review ${sessionId} ${target.kind}`);
    return { turnId: "review-turn" };
  };
  send: Harness["send"] = async (sessionId, input) => {
    if (this.failSend) throw new Error(this.failSend);
    this.sent.push({ sessionId, text: input.text });
    return { turnId: `t${this.sent.length}` };
  };
  steer = async (_sessionId: string, input: PromptInput) => {
    this.steered.push(input.text);
  };
  interrupt = async () => {};
  respondApproval = (approvalId: string) => {
    this.calls.push(`approve ${approvalId}`);
  };
  models: ModelInfo[] = [];
  listModels = async () => this.models;
  listSkills = async () => [];
  listMcpServers = async () => [];
  putMcpServer = async () => {};
  removeMcpServer = async () => {};
  enableMcpServer = async () => {};
  enableMcpTool = async () => {};
  loginMcpServer = async () => ({ url: "" });
  listPlugins = async () => ({ marketplaces: [], errors: [] });
  readPlugin: Harness["readPlugin"] = async () => {
    throw new Error("no plugins");
  };
  installPlugin = async () => {};
  uninstallPlugin = async () => {};
  enablePlugin = async () => {};
  addMarketplace = async () => {};
  removeMarketplace = async () => {};
  readFeatures = async () => ({ subagents: true });
  setFeatures = async () => {};
  readAccount = async () => ({
    harness: this.name,
    kind: null,
    email: null,
    plan: null,
    organization: null,
    provider: null,
    source: null,
    limits: [],
  });
  login = async () => ({ id: "login-1", url: "https://example.test/sign-in" });
  cancelLogin = async () => {};
  logout = async () => {};
  exec: Harness["exec"] = async (argv) => {
    const key = argv.slice(4).join(" ");
    this.calls.push(`git ${key}`);
    const result = this.execResults[key] ?? { exitCode: 0, stdout: "" };
    return { stderr: "", ...result };
  };
  readDirectory = async () => [];
  readFile = async () => new Uint8Array();
  searchFiles = async () => [];
  openTerminal: Harness["openTerminal"] = async () => ({ write() {}, resize() {}, kill() {} });
  rewindFiles?: NonNullable<Agent["rewindFiles"]>;
  listCommands?: NonNullable<Agent["listCommands"]>;
  /** What putting the files back would do, and does. */
  fileRewind: FileRewind = { possible: true, error: null, files: [], insertions: 0, deletions: 0 };
  context: ContextUsage | null = null;

  /**
   * This one agent as the daemon sees its agents, with nothing between them, so what a test emits
   * or asks arrives when it would from the agent itself.
   */
  private get harness(): Harness {
    return this;
  }

  asAgents(): Agents {
    return {
      name: this.name,
      start: (...args) => this.harness.start(...args),
      dispose: (...args) => this.harness.dispose(...args),
      onEvent: (listener) => this.onEvent(listener),
      createSession: (...args) => this.harness.createSession(...args),
      listSessions: (...args) => this.harness.listSessions(...args),
      loadSession: (...args) => this.harness.loadSession(...args),
      forkSession: (...args) => this.harness.forkSession(...args),
      renameSession: (...args) => this.harness.renameSession(...args),
      archiveSession: (...args) => this.harness.archiveSession(...args),
      deleteSession: (...args) => this.harness.deleteSession(...args),
      compactSession: (...args) => this.harness.compactSession(...args),
      rewindSession: (...args) => this.harness.rewindSession(...args),
      send: (...args) => this.harness.send(...args),
      review: (...args) => this.harness.review(...args),
      steer: (...args) => this.harness.steer(...args),
      interrupt: (...args) => this.harness.interrupt(...args),
      respondApproval: (...args) => this.harness.respondApproval(...args),
      listModels: (...args) => this.harness.listModels(...args),
      exec: (...args) => this.harness.exec(...args),
      readDirectory: (...args) => this.harness.readDirectory(...args),
      readFile: (...args) => this.harness.readFile(...args),
      searchFiles: (...args) => this.harness.searchFiles(...args),
      openTerminal: (...args) => this.harness.openTerminal(...args),
      harnesses: () => [{ name: this.name, capabilities: this.capabilities }],
      connector: () => this,
      account: () => this,
      rewindFiles: async (sessionId, turnId, dryRun) => {
        this.calls.push(`rewind files ${sessionId} ${turnId}${dryRun ? " dry" : ""}`);
        return this.fileRewind;
      },
      listCommands: async () => [],
      readContext: async () => this.context,
      capabilitiesOf: async () => this.capabilities,
    };
  }
}

/** Scheduled work held until a test runs it. */
export function manualSchedule() {
  const waiting: (() => void)[] = [];
  return {
    schedule(callback: () => void) {
      waiting.push(callback);
      return () => {
        const index = waiting.indexOf(callback);
        if (index !== -1) waiting.splice(index, 1);
      };
    },
    run() {
      for (const callback of waiting.splice(0)) callback();
    },
    count: () => waiting.length,
  };
}
