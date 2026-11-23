// The contract between the Electron main process and the renderer. Types only: nothing here runs.
//
// The main process holds the connections and, for every session being watched, its conversation. The
// renderer asks, and is told of changes. A renderer that reloads asks again and is given the state
// whole: it does not depend on having been there for what came before.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { Conversation } from "./model/index.ts";

/**
 * How a remote environment is reached. SSH is one way, not what "remote" means: another transport (a WebSocket) is
 * another `type`, and nothing but the one place that opens the channel reads it.
 */
export type EnvironmentTransport = {
  type: "ssh";
  /** What `ssh` takes: `host`, `user@host`, or an alias from ~/.ssh/config. */
  host: string;
  /** What to run on the far side. Default: `cycle proxy`. */
  command?: string[];
};

/**
 * Where sessions run: this computer, or a remote one (later also a cloud one). A client's idea, not the protocol's: the
 * daemon cannot tell. Several are connected at once and their sessions are shown together (docs/desktop.md).
 */
export type EnvironmentConfig =
  | { id: string; name: string; kind: "local" }
  | { id: string; name: string; kind: "remote"; transport: EnvironmentTransport };

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export type EnvironmentStatus = {
  environmentId: string;
  state: ConnectionState;
  error?: string;
  /**
   * What the daemon on the environment can do beyond what every daemon does (docs/protocol.md §3). Absent until it has said: a
   * client that needs one of them waits, and does not assume.
   */
  capabilities?: {
    queue: boolean;
    steer?: boolean;
    files: boolean;
    folders: boolean;
    /** `_cycle/files/search` also takes a folder: @ works in a blank conversation. */
    filesInFolder?: boolean;
    /** One sub-agent can be stopped alone (docs/protocol.md §9, CYCL-143). */
    stopSubagent?: boolean;
    /** Folder trust can be read and set (docs/protocol.md §8 "信任文件夹"). */
    trust?: boolean;
    /** It keeps connectors: MCP servers for every agent (docs/protocol.md §14). */
    connectors?: boolean;
    /** The agents of it that have plugins (docs/protocol.md §15). None, or absent: no plugins there. */
    plugins?: string[];
    /** An @ may name another of its sessions, which it gives the agent as a record (docs/protocol.md §8). */
    sessionMentions?: boolean;
    /** The session's folder can be listed and its files read, for the Files tab (docs/protocol.md §8). */
    fs?: boolean;
    /** The session's folder can be compared with HEAD, for the Diff tab's workspace view (docs/protocol.md §8). */
    diff?: boolean;
    /** Shells can be opened beside a session, for the Terminal tabs (docs/protocol.md §8 "终端"). */
    terminal?: boolean;
  };
  /**
   * The daemon on the environment speaks another major version of Cycle's protocol, so the app cannot use it
   * (docs/protocol.md §3). Present while that is why the connection is not up; gone once it connects.
   */
  incompatible?: {
    /** Which has to change: the daemon is older than the app, or newer (the app is the one to update). */
    with: "daemon" | "app" | "unknown";
    /** The protocol versions the daemon says it speaks, and the one this app asked for. */
    supported: string[];
    requested: string;
    /** What to run on that machine to put this app's daemon there, when the daemon is the older one and remote. */
    command?: string;
  };
  /** What the daemon on the environment says it is. Not for the local one, which the app carries. */
  daemon?: {
    version: string;
    /** Set when it is too old for this app (not merely older: docs/desktop.md). */
    upgrade?: {
      /** The version the update puts there: the one of this app. */
      to: string;
      /** What to run on that machine by hand, when `upgradeDaemon` cannot. */
      command: string;
      /** `upgradeDaemon` is running it. */
      running?: boolean;
      /** Why the last `upgradeDaemon` did not work. */
      error?: string;
      /** Installed: the old daemon stops when none of its sessions is working (`upgradeDaemon(…, "later")`). */
      waiting?: boolean;
    };
  };
};

export type SessionSummary = {
  environmentId: string;
  sessionId: string;
  cwd: string;
  title?: string;
  archived: boolean;
  agent: string;
  state: "running" | "idle" | "requires_action" | "stopped";
  lastSeq: number;
  /** News the person has not seen (`cycle/unread`, protocol 0.2). Absent from an older daemon: then nothing is unread. */
  unread?: boolean;
  /** How many background sub-agents are working (`cycle/background`). Absent from an older daemon. */
  background?: number;
  unknownBackground?: string[];
  /**
   * When something last happened in the session (ISO 8601). Absent from a daemon older than protocol 0.2:
   * then the sessions of that daemon are ordered by `lastSeq`, which only compares within one daemon.
   */
  updatedAt?: string;
  /** What the session was set to, by name (the agent's settings). */
  config?: Record<string, string>;
};

export type AgentInfo = {
  id: string;
  name: string;
  available: boolean;
  /** JSON Schema of the agent's settings. The UI draws a form from it. */
  configSchema: Record<string, unknown>;
  /** What the agent takes in a prompt beyond text (ACP `PromptCapabilities`). Absent from a daemon that does not say. */
  promptCapabilities?:
    | {
        image?: object | null | undefined;
        audio?: object | null | undefined;
        embeddedContext?: object | null | undefined;
      }
    | undefined;
  /** It can take a message into the turn that is running (docs/protocol.md §8). Absent: it cannot. */
  steer?: boolean | undefined;
};

/** What a message to an agent is made of: text, and images as ACP carries them (base64). */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  /** A reference to a file or folder on the daemon's machine: `uri` is `file://`, a folder's ending in `/`. */
  | { type: "resource_link"; name: string; uri: string; _meta?: Record<string, unknown> }
  /**
   * A file's content in the message: a text file (`text`) or a PDF (`blob`, base64). The box makes one for a file it
   * attaches (`uri` is `attachment:///` and its name), and sends one from elsewhere again as it was.
   */
  | { type: "resource"; resource: Record<string, unknown>; _meta?: Record<string, unknown> };

export type FileHit = { path: string; kind: "file" | "folder" };

/** `root` is the session's folder as the daemon knows it; `path` is relative to it. */
export type FileSearch = { root: string; entries: FileHit[]; truncated: boolean };

/** An entry of a folder of the session's folder (docs/protocol.md §8 "浏览和预览文件"). */
export type FileEntry = {
  name: string;
  /** `other`: a link out of the folder or to nothing, a device: listed, never opened. */
  kind: "file" | "folder" | "other";
  link?: boolean | undefined;
  size?: number | undefined;
  /** Ignored by git; absent is "not known". */
  ignored?: boolean | undefined;
};

/** One folder of the session's folder: `path` relative to `root`, `""` for `root` itself. */
export type FileListing = { root: string; path: string; entries: FileEntry[]; truncated: boolean };

/** A file of the session's folder, as the daemon gives it to be shown. */
export type FileContent = { path: string; size: number; mtimeMs: number } & (
  | { kind: "text"; text: string; offset: number; next: number | null }
  | { kind: "image"; mimeType: string; data?: string | undefined; tooLarge?: boolean | undefined }
  | { kind: "binary" }
);

/** A file of the session's folder that differs from HEAD (docs/protocol.md §8 "工作区的改动"). */
export type WorkspaceFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked";
  additions?: number | undefined;
  deletions?: number | undefined;
  binary?: boolean | undefined;
  /** A repository inside, not tracked: no lines and no patch. */
  folder?: boolean | undefined;
};

/** The session's folder against HEAD, or why there is nothing to compare: no repository, or one not trusted. */
export type WorkspaceStatus =
  | { state: "ok"; head: string | null; files: WorkspaceFile[]; truncated: boolean }
  | { state: "not_git" }
  | { state: "untrusted"; repository: string };

/** One file's patch against HEAD, in git's format; empty when binary or unchanged. */
export type WorkspacePatch = { path: string; patch: string; truncated: boolean; binary: boolean };

/**
 * A shell the person opened beside a session, running in the daemon (docs/protocol.md §8 "终端"). `title` is the shell's
 * name until the shell sets one; `exitCode` is there once it has exited, null when a signal ended it.
 */
export type TerminalInfo = {
  terminalId: string;
  sessionId: string;
  title: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode?: number | null | undefined;
};

/** A terminal as it is now: what redraws its screen, and the last piece of output that holds (`seq`). */
export type TerminalAttached = { terminal: TerminalInfo; screen: string; seq: number };

/**
 * Why a terminal could not be opened: too many open (on the session, or on the daemon), the session is archived or gone,
 * its folder is not there, the shell would not start, the daemon is stopping, or else (`failed`, with main's message).
 */
export type TerminalProblem =
  | "limit"
  | "archived"
  | "not_found"
  | "cwd_missing"
  | "spawn_failed"
  | "daemon_stopping"
  | "failed";

/** What an environment's machine has in a folder: names of folders only. `path` is the real path (links resolved). */
export type FolderListing = {
  path: string;
  parent: string | null;
  home: string;
  folders: { name: string }[];
  truncated: boolean;
};

/**
 * Whether a folder on an environment's machine may run the commands its own configuration names (hooks, MCP helpers).
 * `trusted` is null when nobody has decided; `from` is the folder the decision is on (it or one above it).
 */
export type FolderTrust = { path: string; trusted: boolean | null; from: string | null };

/** How a connector is reached: streamable HTTP, or a process the daemon starts on its machine. */
export type ConnectorTransport =
  | { type: "http"; url: string }
  | { type: "stdio"; command: string; args: string[]; cwd?: string | undefined };

/** How a connector signs in. `clientId` only for a server that does not register clients itself. */
export type ConnectorAuth =
  | { type: "none" }
  | { type: "oauth"; clientId?: string | undefined; scopes?: string[] | undefined };

/**
 * An MCP server the daemon keeps for every agent (docs/protocol.md §14). `secrets` names what has a value: the values
 * never leave the daemon.
 */
export type ConnectorInfo = {
  id: string;
  name: string;
  enabled: boolean;
  transport: ConnectorTransport;
  auth: ConnectorAuth;
  secrets: { headers: string[]; env: string[] };
  authorized: boolean;
  status: {
    state: "ready" | "needs_auth" | "disabled" | "error";
    reason?: "unreachable" | "auth_failed" | "spawn_failed" | "protocol" | undefined;
  };
  /**
   * Set when nobody added it: it is an http server a plugin of that agent brings (docs/protocol.md §15). It comes and
   * goes with the plugin; only its values and its sign-in are the person's to change.
   */
  origin?:
    | {
        type: "plugin";
        agentId: string;
        pluginId: string;
        /** The plugin's name, to show. Absent from an older daemon: the id is shown whole. */
        pluginName?: string | undefined;
        server: string;
      }
    | undefined;
  /** The names it needs a value for (written as `secrets.env`); those in `secrets.env` have one. */
  requires?: string[] | undefined;
};

/** Secrets to write: a value sets it, null removes it, a name not given keeps its value. */
export type ConnectorSecrets = {
  headers?: Record<string, string | null>;
  env?: Record<string, string | null>;
};

export type ConnectorDraft = {
  name: string;
  enabled?: boolean;
  transport: ConnectorTransport;
  auth: ConnectorAuth;
  secrets?: ConnectorSecrets;
};

export type ConnectorChange = Partial<ConnectorDraft>;

/** Why a connector could not be saved or signed in to: a fixed word the page has a sentence for. */
export type ConnectorProblem =
  | "invalid_name"
  | "reserved_header"
  | "invalid_cwd"
  | "name_taken"
  | "insecure_url"
  | "state_mismatch"
  | "no_registration"
  | "managed"
  | "auth_rejected"
  | "unreachable"
  | "not_found"
  | "invalid"
  | "unsupported"
  | "failed";

/** What an action on a connector came to. `message`: only with `failed`, what went wrong as main has it. */
export type ConnectorAnswer =
  | { connector: ConnectorInfo }
  | { problem: ConnectorProblem; message?: string };

/** Where an agent's plugins come from (Claude: a marketplace). `kind` is a fixed word the page has its own for. */
export type PluginSourceInfo = {
  agentId: string;
  id: string;
  name: string;
  kind: "builtin" | "git" | "directory" | "url" | "other";
  location?: string | undefined;
  removable: boolean;
};

/**
 * A plugin of one agent (docs/protocol.md §15). `id` is the agent's own and is never taken apart. What follows
 * `installed` is only of an installed one.
 */
export type PluginInfo = {
  agentId: string;
  id: string;
  name: string;
  description?: string | undefined;
  version?: string | undefined;
  sourceId: string;
  installed: boolean;
  enabled?: boolean | undefined;
  scope?: "user" | "project" | undefined;
  /** What it brings, by how many. Hooks, commands and MCP servers are what runs code. */
  contents?:
    | { skills: number; commands: number; agents: number; hooks: number; mcpServers: number }
    | undefined;
  /** Its MCP servers: `cycle` is one Cycle serves as the connector named, `agent` one the agent starts itself. */
  servers?: { name: string; by: "cycle" | "agent"; connectorId?: string | undefined }[] | undefined;
};

/** Why an agent's plugin machinery did not do it: a fixed word the page has a sentence for. */
export type PluginProblem =
  | "not_found"
  | "needs_command"
  | "unavailable"
  | "timeout"
  | "unsupported"
  | "failed";

/** `message`: what the agent's machinery said, for the person to read. */
export type PluginFailure = { problem: PluginProblem; message?: string };

/** Lists the folders of one environment's folder (the environment is already chosen). */
export type ListFolders = (path?: string, hidden?: boolean) => Promise<FolderListing>;

export type PermissionOption = { optionId: string; name: string; kind: string };

/** An agent asking the user. `key` names it in this app; answer it with `answerPermission`. */
export type PermissionRequest = {
  key: string;
  environmentId: string;
  sessionId: string;
  title: string;
  /** What the agent wants to do, as ACP gives it. Shown, never trusted. */
  subject?: unknown;
  options: PermissionOption[];
  /** The sub-agent that asks, by its id, when one does (docs/protocol.md §9): its card can say which. */
  subagentId?: string;
  /**
   * Present when the agent asks for answers, not leave (ACP's `elicitation/create`: a question it put, an MCP server's
   * form). `schema` is the request's `requestedSchema`, a flat JSON Schema object. Answer it with `answerForm`.
   */
  form?: { message: string; schema: unknown };
};

/** What a person did with a form: answered it (only the fields they filled), declined it, or dismissed it. */
export type FormAnswer =
  | { action: "accept"; content: Record<string, string | number | boolean | string[]> }
  | { action: "decline" }
  | { action: "cancel" };

/** A session as the renderer is given it: everything needed to draw it, at one moment. */
export type SessionSnapshot = {
  conversation: Conversation;
  permissions: PermissionRequest[];
  /** How many events about this session main has sent: the next one is this plus one. */
  version: number;
};

/** Where the app's own updating stands. `current` is the version that is running. */
export type UpdateState = {
  current: string;
} /** Not an installed app (a development run), or not a build that can replace itself. */ & (
  | { kind: "disabled"; reason: string }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; checkedAt: number }
  | { kind: "available"; version: string }
  /** `how`: only what changed since this version ("difference"), or the whole app ("whole"; also when it is not said). */
  | {
      kind: "downloading";
      version: string;
      received: number;
      total: number;
      how?: "difference" | "whole";
    }
  /** Unpacked and checked; the app is about to close and open again as the new version. */
  | { kind: "installing"; version: string }
  /** `version` is set when it was installing that version that failed: the user can try again. */
  | { kind: "error"; message: string; version?: string }
);

/** One of a subscription's usage limits (docs/protocol.md §8 "套餐用量"). */
export type PlanWindow = {
  /** `five_hour`, `seven_day`, or another the agent names. */
  kind: string;
  /** The share used, from 0; past 1 when over. */
  utilization: number;
  /** When it starts over, in milliseconds since the epoch. */
  resetsAt: number;
  status?: "allowed" | "allowed_warning" | "rejected" | undefined;
};

/** How much of an agent's account limits is used, as of `at` (milliseconds since the epoch). */
export type PlanUsage = { windows: PlanWindow[]; at: number };

/** What main tells the renderer. */
export type AppEvent =
  | { type: "environments"; environments: EnvironmentConfig[] }
  | ({ type: "environment-status" } & EnvironmentStatus)
  | { type: "sessions"; environmentId: string; sessions: SessionSummary[] }
  | {
      type: "update";
      environmentId: string;
      sessionId: string;
      update: SessionUpdate;
      /** When the daemon logged it, in milliseconds since the epoch (`cycle/ts`); absent when not known. */
      at?: number;
      /** The session's version after this update. */
      version: number;
    }
  | { type: "permission"; request: PermissionRequest; version: number }
  | {
      type: "permission-closed";
      environmentId: string;
      sessionId: string;
      key: string;
      version: number;
    }
  | { type: "agent-defaults"; environmentId: string; agent: string }
  /** An agent on that environment told how much of its account's plan limits is used. */
  | { type: "plan-usage"; environmentId: string; agent: string; usage: PlanUsage }
  /** The environment's connectors changed, here or elsewhere: read them again. */
  | { type: "connectors"; environmentId: string }
  /** An agent's plugins on that environment changed, here or elsewhere: read them again. */
  | { type: "plugins"; environmentId: string; agentId: string }
  /** A session was deleted elsewhere while the connection was away: nothing of it is kept. */
  | { type: "session-gone"; environmentId: string; sessionId: string }
  | { type: "app-update"; state: UpdateState }
  /** A session's terminals, whole: one was opened, closed, renamed, resized or ended. */
  | { type: "terminals"; environmentId: string; sessionId: string; terminals: TerminalInfo[] }
  /** Output of a terminal the app is attached to. Drop it if the screen in hand already holds `seq`. */
  | {
      type: "terminal-output";
      environmentId: string;
      terminalId: string;
      seq: number;
      data: string;
    }
  /** The app fell behind a terminal's output: draw it again from `screen`, then take what comes after `seq`. */
  | {
      type: "terminal-reset";
      environmentId: string;
      terminalId: string;
      seq: number;
      screen: string;
      cols: number;
      rows: number;
    }
  /** A notification was pressed: show this session. */
  | { type: "focus-session"; environmentId: string; sessionId: string };

/** Whether the app reports how it is used (docs/analytics.md). `available` is false when there is nowhere to report to. */
export type AnalyticsStatus = { available: boolean; enabled: boolean; noticed: boolean };

/** Light or dark, or as the system is. */
export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The languages the interface has, or the system's when it is one of them (`languages.ts` has their words). */
export const LANGUAGE_CHOICES = ["system", "en-US", "zh-CN"] as const;
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number];

/** What the person chose for how the app looks and reads. Kept by main, in the app's own data (docs/desktop.md). */
export type Preferences = { theme: ThemeChoice; language: LanguageChoice };

/** The preferences, and the system's language as main reads it (`system` follows it). */
export type PreferencesState = Preferences & { systemLanguage: string };

/** What the page may say about itself: numbers, booleans and words. Main checks it against its dictionary. */
export type TrackProps = Record<string, string | number | boolean>;

export type NewSession = { cwd: string; agent?: string; config?: Record<string, string> };

/**
 * What sent a message: Enter, the ⌘Enter shortcut, or a button in the composer. The words of `prompt_sent.via` in
 * `@cycle/analytics/events` (this file may import nothing of it), which main checks them against.
 */
export type SendVia = "enter" | "shortcut" | "button";

/** What the renderer asks of main. Every method can fail; the renderer shows the message. */
export type AppApi = {
  /**
   * Every environment, how its connection stands, and the last list of sessions main read from each: an environment that is
   * away still has its last list, which is shown greyed. Only for as long as the app runs: one that could not be
   * reached since it started has none.
   */
  environments(): Promise<{
    environments: EnvironmentConfig[];
    status: EnvironmentStatus[];
    sessions: Record<string, SessionSummary[]>;
  }>;
  saveEnvironment(environment: EnvironmentConfig): Promise<void>;
  removeEnvironment(environmentId: string): Promise<void>;
  connect(environmentId: string): Promise<void>;
  disconnect(environmentId: string): Promise<void>;

  sessions(environmentId: string): Promise<SessionSummary[]>;
  createSession(environmentId: string, params: NewSession): Promise<string>;
  /** Starts watching a session and returns it whole. Call again after a reload. */
  openSession(environmentId: string, sessionId: string): Promise<SessionSnapshot>;
  /**
   * A text, or blocks: text and images. `steer`: into the running turn rather than the queue. `via`: what the person
   * pressed, for the count of how messages are sent (never their content).
   */
  prompt(
    environmentId: string,
    sessionId: string,
    content: string | PromptBlock[],
    options?: { steer?: boolean; via?: SendVia },
  ): Promise<void>;
  cancel(environmentId: string, sessionId: string): Promise<void>;
  /**
   * Files and folders of the session's folder, on the machine of the daemon, that fit what was typed after an @. A blank
   * conversation has no session yet and gives its folder: only a daemon with `filesInFolder` takes that.
   */
  searchFiles(
    environmentId: string,
    where: { sessionId: string } | { cwd: string },
    query: string,
  ): Promise<FileSearch>;
  /** One folder of a session's folder, `path` relative to it. Fails with the daemon's reason, or when it is too old. */
  listFiles(environmentId: string, sessionId: string, path: string): Promise<FileListing>;
  /** A file of a session's folder, text from `offset`. Fails with the daemon's reason, or when it is too old. */
  readFile(
    environmentId: string,
    sessionId: string,
    path: string,
    offset?: number,
  ): Promise<FileContent>;
  /** Which files of a session's folder differ from HEAD. Fails with the daemon's reason, or when it is too old. */
  workspaceStatus(environmentId: string, sessionId: string): Promise<WorkspaceStatus>;
  /** One file's patch against HEAD. Fails with the daemon's reason, or when it is too old. */
  workspaceFile(environmentId: string, sessionId: string, path: string): Promise<WorkspacePatch>;
  /** A session's terminals, oldest first; none from a daemon that has none. */
  listTerminals(environmentId: string, sessionId: string): Promise<TerminalInfo[]>;
  /** Opens a shell in the session's folder, attached; or says why it could not. */
  createTerminal(
    environmentId: string,
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalAttached | { problem: TerminalProblem; message?: string }>;
  /**
   * The terminal's screen now; its output comes after as `terminal-output` events, in no fixed order against this
   * answer. A lost connection lets go of it: attach again once the environment is connected.
   */
  attachTerminal(environmentId: string, terminalId: string): Promise<TerminalAttached>;
  detachTerminal(environmentId: string, terminalId: string): Promise<void>;
  /** Keys and pastes, as they are. */
  terminalInput(environmentId: string, terminalId: string, data: string): Promise<void>;
  resizeTerminal(
    environmentId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void>;
  /** Ends the shell and everything running in it. */
  closeTerminal(environmentId: string, terminalId: string): Promise<void>;
  /**
   * The folders in a folder on that environment's machine, for choosing where a session works. Without a path: its
   * home. Fails with the daemon's reason (not a folder, cannot be read) or when the daemon is too old.
   */
  listFolders(environmentId: string, path?: string, hidden?: boolean): Promise<FolderListing>;
  /** Whether a folder on that environment's machine is trusted. Fails when the daemon is too old. */
  readTrust(environmentId: string, path: string): Promise<FolderTrust>;
  /** The latest plan usage of each agent on that environment, by agent id; none from an older daemon. */
  planUsage(environmentId: string): Promise<Record<string, PlanUsage>>;
  /** Records whether a folder on that environment's machine is trusted; the folders under it follow. */
  setTrust(environmentId: string, path: string, trusted: boolean): Promise<FolderTrust>;
  /** Takes a prompt back out of the queue, to be edited. Answers with its blocks; fails if it has gone. */
  ackReturn(environmentId: string, sessionId: string, returnId: string): Promise<void>;
  dequeue(environmentId: string, sessionId: string, queueId: string): Promise<PromptBlock[]>;
  setSessionConfig(
    environmentId: string,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  /** `where`: what the title was edited in, for the usage statistics. */
  renameSession(
    environmentId: string,
    sessionId: string,
    title: string,
    where?: "header" | "sidebar",
  ): Promise<void>;
  dismissBackground(environmentId: string, sessionId: string, taskIds: string[]): Promise<void>;
  /** Stops one sub-agent (CYCL-143). Only on an environment whose `capabilities.stopSubagent` is true. */
  stopSubagent(
    environmentId: string,
    sessionId: string,
    childId: string,
    background: boolean,
  ): Promise<void>;
  archiveSession(environmentId: string, sessionId: string, archived: boolean): Promise<void>;
  /** Says the session has been seen: its unread mark clears. Does nothing on a daemon that cannot. */
  markRead(environmentId: string, sessionId: string): Promise<void>;
  deleteSession(environmentId: string, sessionId: string): Promise<void>;
  answerPermission(key: string, optionId: string | "cancelled"): Promise<void>;
  answerForm(key: string, answer: FormAnswer): Promise<void>;

  agents(environmentId: string): Promise<AgentInfo[]>;
  agentDefaults(environmentId: string, agent: string): Promise<Record<string, string>>;
  setAgentDefaults(
    environmentId: string,
    agent: string,
    config: Record<string, string>,
  ): Promise<void>;

  /** The environment's connectors. Fails when it is not connected or its daemon is too old. */
  listConnectors(environmentId: string): Promise<ConnectorInfo[]>;
  addConnector(environmentId: string, draft: ConnectorDraft): Promise<ConnectorAnswer>;
  updateConnector(
    environmentId: string,
    id: string,
    change: ConnectorChange,
  ): Promise<ConnectorAnswer>;
  /** Removes a connector and its credentials for good. The page asks the person first. */
  removeConnector(
    environmentId: string,
    id: string,
  ): Promise<{ removed: true } | { problem: ConnectorProblem; message?: string }>;
  /**
   * Signs in to a connector in the person's browser. Resolves when it is done, refused, or cancelled (by the person in
   * the browser, by `cancelConnectorAuth`, by another sign-in starting, or after ten minutes).
   */
  authorizeConnector(
    environmentId: string,
    id: string,
  ): Promise<ConnectorAnswer | { cancelled: true }>;
  /** Stops the sign-in that is waiting for the browser, if there is one. */
  cancelConnectorAuth(): Promise<void>;
  /** Forgets the connector's token. */
  signOutConnector(environmentId: string, id: string): Promise<ConnectorAnswer>;
  /** An agent's installed plugins and where its plugins come from. Fails when it cannot be asked. */
  listPlugins(
    environmentId: string,
    agentId: string,
  ): Promise<{ sources: PluginSourceInfo[]; plugins: PluginInfo[] }>;
  /** What can be installed, a page at a time (`cursor` is the answer's `nextCursor`). */
  availablePlugins(
    environmentId: string,
    query: { agentId: string; sourceId?: string; query?: string; cursor?: string; limit?: number },
  ): Promise<{ plugins: PluginInfo[]; nextCursor?: string | undefined; total: number }>;
  /** Installs a plugin, which can run code on the environment's machine. The page asks the person first. */
  installPlugin(
    environmentId: string,
    agentId: string,
    id: string,
  ): Promise<{ plugin: PluginInfo } | PluginFailure>;
  /** Removes a plugin and what it brought, sign-ins included. The page asks the person first. */
  uninstallPlugin(
    environmentId: string,
    agentId: string,
    id: string,
  ): Promise<{ removed: true } | PluginFailure>;
  updatePlugin(
    environmentId: string,
    agentId: string,
    id: string,
  ): Promise<{ plugin: PluginInfo; updated: boolean } | PluginFailure>;
  setPluginEnabled(
    environmentId: string,
    agentId: string,
    id: string,
    enabled: boolean,
  ): Promise<{ plugin: PluginInfo } | PluginFailure>;
  /** Adds a place plugins come from. The page asks the person first. */
  addPluginSource(
    environmentId: string,
    agentId: string,
    location: string,
  ): Promise<{ source: PluginSourceInfo } | PluginFailure>;
  removePluginSource(
    environmentId: string,
    agentId: string,
    id: string,
  ): Promise<{ removed: true } | PluginFailure>;
  /** Fetches every source's list again. */
  refreshPluginSources(
    environmentId: string,
    agentId: string,
  ): Promise<{ refreshed: true } | PluginFailure>;

  /** A directory chosen by the user, or undefined if they cancelled. */
  chooseDirectory(): Promise<string | undefined>;
  /** Puts text on the clipboard (a command, an output); false when it did not (too large). The page has no clipboard of its own. */
  copyText(text: string): Promise<boolean>;

  updateState(): Promise<UpdateState>;
  /** Asks now, and answers with what it found (or why it could not). */
  checkForUpdate(): Promise<UpdateState>;
  /** Downloads the update that was found, checks it, and restarts the app as the new version. */
  installUpdate(): Promise<void>;
  /**
   * Updates the daemon of a remote environment by running `daemon.upgrade.command` on it over ssh. What is wrong comes
   * back in the environment's status (`daemon.upgrade.error`), not as a throw. `when` is the person's choice when
   * sessions there are working: interrupt them `now`, or stop the old daemon `later`, once they finish.
   */
  upgradeDaemon(environmentId: string, when?: "now" | "later"): Promise<void>;

  /** How the app looks and reads, as the person chose. */
  preferences(): Promise<PreferencesState>;
  /** Changes some of them, keeps them, and applies them (the theme at once, to the whole window). */
  setPreferences(change: Partial<Preferences>): Promise<PreferencesState>;

  /** Reports an event the page alone can see (docs/analytics.md). Never fails and says nothing when it is off. */
  track(event: string, props?: TrackProps): Promise<void>;
  analytics(): Promise<AnalyticsStatus>;
  /** The person's answer about usage statistics. It also means they have been told. */
  setAnalytics(enabled: boolean): Promise<AnalyticsStatus>;
};

/** Subscribes to events. Returns the function that stops it. */
export type AppEvents = (listener: (event: AppEvent) => void) => () => void;

export type CycleBridge = AppApi & { onEvent: AppEvents };

/** Every method of AppApi, as a value, so the preload and main agree on the channels without a list in each. */
export const API_METHODS = [
  "environments",
  "saveEnvironment",
  "removeEnvironment",
  "connect",
  "disconnect",
  "sessions",
  "createSession",
  "openSession",
  "prompt",
  "cancel",
  "dequeue",
  "ackReturn",
  "searchFiles",
  "listFiles",
  "readFile",
  "workspaceStatus",
  "workspaceFile",
  "listTerminals",
  "createTerminal",
  "attachTerminal",
  "detachTerminal",
  "terminalInput",
  "resizeTerminal",
  "closeTerminal",
  "listFolders",
  "readTrust",
  "planUsage",
  "setTrust",
  "setSessionConfig",
  "renameSession",
  "dismissBackground",
  "stopSubagent",
  "archiveSession",
  "markRead",
  "deleteSession",
  "answerPermission",
  "answerForm",
  "agents",
  "agentDefaults",
  "setAgentDefaults",
  "listConnectors",
  "addConnector",
  "updateConnector",
  "removeConnector",
  "authorizeConnector",
  "cancelConnectorAuth",
  "signOutConnector",
  "listPlugins",
  "availablePlugins",
  "installPlugin",
  "uninstallPlugin",
  "updatePlugin",
  "setPluginEnabled",
  "addPluginSource",
  "removePluginSource",
  "refreshPluginSources",
  "chooseDirectory",
  "copyText",
  "updateState",
  "checkForUpdate",
  "installUpdate",
  "upgradeDaemon",
  "preferences",
  "setPreferences",
  "track",
  "analytics",
  "setAnalytics",
] as const satisfies readonly (keyof AppApi)[];

export const channel = (method: string): string => `cycle:${method}`;
export const EVENT_CHANNEL = "cycle:event";
