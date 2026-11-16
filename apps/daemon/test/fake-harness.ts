import type {
  Harness,
  HarnessEvent,
  HarnessSession,
  ModeInfo,
  ModelInfo,
  PromptInput,
  Turn,
  Usage,
} from "@cycle/protocol";

/** A harness that runs nothing: tests say what it reports. */
export class FakeHarness implements Harness {
  readonly name: string;
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
  /** What it was asked to take in mid-session, as `configure s1 {"mode":"plan"}`. */
  configure: Harness["configure"] = async (sessionId, options) => {
    this.calls.push(`configure ${sessionId} ${JSON.stringify(options)}`);
  };
  models: ModelInfo[] = [];
  listModels = async () => this.models;
  /** The modes Cycle had for every agent, and a plan mode, under this harness's name. */
  modes: Omit<ModeInfo, "harness">[] = (
    [
      ["readOnly", false, false, "readOnly"],
      ["auto", true, false, "auto"],
      ["plan", false, false, null],
      ["fullAccess", false, true, "fullAccess"],
    ] as const
  ).map(([id, isDefault, dangerous, replaces]) => ({
    id,
    name: id,
    description: "",
    dangerous,
    plan: id === "plan",
    isDefault,
    replaces,
  }));
  listModes = (): ModeInfo[] => this.modes.map((mode) => ({ ...mode, harness: this.name }));
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
  readAccount = async () => ({ kind: null, email: null, plan: null, limits: null });
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
