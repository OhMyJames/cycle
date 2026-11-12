import type {
  AccountInfo,
  ApprovalResponse,
  McpServerInfo,
  ModelInfo,
  SessionEvent,
  SessionInfo,
  SessionMode,
  SkillInfo,
  TokenCount,
} from "./model.ts";
import type { SessionState } from "./reduce.ts";

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
    };
    result: SessionInfo;
  };
  /**
   * Starts following a session. With `afterSeq`, answers with only the frames
   * since then when the daemon still has them, else with the whole state.
   */
  "session.open": {
    params: { sessionId: string; afterSeq?: number };
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
  "approval.respond": {
    params: { sessionId: string; approvalId: string; response: ApprovalResponse };
    result: Empty;
  };

  "models.list": { params: Empty; result: { models: ModelInfo[] } };
  "skills.list": { params: { cwd: string }; result: { skills: SkillInfo[] } };
  "mcp.list": { params: Empty; result: { servers: McpServerInfo[] } };
  "account.read": { params: Empty; result: AccountInfo };
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
  | { type: "terminals.changed"; sessionId: string | null; terminals: TerminalInfo[] }
  /** Base64 of what a terminal printed, to the clients attached to it. */
  | { type: "terminal.output"; id: string; data: string }
  | { type: "usage.today"; day: DayUsage };

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { frame: EventFrame }
  | { push: DaemonEvent };

export const DEFAULT_DAEMON_PORT = 4747;
export const WS_PATH = "/ws";
/** Close code for a connection the daemon refuses: do not retry with the same token. */
export const CLOSE_UNAUTHORIZED = 4401;
