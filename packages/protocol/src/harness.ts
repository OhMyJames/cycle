import type {
  AgentFeatures,
  AccountInfo,
  AccountLogin,
  ApprovalResponse,
  McpServerInfo,
  McpServerInput,
  ModelInfo,
  PluginCatalog,
  ReviewTarget,
  PluginDetail,
  SessionEvent,
  SessionMode,
  SkillInfo,
  Turn,
  Usage,
} from "./model.ts";

/** What a harness knows of a session. The daemon adds what only it keeps. */
export interface HarnessSession {
  id: string;
  title: string | null;
  preview: string;
  cwd: string;
  model: string;
  effort: string | null;
  branch: string | null;
  createdAt: number;
  updatedAt: number;
  forkedFrom: string | null;
}

export interface TurnOptions {
  model?: string;
  effort?: string;
  mode?: SessionMode;
}

export interface CreateSessionOptions extends TurnOptions {
  cwd: string;
}

export interface PromptInput {
  text: string;
  /** Data URLs or paths of images. */
  images: string[];
}

export type HarnessEvent =
  | SessionEvent
  /** What the harness knows of a session changed, such as its title. */
  | { type: "session.changed"; sessionId: string; patch: Partial<HarnessSession> }
  /** MCP servers changed outside a request: a sign-in finished, a server started or failed. */
  | { type: "mcp.changed" }
  /** The owner signed in or out, or a sign-in ended. `error` says why it ended without one. */
  | { type: "account.changed"; error: string | null }
  /** The account's rate limits moved, as they do with each turn. */
  | { type: "limits.changed" }
  /** The harness itself stopped: every session it held is gone until a restart. */
  | { type: "harness.exited"; message: string };

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
}

export interface DirectoryEntry {
  name: string;
  directory: boolean;
}

export interface FileMatch {
  /** Relative to the searched root. */
  path: string;
  directory: boolean;
}

export interface TerminalOptions {
  id: string;
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  onData(bytes: Uint8Array): void;
  onExit(exitCode: number | null): void;
}

export interface TerminalHandle {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * The contract every agent backend (`harness/*`) implements. The daemon only
 * depends on this interface, so adding another agent means adding another
 * `harness/<name>` package and nothing else.
 *
 * It also gives the daemon the machine the agent runs on: files, processes
 * and terminals all go through the harness, so the daemon reaches no disk or
 * process of its own for a session's project and follows the agent wherever
 * it runs.
 */
export interface Harness {
  readonly name: string;
  start(): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: HarnessEvent) => void): () => void;

  createSession(options: CreateSessionOptions): Promise<HarnessSession>;
  listSessions(filter: { archived: boolean }): Promise<HarnessSession[]>;
  /** Brings a stored session into memory and returns its conversation. */
  loadSession(
    sessionId: string,
    options: TurnOptions,
  ): Promise<{ session: HarnessSession; turns: Turn[]; usage: Usage | null }>;
  /** Copies a session, up to and including `turnId` when given. */
  forkSession(sessionId: string, turnId: string | null): Promise<HarnessSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  archiveSession(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  compactSession(sessionId: string): Promise<void>;
  /**
   * Takes the conversation back to before `turnId`, which goes with every later turn. Only the
   * conversation: what the agent changed on disk stays. Answers the turn it went back to before,
   * which is an earlier one when the harness keeps `turnId` as more than one.
   */
  rewindSession(sessionId: string, turnId: string): Promise<{ from: string }>;

  /** Starts a turn. Progress arrives through `onEvent`. */
  send(sessionId: string, input: PromptInput, options: TurnOptions): Promise<{ turnId: string }>;
  /** Starts a turn in which the agent reviews code. Progress arrives through `onEvent`. */
  review(
    sessionId: string,
    target: ReviewTarget,
    options: TurnOptions,
  ): Promise<{ turnId: string }>;
  /** Adds input to the turn that is running. Fails when none is. */
  steer(sessionId: string, input: PromptInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respondApproval(approvalId: string, response: ApprovalResponse): void;

  listModels(): Promise<ModelInfo[]>;
  listSkills(cwd: string): Promise<SkillInfo[]>;

  // The owner's MCP servers and plugins live in the harness's own
  // configuration, so every session of it sees the same ones.
  listMcpServers(): Promise<McpServerInfo[]>;
  putMcpServer(server: McpServerInput): Promise<void>;
  removeMcpServer(name: string): Promise<void>;
  enableMcpServer(name: string, enabled: boolean): Promise<void>;
  /** Turns one tool of an owner's server on or off, leaving the server's others as they are. */
  enableMcpTool(name: string, tool: string, enabled: boolean): Promise<void>;
  /** Starts a sign-in and answers where the owner finishes it. */
  loginMcpServer(name: string): Promise<{ url: string }>;
  listPlugins(): Promise<PluginCatalog>;
  readPlugin(marketplace: string, name: string): Promise<PluginDetail>;
  installPlugin(marketplace: string, name: string): Promise<void>;
  uninstallPlugin(id: string): Promise<void>;
  enablePlugin(id: string, enabled: boolean): Promise<void>;
  addMarketplace(source: string): Promise<void>;
  removeMarketplace(name: string): Promise<void>;
  readFeatures(): Promise<AgentFeatures>;
  setFeatures(features: AgentFeatures): Promise<void>;

  readAccount(): Promise<AccountInfo>;
  /** Starts a sign-in the owner finishes in a browser. `account.changed` follows. */
  login(): Promise<AccountLogin>;
  cancelLogin(id: string): Promise<void>;
  logout(): Promise<void>;

  exec(argv: string[], options: ExecOptions): Promise<ExecResult>;
  readDirectory(path: string): Promise<DirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  searchFiles(root: string, query: string): Promise<FileMatch[]>;
  openTerminal(options: TerminalOptions): Promise<TerminalHandle>;
}
