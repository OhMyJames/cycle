import type {
  AgentFeatures,
  HookSettings,
  AccountInfo,
  AccountLogin,
  ApprovalResponse,
  ContextUsage,
  FileRewind,
  HarnessInfo,
  McpServerInfo,
  SubagentInfo,
  McpServerInput,
  ModeInfo,
  ModelInfo,
  ModelProvider,
  ModelProviderDraft,
  SandboxEnvironment,
  SandboxEnvironmentDraft,
  SandboxSecret,
  ProviderKind,
  ProviderModel,
  PluginCatalog,
  PluginDetail,
  PromptDocument,
  ReviewTarget,
  SessionEvent,
  SessionInfo,
  SessionMode,
  SkillInfo,
  SlashCommand,
  TokenCount,
} from "./model.ts";
import type { SessionState } from "./reduce.ts";
import type { Schedule, ScheduleInput, ScheduleRun } from "./schedule.ts";

/**
 * Client <-> daemon wire protocol: JSON text frames over one WebSocket.
 * Requests are correlated by `id`; everything else is pushed.
 */

export interface DaemonInfo {
  version: string;
  /** The main agent's name. */
  harness: string;
  /** Every agent running, the main one first, with what each can do. */
  harnesses: HarnessInfo[];
  /** Where the daemon keeps its data. */
  home: string;
  platform: string;
  /** The owner's home directory, where a folder picker starts. */
  userHome: string;
}

/** What new sessions start with, and what the daemon remembers for the owner. */
export interface Settings {
  model: string | null;
  effort: string | null;
  /** The mode a new session starts in, by the name of the agent it runs on. */
  modes: Record<string, SessionMode>;
  /** Whether a new session in a repository gets its own worktree. */
  worktree: boolean;
  /** Folders the owner works in, most recent first. */
  projects: string[];
}

export interface GitFile {
  path: string;
  oldPath: string | null;
  /** A added, M modified, D deleted, R renamed, U untracked. */
  status: "A" | "M" | "D" | "R" | "U";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitStatus {
  /** Null when the folder is in no repository. */
  repo: {
    root: string;
    branch: string | null;
    head: string | null;
    /** What the changes are read against: a base commit, or HEAD. */
    from: string;
  } | null;
  files: GitFile[];
  truncated: boolean;
}

export interface TerminalInfo {
  id: string;
  sessionId: string | null;
  cwd: string;
  title: string;
  exitCode: number | null;
  exited: boolean;
}

export interface FileContent {
  size: number;
  binary: boolean;
  text: string;
  truncated: boolean;
  image: { mime: string; data: string } | null;
}

export interface DayUsage {
  /** Local date, YYYY-MM-DD. */
  date: string;
  tokens: TokenCount;
  turns: number;
}

export type Delivery =
  /** Start a turn, or queue behind the one running. */
  | "auto"
  /** Put it into the running turn now. */
  | "steer";

type Empty = Record<string, never>;
/** Which agent's Connector or Account: the main one's when left out. */
type OfHarness = { harness?: string };

export interface Methods {
  "daemon.info": { params: Empty; result: DaemonInfo };

  "session.list": {
    params: { archived: boolean };
    result: { sessions: SessionInfo[] };
  };
  "session.create": {
    params: {
      cwd: string;
      model?: string;
      effort?: string;
      mode?: SessionMode;
      /** Make a worktree for it, on a branch of this name when given. */
      worktree?: { branch?: string; base?: string };
      /** Run its agent in a sandbox of this environment, by id. Not with a worktree. */
      sandbox?: string;
      /** Folders beyond `cwd` its agent may reach, when the agent can. Not with a sandbox. */
      directories?: string[];
    };
    result: SessionInfo;
  };
  /**
   * Starts following a session. With `after`, the frame the client last
   * folded in, answers with only the frames since then when the daemon still
   * has them and they continue the same run, else with the whole state.
   */
  "session.open": {
    params: { sessionId: string; after?: { seq: number; epoch: string } };
    result: { state: SessionState } | { frames: EventFrame[] };
  };
  "session.close": { params: { sessionId: string }; result: Empty };
  "session.send": {
    params: {
      sessionId: string;
      text: string;
      images?: string[];
      /** Only the kinds the session's agent takes. */
      documents?: PromptDocument[];
      delivery?: Delivery;
    };
    /** `id` names it in the queue, when it was queued. */
    result: { queued: boolean; id?: string };
  };
  "session.unqueue": {
    params: { sessionId: string; id: string };
    result: Empty;
  };
  "session.interrupt": { params: { sessionId: string }; result: Empty };
  /** Stops one task of the session's, by the id its `tasks` list gives. Its turn, if any, goes on. */
  "session.stopTask": { params: { sessionId: string; taskId: string }; result: Empty };
  "session.update": {
    params: {
      sessionId: string;
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      unread?: boolean;
      model?: string;
      effort?: string | null;
      mode?: SessionMode;
      /** A label for the conversation; null takes it off. Only where the agent keeps one. */
      tag?: string | null;
    };
    result: SessionInfo;
  };
  "session.delete": {
    params: { sessionId: string; removeWorktree?: boolean };
    result: Empty;
  };
  "session.fork": {
    params: { sessionId: string; turnId?: string };
    result: SessionInfo;
  };
  "session.compact": { params: { sessionId: string }; result: Empty };
  /** Starts a turn that reviews code. Refused while a turn runs. */
  "session.review": {
    params: { sessionId: string; target: ReviewTarget };
    result: Empty;
  };
  /**
   * Removes a turn and every later one from the conversation, for good. With `files`, also puts
   * back the files the agent changed since, when its agent can; else they stay. Clients confirm first.
   */
  "session.rewind": {
    params: { sessionId: string; turnId: string; files?: boolean };
    result: Empty;
  };
  /** What `session.rewind` with `files` would put back. Nothing is changed. */
  "session.rewind.preview": {
    params: { sessionId: string; turnId: string };
    result: FileRewind;
  };
  /** What the session's context holds now: in parts when its agent can tell, else the total. */
  "session.context": {
    params: { sessionId: string };
    result: { context: ContextUsage | null };
  };
  /**
   * The commands a prompt can begin with: a session's, or a new session's of an agent. Sent, a
   * command is a prompt like any other.
   */
  "commands.list": {
    params: { sessionId: string } | { harness: string; cwd: string };
    result: { commands: SlashCommand[] };
  };
  "approval.respond": {
    params: {
      sessionId: string;
      approvalId: string;
      response: ApprovalResponse;
    };
    result: Empty;
  };

  "models.list": { params: Empty; result: { models: ModelInfo[] } };
  /** Every agent's modes. A session can be in those of the agent it runs on. */
  "modes.list": { params: Empty; result: { modes: ModeInfo[] } };
  "skills.list": { params: { cwd: string } & OfHarness; result: { skills: SkillInfo[] } };
  /** Turns a skill on or off for every session of the agent. Answers the folder's skills. */
  "skills.enable": {
    params: { cwd: string; name: string; enabled: boolean } & OfHarness;
    result: { skills: SkillInfo[] };
  };
  /** The hooks Cycle keeps for an agent. The page asks the owner before it sets any. */
  "hooks.read": { params: OfHarness; result: HookSettings };
  "hooks.set": { params: { settings: HookSettings } & OfHarness; result: HookSettings };

  // The connector: the owner's MCP servers and plugins, as each agent keeps them. An agent other
  // than the main one may only read: what it cannot do, it refuses saying so.
  "mcp.list": { params: OfHarness; result: { servers: McpServerInfo[] } };
  /** Adds a server, or changes the one of that name. */
  "mcp.put": {
    params: { server: McpServerInput } & OfHarness;
    result: { servers: McpServerInfo[] };
  };
  "mcp.remove": {
    params: { name: string } & OfHarness;
    result: { servers: McpServerInfo[] };
  };
  "mcp.enable": {
    params: { name: string; enabled: boolean } & OfHarness;
    result: { servers: McpServerInfo[] };
  };
  "mcp.enableTool": {
    params: { name: string; tool: string; enabled: boolean } & OfHarness;
    result: { servers: McpServerInfo[] };
  };
  /** The helper agents a session in a folder can start. */
  "subagents.list": { params: { cwd: string } & OfHarness; result: { agents: SubagentInfo[] } };
  /** Connects a server again, in the agent's process that runs. */
  "mcp.reconnect": {
    params: { name: string } & OfHarness;
    result: { servers: McpServerInfo[] };
  };
  /** Starts a sign-in. The owner finishes it at `url`; `mcp.changed` follows. */
  "mcp.login": { params: { name: string } & OfHarness; result: { url: string } };
  "plugins.list": { params: OfHarness; result: PluginCatalog };
  "plugins.read": {
    params: { marketplace: string; name: string } & OfHarness;
    result: PluginDetail;
  };
  "plugins.install": {
    params: { marketplace: string; name: string } & OfHarness;
    result: PluginCatalog;
  };
  "plugins.uninstall": { params: { id: string } & OfHarness; result: PluginCatalog };
  "plugins.enable": {
    params: { id: string; enabled: boolean } & OfHarness;
    result: PluginCatalog;
  };
  /** `source` is a folder on the daemon's machine or a Git URL. */
  "marketplace.add": { params: { source: string } & OfHarness; result: PluginCatalog };
  "marketplace.remove": { params: { name: string } & OfHarness; result: PluginCatalog };
  "features.read": { params: Empty; result: AgentFeatures };
  "features.set": { params: AgentFeatures; result: AgentFeatures };

  // Schedules: prompts the daemon runs on a timing, each in a new session.
  "schedule.list": { params: Empty; result: { schedules: Schedule[] } };
  /** Makes a schedule, or changes the one `id` names. */
  "schedule.put": { params: ScheduleInput; result: Schedule };
  /** Removes a schedule. The sessions it started stay. */
  "schedule.delete": { params: { id: string }; result: Empty };
  /** Runs it now, enabled or not, without moving its occurrences. */
  "schedule.run": { params: { id: string }; result: ScheduleRun };

  "account.read": { params: OfHarness; result: AccountInfo };
  /**
   * Starts a sign-in, for an agent whose capabilities say `login`. `account.changed` follows when
   * it ends, either way.
   */
  "account.login": { params: OfHarness; result: AccountLogin };
  "account.login.cancel": { params: { id: string } & OfHarness; result: Empty };
  "account.logout": { params: OfHarness; result: Empty };

  "providers.list": { params: Empty; result: { providers: ModelProvider[] } };
  /** The services a provider can be for. */
  "providers.kinds": { params: Empty; result: { kinds: ProviderKind[] } };
  /** The models a service is known to serve. */
  "providers.catalog": {
    params: { kind: string };
    result: { models: ProviderModel[] };
  };
  "providers.save": { params: ModelProviderDraft; result: ModelProvider };
  "providers.delete": { params: { id: string }; result: Empty };

  /** The owner's sandbox environments, and whether sandboxes can be made on this machine. */
  "sandboxes.list": {
    params: Empty;
    result: { available: boolean; environments: SandboxEnvironment[] };
  };
  "sandboxes.save": {
    params: SandboxEnvironmentDraft;
    result: SandboxEnvironment;
  };
  /** Removes an environment, and the sandboxes made of it that no session is running in. */
  "sandboxes.delete": { params: { id: string }; result: Empty };
  /** The services a sandbox can be signed in to, and whether a secret is kept for each. */
  "sandboxes.secrets": { params: Empty; result: { secrets: SandboxSecret[] } };
  /** Hands a service's secret to what keeps it outside every sandbox. Nothing gives it back. */
  "sandboxes.secret.set": {
    params: { service: string; value: string };
    result: Empty;
  };
  "settings.get": { params: Empty; result: Settings };
  "settings.set": { params: Partial<Settings>; result: Settings };
  "usage.daily": { params: Empty; result: { days: DayUsage[] } };

  "files.list": {
    params: { path: string };
    result: { entries: { name: string; directory: boolean }[] };
  };
  "files.read": { params: { path: string }; result: FileContent };
  "files.search": {
    params: { root: string; query: string };
    result: { files: { path: string; directory: boolean }[] };
  };

  "git.status": { params: { cwd: string; base?: string }; result: GitStatus };
  "git.diff": {
    params: {
      cwd: string;
      from: string;
      path: string;
      status: GitFile["status"];
    };
    result: { patch: string; truncated: boolean };
  };
  "git.branches": {
    params: { cwd: string };
    result: { current: string | null; local: string[]; remote: string[] };
  };
  "git.checkout": { params: { cwd: string; branch: string }; result: Empty };
  "git.commit": {
    params: { cwd: string; message: string };
    result: { commit: string };
  };

  "terminal.list": {
    params: { sessionId: string | null };
    result: { terminals: TerminalInfo[] };
  };
  "terminal.create": {
    params: {
      sessionId: string | null;
      cwd: string;
      cols: number;
      rows: number;
    };
    result: TerminalInfo;
  };
  /** Answers with what the terminal has printed, then streams `terminal.output`. */
  "terminal.attach": {
    params: { id: string };
    result: { terminal: TerminalInfo; data: string };
  };
  "terminal.detach": { params: { id: string }; result: Empty };
  "terminal.write": { params: { id: string; data: string }; result: Empty };
  "terminal.resize": {
    params: { id: string; cols: number; rows: number };
    result: Empty;
  };
  "terminal.close": { params: { id: string }; result: Empty };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]["params"];
export type Result<M extends MethodName> = Methods[M]["result"];

export type ClientMessage = {
  [M in MethodName]: { id: number; method: M; params: Params<M> };
}[MethodName];

/**
 * One step of a session's conversation: the events that happened together.
 * Frames are numbered from 1 with no gaps, so a client can tell it missed one.
 */
export interface EventFrame {
  sessionId: string;
  seq: number;
  events: SessionEvent[];
}

/** What every client hears, whichever sessions it follows. */
export type DaemonEvent =
  | { type: "sessions.changed"; sessions: SessionInfo[] }
  | { type: "sessions.removed"; sessionIds: string[] }
  | { type: "settings.changed"; settings: Settings }
  /** `error` says why a sign-in ended without one. The account says whose it is. */
  | { type: "account.changed"; account: AccountInfo; error: string | null }
  /** An account's rate limits moved, as they do with each turn. Nothing else changed. */
  | { type: "limits.changed"; account: AccountInfo }
  /** The commands a session's prompt can begin with changed. */
  | { type: "commands.changed"; sessionId: string; commands: SlashCommand[] }
  /** What the agent guesses the owner sends next in a session; null once it is stale. */
  | { type: "suggestion.changed"; sessionId: string; suggestion: string | null }
  | { type: "models.changed"; models: ModelInfo[] }
  | { type: "providers.changed"; providers: ModelProvider[] }
  | { type: "sandboxes.changed"; environments: SandboxEnvironment[] }
  | {
      type: "terminals.changed";
      sessionId: string | null;
      terminals: TerminalInfo[];
    }
  /** Base64 of what a terminal printed, to the clients attached to it. */
  | { type: "terminal.output"; id: string; data: string }
  | { type: "usage.today"; day: DayUsage }
  | { type: "mcp.changed"; harness: string; servers: McpServerInfo[] }
  | { type: "plugins.changed"; harness: string; catalog: PluginCatalog }
  /** The hooks Cycle keeps for an agent, and the switches of the owner's own, as they now are. */
  | { type: "hooks.changed"; harness: string; settings: HookSettings }
  /** A skill was turned on or off: a page that shows an agent's skills reads them again. */
  | { type: "skills.changed"; harness: string }
  | { type: "features.changed"; features: AgentFeatures }
  /** The whole list, whenever a schedule changes, by a client or by a run. */
  | { type: "schedules.changed"; schedules: Schedule[] };

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { frame: EventFrame }
  | { push: DaemonEvent };

export const DEFAULT_DAEMON_PORT = 4747;
export const WS_PATH = "/ws";
/** Close code for a connection the daemon refuses: do not retry with the same token. */
export const CLOSE_UNAUTHORIZED = 4401;
