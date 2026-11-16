import type {
  AgentCapabilities,
  AgentFeatures,
  AccountInfo,
  AccountLogin,
  ApprovalResponse,
  ContextUsage,
  FileRewind,
  HarnessInfo,
  McpServerInfo,
  McpServerInput,
  ModeInfo,
  ModelInfo,
  PluginCatalog,
  ReviewTarget,
  PluginDetail,
  PromptDocument,
  SessionEvent,
  SessionMode,
  SkillInfo,
  SlashCommand,
  Turn,
  Usage,
} from "./model.ts";

/** What a harness knows of a session. The daemon adds what only it keeps. */
export interface HarnessSession {
  id: string;
  /** The name of the harness that keeps it. */
  harness: string;
  title: string | null;
  preview: string;
  cwd: string;
  model: string;
  effort: string | null;
  branch: string | null;
  /** The sandbox its agent runs in, by name, when the harness knows. */
  sandbox: string | null;
  /** Where that sandbox sees the folder, when its paths are not this machine's. */
  sandboxCwd: string | null;
  createdAt: number;
  updatedAt: number;
  forkedFrom: string | null;
}

export interface TurnOptions {
  model?: string;
  effort?: string;
  mode?: SessionMode;
  /** The sandbox the session's agent runs in, by name. Left out, it runs on this machine. */
  sandbox?: string;
  /** Folders beyond the session's own its agent may reach, for an agent whose capabilities say so. */
  directories?: string[];
}

/** What a session is moved to while it may run. An effort of null is the model's own default. */
export interface ConfigureOptions {
  mode?: SessionMode;
  model?: string;
  effort?: string | null;
}

export interface CreateSessionOptions extends TurnOptions {
  cwd: string;
  /**
   * Run its agent in a sandbox of this environment of the owner's, by id, which the harness finds
   * or makes for the folder.
   */
  sandboxed?: string;
}

export interface PromptInput {
  text: string;
  /** Data URLs or paths of images. */
  images: string[];
  /** Only the kinds the agent's capabilities name. */
  documents?: PromptDocument[];
}

export type HarnessEvent =
  | SessionEvent
  /** What the harness knows of a session changed, such as its title. */
  | {
      type: "session.changed";
      sessionId: string;
      patch: Partial<HarnessSession>;
    }
  /** The agent moved itself to another of its modes, as on leaving its plan. */
  | { type: "mode.changed"; sessionId: string; mode: SessionMode }
  /** MCP servers changed outside a request: a sign-in finished, a server started or failed. */
  | { type: "mcp.changed" }
  /** The owner signed in or out, or a sign-in ended. `error` says why it ended without one. */
  | { type: "account.changed"; harness: string; error: string | null }
  /** The account's rate limits moved, as they do with each turn. */
  | { type: "limits.changed"; harness: string }
  /** The commands a session's prompt can begin with changed, as skills were found. */
  | { type: "commands.changed"; sessionId: string; commands: SlashCommand[] }
  /** The harness of this name stopped: every session it held is gone until a restart. */
  | { type: "harness.exited"; harness: string; message: string };

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
 * What every agent backend (`harness/*`) offers: sessions, their turns, and
 * the models they may run on. The daemon runs several at once, and a session
 * stays with the one it began on.
 */
export interface Agent {
  readonly name: string;
  /** What it can do beyond what every agent does. A method below that is optional, it has when they say. */
  readonly capabilities: AgentCapabilities;
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
  /**
   * Takes the session's changed mode, model or effort in now, while it runs, where the agent can;
   * else it applies from the next turn, which is given them too.
   */
  configure(sessionId: string, options: ConfigureOptions): Promise<void>;

  listModels(): Promise<ModelInfo[]>;
  /** The modes a session of this agent can be in. */
  listModes(): ModeInfo[];

  /**
   * Puts the files back as they were before `turnId`, or with `dryRun` says what that would change.
   * Its conversation stays: `rewindSession` takes that back. With `rewindFiles` capability.
   */
  rewindFiles?(sessionId: string, turnId: string, dryRun: boolean): Promise<FileRewind>;
  /** The commands a session's prompt can begin with, or a new session's in a folder. With `commands`. */
  listCommands?(target: { sessionId: string } | { cwd: string }): Promise<SlashCommand[]>;
  /** What the session's context holds, part by part. Null when it cannot tell now. */
  readContext?(sessionId: string): Promise<ContextUsage | null>;
}

/** What an agent besides the main one may read of its own Connector and Account. */
export type AgentReads = Partial<
  Pick<Connector, "listSkills" | "listMcpServers"> & Pick<Account, "readAccount">
>;

/**
 * The owner's MCP servers and plugins, which live in a harness's own
 * configuration, so every session of it sees the same ones.
 */
export interface Connector {
  listSkills(cwd: string): Promise<SkillInfo[]>;
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
}

/** The owner's account with whoever serves a harness's own models. */
export interface Account {
  readAccount(): Promise<AccountInfo>;
  /** Starts a sign-in the owner finishes in a browser. `account.changed` follows. */
  login(): Promise<AccountLogin>;
  cancelLogin(id: string): Promise<void>;
  logout(): Promise<void>;
}

/**
 * The machine the agents run on: files, processes and terminals. The daemon
 * reaches no disk or process of its own for a session's project, so it follows
 * the agent wherever it runs.
 */
export interface Machine {
  exec(argv: string[], options: ExecOptions): Promise<ExecResult>;
  readDirectory(path: string): Promise<DirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  searchFiles(root: string, query: string): Promise<FileMatch[]>;
  openTerminal(options: TerminalOptions): Promise<TerminalHandle>;
}

/**
 * Everything the daemon depends on. One harness gives all of it; another
 * agent beside it need only be an `Agent`, and the daemon joins them into one
 * `Harness` (`apps/daemon/src/harnesses.ts`).
 */
export interface Harness extends Agent, Connector, Account, Machine {}

/**
 * Every agent the daemon runs, as the daemon sees them (`apps/daemon/src/harnesses.ts`). A session
 * goes to the agent it began on; a Connector and an Account are chosen by the agent's name, the main
 * one's when none is given, and the machine is the main one's.
 */
export interface Agents
  extends Omit<Agent, "capabilities" | "rewindFiles" | "listCommands" | "readContext">, Machine {
  /** The agents running, the main one first. */
  harnesses(): HarnessInfo[];
  /** An agent's Connector. What it cannot do, it refuses saying so. */
  connector(harness?: string): Connector;
  account(harness?: string): Account;
  rewindFiles(sessionId: string, turnId: string, dryRun: boolean): Promise<FileRewind>;
  /** A session's commands, or those of a new session in a folder, of the agent `harness` names. */
  listCommands(
    target: { sessionId: string } | { harness: string; cwd: string },
  ): Promise<SlashCommand[]>;
  readContext(sessionId: string): Promise<ContextUsage | null>;
  /** The capabilities of the agent that keeps a session. */
  capabilitiesOf(sessionId: string): Promise<AgentCapabilities>;
}
