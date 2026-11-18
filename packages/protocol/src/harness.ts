import type { AgentDeclaration } from "./declaration.ts";
import type {
  AgentCapabilities,
  AgentFeatures,
  HookSettings,
  AccountInfo,
  AccountLogin,
  ApprovalResponse,
  ContextUsage,
  FileRewind,
  AgentInfo,
  McpServerInfo,
  SubagentInfo,
  McpServerInput,
  ModeInfo,
  ModelInfo,
  PluginCatalog,
  ReviewTarget,
  PluginDetail,
  PromptDocument,
  SessionEvent,
  PermissionMode,
  SkillInfo,
  SlashCommand,
  Turn,
  Usage,
} from "./model.ts";

/** What a harness knows of a session. The daemon adds what only it keeps. */
export interface AgentSession {
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
  /** A label the owner put on it, kept by the agent with the conversation. Absent: none. */
  tag?: string;
}

export interface TurnOptions {
  model?: string;
  effort?: string;
  mode?: PermissionMode;
  /**
   * The environment the session runs in, by id, from which the harness names the container its agent
   * runs in. Left out, and with no `sandbox`, it runs on this machine.
   */
  environment?: string;
  /** The sandbox the session's agent runs in, by name. Left out, it runs on this machine. */
  sandbox?: string;
  /** Folders beyond the session's own its agent may reach, for an agent whose capabilities say so. */
  directories?: string[];
}

/** What a session is moved to while it may run. An effort of null is the model's own default. */
export interface ConfigureOptions {
  mode?: PermissionMode;
  model?: string;
  effort?: string | null;
}

export interface CreateSessionOptions extends TurnOptions {
  cwd: string;
  /**
   * Run its agent in a sandbox of this environment of the owner's, by id, which the harness finds
   * or makes for the folder. `environment` says the same.
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

/** What an agent says of a session: every event a frame carries, and four the daemon routes itself. */
export type AgentSessionEvent =
  | SessionEvent
  /** What the harness knows of a session changed, such as its title. */
  | {
      type: "session.changed";
      sessionId: string;
      patch: Partial<AgentSession>;
    }
  /** The agent moved itself to another of its modes, as on leaving its plan. */
  | { type: "mode.changed"; sessionId: string; mode: PermissionMode }
  /** The commands a session's prompt can begin with changed, as skills were found. */
  | { type: "commands.changed"; sessionId: string; commands: SlashCommand[] }
  /** What the agent guesses the owner sends next, after a turn; null once it is stale. */
  | { type: "suggestion.changed"; sessionId: string; suggestion: string | null };

/** What an agent says of itself: none of these carries a session id. */
export type AgentEvent =
  /** MCP servers changed outside a request: a sign-in finished, a server started or failed. */
  | { type: "mcp.changed" }
  /** The owner signed in or out, or a sign-in ended. `error` says why it ended without one. */
  | { type: "account.changed"; harness: string; error: string | null }
  /** The account's rate limits moved, as they do with each turn. */
  | { type: "limits.changed"; harness: string }
  /** The harness of this name stopped: every session it held is gone until a restart. */
  | { type: "agent.exited"; harness: string; message: string };

/** The one stream a harness reports on: an event is a session's when it carries `sessionId`. */
export type HarnessEvent = AgentSessionEvent | AgentEvent;

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
 * The part of a harness that holds sessions, their turns and the models they
 * may run on: what every agent backend (`harness/*`) offers. The daemon runs
 * several at once, and a session stays with the one it began on.
 */
export interface Sessions {
  readonly name: string;
  /** What it can do beyond what every agent does. A method below that is optional, it has when they say. */
  readonly capabilities: AgentCapabilities;
  /**
   * The same, by operation: what it does beyond the core, which of the optional methods below it has.
   * It replaces `capabilities`, which stays until the daemon and the page read this.
   */
  readonly declaration: AgentDeclaration;
  start(): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: HarnessEvent) => void): () => void;

  createSession(options: CreateSessionOptions): Promise<AgentSession>;
  listSessions(filter: { archived: boolean }): Promise<AgentSession[]>;
  /** Brings a stored session into memory and returns its conversation. */
  loadSession(
    sessionId: string,
    options: TurnOptions,
  ): Promise<{ session: AgentSession; turns: Turn[]; usage: Usage | null }>;
  /** Copies a session, up to and including `turnId` when given. */
  forkSession(sessionId: string, turnId: string | null): Promise<AgentSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Puts a tag on a conversation, or takes it off with null. With the `tags` capability. */
  tagSession?(sessionId: string, tag: string | null): Promise<void>;
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
  /** Stops the turn. Tasks in the background go on when the harness can stop them one by one. */
  interrupt(sessionId: string): Promise<void>;
  /**
   * Stops one task, which `tasks.updated` named. Only a harness whose tasks go on by themselves has
   * it.
   */
  stopTask?(sessionId: string, taskId: string): Promise<void>;
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

/**
 * What an agent besides the main one gives of its own Connector and Account. What it leaves out is
 * refused for it, never done by the main agent in its place.
 */
export type AgentReads = Partial<Connector> & Partial<Pick<Account, "readAccount">>;

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
  /** The helper agents a session in this folder can start. With the `subagents` capability. */
  listSubagents?(cwd: string): Promise<SubagentInfo[]>;
  /** Connects a server again, in the process that runs. With the `mcpReconnect` capability. */
  reconnectMcpServer?(name: string): Promise<void>;
  listPlugins(): Promise<PluginCatalog>;
  readPlugin(marketplace: string, name: string): Promise<PluginDetail>;
  installPlugin(marketplace: string, name: string): Promise<void>;
  uninstallPlugin(id: string): Promise<void>;
  enablePlugin(id: string, enabled: boolean): Promise<void>;
  addMarketplace(source: string): Promise<void>;
  removeMarketplace(name: string): Promise<void>;
  readFeatures(): Promise<AgentFeatures>;
  setFeatures(features: AgentFeatures): Promise<void>;
  /** Turns a skill on or off for every session. With the `hooks` capability. */
  enableSkill(name: string, enabled: boolean): Promise<void>;
  /** With the `hooks` capability. */
  readHooks(): Promise<HookSettings>;
  /** Replaces the hooks and the switches of the owner's own. With the `hooks` capability. */
  setHooks(settings: HookSettings): Promise<void>;
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
 * agent beside it need only give `Sessions`, and the daemon joins them into one
 * `Harness` (`apps/daemon/src/harnesses.ts`).
 */
export interface Harness extends Sessions, Connector, Account, Machine {}

/**
 * Every agent the daemon runs, as the daemon sees them (`apps/daemon/src/harnesses.ts`). A session
 * goes to the agent it began on; a Connector and an Account are chosen by the agent's name, the main
 * one's when none is given, and the machine is the main one's.
 */
export interface Agents
  extends
    Omit<
      Sessions,
      "capabilities" | "declaration" | "rewindFiles" | "listCommands" | "readContext" | "tagSession"
    >,
    Machine {
  /** The agents running, the main one first. */
  harnesses(): AgentInfo[];
  /** An agent's Connector. What it cannot do, it refuses saying so. */
  connector(harness?: string): Connector;
  account(harness?: string): Account;
  rewindFiles(sessionId: string, turnId: string, dryRun: boolean): Promise<FileRewind>;
  /** Tags the session, or takes the tag off; refused when its agent keeps no tags. */
  tagSession(sessionId: string, tag: string | null): Promise<void>;
  /** A session's commands, or those of a new session in a folder, of the agent `harness` names. */
  listCommands(
    target: { sessionId: string } | { harness: string; cwd: string },
  ): Promise<SlashCommand[]>;
  readContext(sessionId: string): Promise<ContextUsage | null>;
  /** The capabilities of the agent that keeps a session. */
  capabilitiesOf(sessionId: string): Promise<AgentCapabilities>;
  /** The declaration of the agent that keeps a session. */
  declarationOf(sessionId: string): Promise<AgentDeclaration>;
}
