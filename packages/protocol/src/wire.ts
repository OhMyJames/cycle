import type {
  AgentFeatures,
  AccountInfo,
  AccountLogin,
  ApprovalResponse,
  McpServerInfo,
  McpServerInput,
  ModelInfo,
  ModelProvider,
  ModelProviderDraft,
  ProviderKind,
  ProviderModel,
  PluginCatalog,
  PluginDetail,
  ReviewTarget,
  SessionEvent,
  SessionInfo,
  SessionMode,
  SkillInfo,
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
  harness: string;
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
  mode: SessionMode;
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

export interface Methods {
  "daemon.info": { params: Empty; result: DaemonInfo };

  "session.list": { params: { archived: boolean }; result: { sessions: SessionInfo[] } };
  "session.create": {
    params: {
      cwd: string;
      model?: string;
      effort?: string;
      mode?: SessionMode;
      /** Make a worktree for it, on a branch of this name when given. */
      worktree?: { branch?: string; base?: string };
      /** Run its agent in a sandbox for the folder. Not with a worktree. */
      sandbox?: boolean;
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
    params: { sessionId: string; text: string; images?: string[]; delivery?: Delivery };
    result: { queued: boolean };
  };
  "session.unqueue": { params: { sessionId: string; id: string }; result: Empty };
  "session.interrupt": { params: { sessionId: string }; result: Empty };
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
    };
    result: SessionInfo;
  };
  "session.delete": { params: { sessionId: string; removeWorktree?: boolean }; result: Empty };
  "session.fork": { params: { sessionId: string; turnId?: string }; result: SessionInfo };
  "session.compact": { params: { sessionId: string }; result: Empty };
  /** Starts a turn that reviews code. Refused while a turn runs. */
  "session.review": { params: { sessionId: string; target: ReviewTarget }; result: Empty };
  /**
   * Removes a turn and every later one from the conversation, for good. Files the agent changed
   * stay as they are. Clients confirm first.
   */
  "session.rewind": { params: { sessionId: string; turnId: string }; result: Empty };
  "approval.respond": {
    params: { sessionId: string; approvalId: string; response: ApprovalResponse };
    result: Empty;
  };

  "models.list": { params: Empty; result: { models: ModelInfo[] } };
  "skills.list": { params: { cwd: string }; result: { skills: SkillInfo[] } };

  // The connector: the owner's MCP servers and plugins, as the harness keeps them.
  "mcp.list": { params: Empty; result: { servers: McpServerInfo[] } };
  /** Adds a server, or changes the one of that name. */
  "mcp.put": { params: { server: McpServerInput }; result: { servers: McpServerInfo[] } };
  "mcp.remove": { params: { name: string }; result: { servers: McpServerInfo[] } };
  "mcp.enable": {
    params: { name: string; enabled: boolean };
    result: { servers: McpServerInfo[] };
  };
  "mcp.enableTool": {
    params: { name: string; tool: string; enabled: boolean };
    result: { servers: McpServerInfo[] };
  };
  /** Starts a sign-in. The owner finishes it at `url`; `mcp.changed` follows. */
  "mcp.login": { params: { name: string }; result: { url: string } };
  "plugins.list": { params: Empty; result: PluginCatalog };
  "plugins.read": { params: { marketplace: string; name: string }; result: PluginDetail };
  "plugins.install": { params: { marketplace: string; name: string }; result: PluginCatalog };
  "plugins.uninstall": { params: { id: string }; result: PluginCatalog };
  "plugins.enable": { params: { id: string; enabled: boolean }; result: PluginCatalog };
  /** `source` is a folder on the daemon's machine or a Git URL. */
  "marketplace.add": { params: { source: string }; result: PluginCatalog };
  "marketplace.remove": { params: { name: string }; result: PluginCatalog };
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

  "account.read": { params: Empty; result: AccountInfo };
  /** Starts a ChatGPT sign-in. `account.changed` follows when it ends, either way. */
  "account.login": { params: Empty; result: AccountLogin };
  "account.login.cancel": { params: { id: string }; result: Empty };
  "account.logout": { params: Empty; result: Empty };

  "providers.list": { params: Empty; result: { providers: ModelProvider[] } };
  /** The services a provider can be for. */
  "providers.kinds": { params: Empty; result: { kinds: ProviderKind[] } };
  /** The models a service is known to serve. */
  "providers.catalog": { params: { kind: string }; result: { models: ProviderModel[] } };
  "providers.save": { params: ModelProviderDraft; result: ModelProvider };
  "providers.delete": { params: { id: string }; result: Empty };
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
    params: { cwd: string; from: string; path: string; status: GitFile["status"] };
    result: { patch: string; truncated: boolean };
  };
  "git.branches": {
    params: { cwd: string };
    result: { current: string | null; local: string[]; remote: string[] };
  };
  "git.checkout": { params: { cwd: string; branch: string }; result: Empty };
  "git.commit": { params: { cwd: string; message: string }; result: { commit: string } };

  "terminal.list": { params: { sessionId: string | null }; result: { terminals: TerminalInfo[] } };
  "terminal.create": {
    params: { sessionId: string | null; cwd: string; cols: number; rows: number };
    result: TerminalInfo;
  };
  /** Answers with what the terminal has printed, then streams `terminal.output`. */
  "terminal.attach": { params: { id: string }; result: { terminal: TerminalInfo; data: string } };
  "terminal.detach": { params: { id: string }; result: Empty };
  "terminal.write": { params: { id: string; data: string }; result: Empty };
  "terminal.resize": { params: { id: string; cols: number; rows: number }; result: Empty };
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
  /** `error` says why a sign-in ended without one. */
  | { type: "account.changed"; account: AccountInfo; error: string | null }
  /** The account's rate limits moved, as they do with each turn. Nothing else changed. */
  | { type: "limits.changed"; account: AccountInfo }
  | { type: "models.changed"; models: ModelInfo[] }
  | { type: "providers.changed"; providers: ModelProvider[] }
  | { type: "terminals.changed"; sessionId: string | null; terminals: TerminalInfo[] }
  /** Base64 of what a terminal printed, to the clients attached to it. */
  | { type: "terminal.output"; id: string; data: string }
  | { type: "usage.today"; day: DayUsage }
  | { type: "mcp.changed"; servers: McpServerInfo[] }
  | { type: "plugins.changed"; catalog: PluginCatalog }
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
