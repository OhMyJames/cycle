// The contract between the Electron main process and the renderer. Types only: nothing here runs.
//
// The main process holds the connections and, for every session being watched, its conversation. The
// renderer asks, and is told of changes. A renderer that reloads asks again and is given the state
// whole: it does not depend on having been there for what came before.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { Conversation } from "./model/index.ts";

/**
 * How a remote location is reached. SSH is one way, not what "remote" means: another transport (a WebSocket) is
 * another `type`, and nothing but the one place that opens the channel reads it.
 */
export type LocationTransport = {
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
export type LocationConfig =
  | { id: string; name: string; kind: "local" }
  | { id: string; name: string; kind: "remote"; transport: LocationTransport };

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export type LocationStatus = {
  locationId: string;
  state: ConnectionState;
  error?: string;
  /**
   * What the daemon on the location can do beyond what every daemon does (docs/protocol.md §3). Absent until it has said: a
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
    /** Harness setup diagnostics, auth, and runtime config methods are there (docs/protocol.md §16). */
    agentSetup?: boolean;
    /** What agents keep in their homes can be read and its caches cleared (docs/protocol.md §16 "本地存储"). */
    storage?: boolean;
    /** An agent can be started ahead of its session (docs/protocol.md §16 "提前起进程"). */
    agentPrewarm?: boolean;
    /** An @ may name another of its sessions, which it gives the agent as a record (docs/protocol.md §8). */
    sessionMentions?: boolean;
    /** The session's folder can be listed and its files read, for the Files tab (docs/protocol.md §8). */
    fs?: boolean;
    /** The session's folder can be compared with HEAD, for the Diff tab's workspace view (docs/protocol.md §8). */
    diff?: boolean;
    /** Shells can be opened beside a session, for the Terminal tabs (docs/protocol.md §8 "终端"). */
    terminal?: boolean;
    /** A session can be made with an environment, and its actions run in a terminal (docs/protocol.md §6 "环境"). */
    environments?: boolean;
    /** A session can be made in a worktree, and the branches to start it from listed (docs/protocol.md §6 "Worktree"). */
    worktrees?: boolean;
    /** The vault, the keys of `secrets.env`, can be listed and changed (docs/protocol.md §6 "环境"). */
    vault?: boolean;
  };
  /**
   * The daemon on the location speaks another major version of Cycle's protocol, so the app cannot use it
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
  /** What the daemon on the location says it is. Not for the local one, which the app carries. */
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
  locationId: string;
  sessionId: string;
  cwd: string;
  title?: string;
  archived: boolean;
  agent: string;
  state: "running" | "idle" | "requires_action" | "stopped";
  lastSeq: number;
  /** News the person has not seen (`cycle/unread`, protocol 0.2). Absent from an older daemon: then nothing is unread. */
  unread?: boolean;
  /** How many background sub-agents and background tasks are working (`cycle/background`). Absent from an older daemon. */
  background?: number;
  unknownBackground?: string[];
  /**
   * When something last happened in the session (ISO 8601). Absent from a daemon older than protocol 0.2:
   * then the sessions of that daemon are ordered by `lastSeq`, which only compares within one daemon.
   */
  updatedAt?: string;
  /** What the session was set to, by name (the agent's settings). */
  config?: Record<string, string>;
  /** The environment it was made with, as the daemon keeps it: names only, never a variable's value. */
  environment?: SessionEnvironmentSummary;
  /** The worktree the session is in now (`cycle/worktree`); its `root` is the workspace it is listed under. */
  worktree?: WorktreeSummary;
};

/** Where a session's work is, apart from the main checkout (docs/protocol.md §6 "Worktree"). */
export type WorktreeSummary = {
  /** The main checkout it belongs to. */
  root: string;
  path: string;
  branch?: string;
  /** Cycle made it: its setup ran and its cleanup runs before it goes. */
  managed: boolean;
  /** What the setup script said when it failed. */
  setupFailed?: string;
};

/** The branches a worktree could start from. */
export type GitBranches = {
  branches: string[];
  current?: string | undefined;
  defaultBranch?: string | undefined;
};

/** What a session's worktree holds that nothing else does: a delete is refused until the person says to discard it. */
export type UnsavedWork = { files: string[]; commits: string[] };

/**
 * A command for each system, with a default for the others (docs/desktop.md "环境"). The daemon picks its own system's,
 * else the default, else runs none.
 */
export type EnvironmentScripts = {
  default?: string;
  macos?: string;
  linux?: string;
  windows?: string;
};

export type EnvironmentAction = {
  id: string;
  name: string;
  icon?: string;
  command: EnvironmentScripts;
};

/** A variable whose value is in `secrets.env` under `from` (else under its own name). */
export type EnvironmentSecret = { name: string; from?: string };

/**
 * A reusable setup for sessions: scripts, variables and actions. Defined once in the app, chosen per workspace, and sent
 * whole when a session is made (docs/desktop.md "环境"). Not where the session runs: that is its location.
 */
export type Environment = {
  id: string;
  name: string;
  /** Runs after a worktree is made. Cycle makes none yet: kept, not run. */
  setup?: EnvironmentScripts;
  /** Runs before a worktree is removed. Cycle makes none yet: kept, not run. */
  cleanup?: EnvironmentScripts;
  /** In order; names unique, none of the daemon's own (docs/protocol.md §6). Values may be secrets. */
  variables: { name: string; value: string }[];
  /**
   * Names only: the value is in `secrets.env` on the machine the session runs on. Given to terminals and actions, never to
   * the agent (docs/protocol.md §6). Share the names of `variables`.
   */
  secrets: EnvironmentSecret[];
  actions: EnvironmentAction[];
};

/** The environments, and the one each workspace starts with: `defaults[locationId][cwd]` is an environment's id. */
export type EnvironmentsState = {
  environments: Environment[];
  defaults: Record<string, Record<string, string>>;
};

/** What a session's list row says of its environment (`_meta["cycle/environment"]`). */
export type SessionEnvironmentSummary = {
  id: string;
  name: string;
  variableNames: string[];
  secretNames: string[];
  actions: { id: string; name: string; icon?: string }[];
};

/**
 * Why an environment cannot be saved or sent: a fixed word the page has a sentence for, with what it is about. The
 * daemon's own words for these are `reserved_variable`, `invalid_variable` and `too_large` (docs/protocol.md §6).
 */
export type EnvironmentProblem =
  | { problem: "name_missing" }
  | { problem: "invalid_variable"; name: string }
  | { problem: "duplicate_variable"; name: string }
  | { problem: "reserved_variable"; name: string }
  | { problem: "action_name_missing" }
  | { problem: "action_id_invalid" }
  | { problem: "action_command_missing"; action: string }
  | { problem: "too_large"; limit: number }
  | { problem: "invalid"; message: string };

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

export type AgentBinarySource = "builtin" | "configured" | "path" | "missing";
export type AgentBinaryProblem = "missing" | "version_too_old" | "probe_failed";
export type AgentBinaryStatus = {
  source: AgentBinarySource;
  path?: string | undefined;
  version?: string | undefined;
  minVersion?: string | undefined;
  problem?: AgentBinaryProblem | undefined;
};

export type AgentAuthState =
  | "binary_unavailable"
  | "signed_out"
  | "signing_in"
  | "signed_in"
  | "signing_out"
  | "auth_unknown";
export type AgentAuthUnknownReason = "network_error" | "timeout" | "probe_failed";
export type AgentAuthMethod =
  | "subscription"
  | "api_key"
  | "oauth_token"
  | "third_party"
  | "none"
  | "unknown";
export type AgentAuthMode = "browser" | "code" | "device_code";
export type AgentSignInMode = {
  mode: AgentAuthMode;
  requiresLocalLoopback: boolean;
};
export type AgentAccountInfo = {
  email?: string | undefined;
  organization?: string | undefined;
  plan?: string | undefined;
  expiresAt?: number | undefined;
  tierObservedAt?: number | undefined;
};
export type AgentAuthStatus = {
  state: AgentAuthState;
  unknownReason?: AgentAuthUnknownReason | undefined;
  method: AgentAuthMethod;
  viaEnv?: string | undefined;
  account?: AgentAccountInfo | undefined;
  signInModes: AgentSignInMode[];
  canSignOut: boolean;
  loginCommand: string;
};

export type AgentAuthProblemReason =
  | "binary_unavailable"
  | "auth_in_progress"
  | "parse_failed"
  | "invalid_code"
  | "expired"
  | "cancelled"
  | "process_failed"
  | "timeout"
  | "unsupported_mode"
  | "untrusted_url"
  | "flow_not_found"
  | "flow_forbidden"
  | "flow_consumed"
  | "flow_not_active"
  | "disconnected"
  | "failed";

export type AgentAuthStartAnswer =
  | {
      started: true;
      flowId: string;
      mode: AgentAuthMode;
      expiresAt: number;
      /** Verified hostname from the desktop's hardcoded allowlist, displayed in the confirmation dialog. */
      host?: string | undefined;
      /** True when the main process holds a verified URL ready to open on explicit user click. */
      hasUrl: boolean;
      userCode?: string | undefined;
    }
  | {
      started: false;
      reason: AgentAuthProblemReason;
    };

export type AgentAuthSubmitAnswer = { ok: true } | { ok: false; reason: AgentAuthProblemReason };

export type AgentAuthLogoutAnswer = { ok: true } | { ok: false; reason: AgentAuthProblemReason };

export type AgentRuntimeValue = boolean | number | string;
export type AgentRuntimePatchValue = AgentRuntimeValue | null;
export type AgentRuntimeSaveAnswer =
  | {
      saved: true;
      values: Record<string, AgentRuntimeValue>;
      overrides: string[];
      revision: number;
    }
  | {
      saved: false;
      problem: "revision_conflict" | "invalid_config" | "file_corrupt" | "failed";
      currentRevision?: number | undefined;
      field?: string | undefined;
      message?: string | undefined;
    };
export type AgentRuntimeSnapshot = {
  schemaVersion: 1;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
  };
  values: Record<string, AgentRuntimeValue>;
  overrides: string[];
  revision: number;
  fileError?: string | undefined;
};

export type AgentConfigFileStatus = {
  path: string;
  exists: boolean;
  stale: boolean;
  error?: string | undefined;
};
export type AgentRuntimeDiagnostics = {
  configFile: AgentConfigFileStatus;
  dataDir: string;
  customDataDir: boolean;
  allowEnv: string[];
  envNames: string[];
};

export type AgentSetupSnapshot = {
  agent: string;
  name: string;
  available: boolean;
  binary: AgentBinaryStatus;
  auth: AgentAuthStatus;
  planUsage?: PlanUsage | undefined;
  canRefreshUsage: boolean;
  runtime: AgentRuntimeSnapshot;
  environment: AgentRuntimeDiagnostics;
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
  | "unknown_action"
  | "failed";

/** What a location's machine has in a folder: names of folders only. `path` is the real path (links resolved). */
export type FolderListing = {
  path: string;
  parent: string | null;
  home: string;
  folders: { name: string }[];
  truncated: boolean;
};

/**
 * Whether a folder on a location's machine may run the commands its own configuration names (hooks, MCP helpers).
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

/** The protocols an endpoint of the owner's own may speak. */
export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/** The kind of a provider that is an endpoint the owner describes, not a known service. */
export const CUSTOM_PROVIDER_KIND = "custom";

/** One model of an owner's provider. */
export type ProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
  images: boolean;
  contextWindow: number;
  maxTokens: number;
};

/** A known service a provider can be for. */
export type ProviderKind = { id: string; name: string };

/**
 * A model provider of the owner's (docs/protocol.md §10 "自带模型"). Its key stays in the daemon: `hasKey` says there is
 * one, and nothing here can hold it.
 */
export type ProviderInfo = {
  id: string;
  name: string;
  kind: string;
  /** What a custom endpoint speaks. Null for a known service. */
  api: ProviderApi | null;
  /** A custom endpoint's address, or another address for a known service. */
  baseUrl: string | null;
  hasKey: boolean;
  models: ProviderModel[];
};

/**
 * What the owner sends to add a provider, or to change the one with this `id`. `apiKey` is written once: absent keeps
 * the key (at the same address), an empty string removes it.
 */
export type ProviderDraft = {
  id?: string | undefined;
  name: string;
  kind: string;
  api: ProviderApi | null;
  baseUrl: string | null;
  apiKey?: string | undefined;
  models: ProviderModel[];
};

/** Why a provider could not be saved or removed. `invalid`: the daemon refused what was sent (`message` says why). */
export type ProviderProblem = "invalid" | "not_found" | "failed";

export type ProviderAnswer =
  | { provider: ProviderInfo }
  | { problem: ProviderProblem; message?: string };

/** Why a vault key could not be set or removed. `invalid`: the daemon refused what was sent (`message` says why). */
export type VaultProblem = "invalid" | "failed";
export type VaultAnswer = { done: true } | { problem: VaultProblem; message?: string };

/** What an agent keeps in its home on a location's machine. `cache` can be cleared; `history` is only shown. */
export type StorageItem = { id: string; kind: "cache" | "history"; bytes: number };
export type StorageAgent = {
  agent: string;
  name: string;
  /** False when its home is the owner's own folder, outside the daemon's data folder: nothing is measured or cleared. */
  managed: boolean;
  items: StorageItem[];
};
/** Why nothing was cleared: `busy` a session of the agent is working, `unmanaged`, `unknown_agent`, `failed` nothing could be removed. */
export type StorageCleanProblem = "busy" | "unmanaged" | "unknown_agent" | "failed";
export type StorageCleanAnswer =
  | { cleaned: true; freedBytes: number }
  | { cleaned: false; problem: StorageCleanProblem; message: string };

/** A location's providers as last read: the ones the owner has, and the known services one can be made for. */
export type ProvidersRead = { providers: ProviderInfo[]; kinds: ProviderKind[] };

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
  /** Shipped with Cycle: it can be turned off, not uninstalled. */
  builtin?: boolean | undefined;
  /** Its picture as a `data:image/` URL: only a built-in plugin has one. */
  icon?: string | undefined;
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

/** Lists the folders of one location's folder (the location is already chosen). */
export type ListFolders = (path?: string, hidden?: boolean) => Promise<FolderListing>;

export type PermissionOption = { optionId: string; name: string; kind: string };

/** An agent asking the user. `key` names it in this app; answer it with `answerPermission`. */
export type PermissionRequest = {
  key: string;
  locationId: string;
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
  /** `source` (a release when absent): a GitHub release, or the alpha repository on this machine (then `commit` and `subject` say what it is). */
  | {
      kind: "available";
      version: string;
      source?: "release" | "local";
      commit?: string;
      subject?: string;
    }
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

/**
 * The person's Cycle account, as main tells the page (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md). Never a token: who is signed in,
 * and how the login stands.
 *
 * - `signed-out`: nobody, or the login has ended; `open` is false and the page shows the sign-in page.
 * - `signed-in`: the provider took the login the last time it was asked.
 * - `offline`: it could not be asked (no network, or it failed); the app is open within the 30 days' grace, and what
 *   needs the network is unavailable for now.
 * - `reauth`: the provider refused the login while the app was open. What is running goes on; the person is asked to
 *   sign in again.
 */
export type AccountStatus = {
  state: "signed-out" | "signed-in" | "offline" | "reauth";
  /** Whether the app may be used: false shows the sign-in page, and main refuses what the app does. */
  open: boolean;
  /** The browser is open on the sign-in page, and main waits for it. */
  signingIn: boolean;
  user?: { name: string; email: string };
  /** Why the sign-in page is shown, when it is not the first time or a sign-out. */
  reason?: "expired" | "revoked";
  /** What went wrong with the last sign-in: it failed, or the provider could not be reached. */
  problem?: "failed" | "unreachable";
  /** The last sign-in was someone else than the account before. */
  switched?: boolean;
};

/** What main tells the renderer. */
export type AppEvent =
  /** The account's status changed. */
  | { type: "account"; account: AccountStatus }
  | { type: "locations"; locations: LocationConfig[] }
  | ({ type: "location-status" } & LocationStatus)
  | { type: "sessions"; locationId: string; sessions: SessionSummary[] }
  | {
      type: "update";
      locationId: string;
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
      locationId: string;
      sessionId: string;
      key: string;
      version: number;
    }
  | { type: "agent-defaults"; locationId: string; agent: string }
  /** An agent's setup snapshot changed (runtime settings saved, login, or logout). */
  | { type: "agent-setup-changed"; locationId: string; agent: string; revision?: number }
  /** An in-app subscription sign-in flow initiated by this app finished or was interrupted. */
  | {
      type: "agent-auth-completed";
      locationId: string;
      flowId: string;
      agent: string;
      ok: boolean;
      reason?: AgentAuthProblemReason | undefined;
    }
  /** An agent on that location told how much of its account's plan limits is used. */
  | { type: "plan-usage"; locationId: string; agent: string; usage: PlanUsage }
  /** The location's connectors changed, here or elsewhere: read them again. */
  | { type: "connectors"; locationId: string }
  /** The location's model providers changed, here or elsewhere: read them, and its agents, again. */
  | { type: "providers"; locationId: string }
  /** An agent's plugins on that location changed, here or elsewhere: read them again. */
  | { type: "plugins"; locationId: string; agentId: string }
  /** A session was deleted elsewhere while the connection was away: nothing of it is kept. */
  | { type: "session-gone"; locationId: string; sessionId: string }
  | { type: "app-update"; state: UpdateState }
  /** A session's terminals, whole: one was opened, closed, renamed, resized or ended. */
  | { type: "terminals"; locationId: string; sessionId: string; terminals: TerminalInfo[] }
  /** Output of a terminal the app is attached to. Drop it if the screen in hand already holds `seq`. */
  | {
      type: "terminal-output";
      locationId: string;
      terminalId: string;
      seq: number;
      data: string;
    }
  /** The app fell behind a terminal's output: draw it again from `screen`, then take what comes after `seq`. */
  | {
      type: "terminal-reset";
      locationId: string;
      terminalId: string;
      seq: number;
      screen: string;
      cols: number;
      rows: number;
    }
  /** A notification was pressed: show this session. */
  | { type: "focus-session"; locationId: string; sessionId: string }
  /** A Loop notification was pressed: show this ticket on the Loop page. */
  | { type: "open-loop-ticket"; projectKey: string; identifier: string };

/** Whether the app reports how it is used (docs/analytics.md). `available` is false when there is nowhere to report to. */
export type AnalyticsStatus = { available: boolean; enabled: boolean; noticed: boolean };

/** Light or dark, or as the system is. */
export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The languages the interface has, or the system's when it is one of them (`languages.ts` has their words). */
export const LANGUAGE_CHOICES = ["system", "en-US", "zh-CN"] as const;
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number];

/**
 * What the person chose for how the app looks, reads and helps. Kept by main, in the app's own data (docs/desktop.md).
 * `promptSuggestions`: the agent suggests what to say next, shown in the empty message box (CYCL-225).
 */
export type Preferences = {
  theme: ThemeChoice;
  language: LanguageChoice;
  promptSuggestions: boolean;
  /** The agents (by id) whose new sessions start in a worktree unless the person says otherwise. Off for all until chosen. */
  worktreeAgents: string[];
};

/** The preferences, and the system's language as main reads it (`system` follows it). */
export type PreferencesState = Preferences & { systemLanguage: string };

/** What the page may say about itself: numbers, booleans and words. Main checks it against its dictionary. */
export type TrackProps = Record<string, string | number | boolean>;

/**
 * Why a session's environment was not taken: the daemon's `data.reason` of its `-32602` (docs/protocol.md §6 "环境"), or
 * `missing` (it was removed meanwhile) and `needs_fix` (it does not pass the daemon's rules) from main's own check. One list for main and the page.
 */
export const ENVIRONMENT_REFUSALS = [
  "reserved_variable",
  "invalid_variable",
  "missing_secret",
  "too_large",
  "invalid_environment",
  "missing",
  "needs_fix",
  // A worktree that could not be made (docs/protocol.md §6 "Worktree").
  "not_a_repository",
  "invalid_name",
  "invalid_base",
] as const;
export type EnvironmentRefusal = {
  reason: (typeof ENVIRONMENT_REFUSALS)[number];
  /**
   * The variable it is about, for `reserved_variable`, `invalid_variable` and `missing_secret` (never its value); the environment's name,
   * for `needs_fix`.
   */
  name?: string;
};

/**
 * `environmentId`: one of the app's environments, sent whole with the session (main reads it from what it keeps). Only to
 * a daemon with `capabilities.environments`.
 */
export type NewSession = {
  cwd: string;
  agent?: string;
  config?: Record<string, string>;
  environmentId?: string;
  /** Make a worktree from this branch (the remote's default when absent) and run in it. Only to a local daemon with `capabilities.worktrees`. */
  worktree?: { base?: string };
};

/**
 * What sent a message: Enter, the ⌘Enter shortcut, or a button in the composer. The words of `prompt_sent.via` in
 * `@cycle/analytics/events` (this file may import nothing of it), which main checks them against.
 */
export type SendVia = "enter" | "shortcut" | "button";

/** What the renderer asks of main. Every method can fail; the renderer shows the message. */
export type AppApi = {
  /**
   * Every location, how its connection stands, and the last list of sessions main read from each: a location that is
   * away still has its last list, which is shown greyed. Only for as long as the app runs: one that could not be
   * reached since it started has none.
   */
  locations(): Promise<{
    locations: LocationConfig[];
    status: LocationStatus[];
    sessions: Record<string, SessionSummary[]>;
  }>;
  saveLocation(location: LocationConfig): Promise<void>;
  removeLocation(locationId: string): Promise<void>;
  connect(locationId: string): Promise<void>;
  disconnect(locationId: string): Promise<void>;

  sessions(locationId: string): Promise<SessionSummary[]>;
  /** The new session's id; or, when its environment was not taken, why (nothing was made). */
  createSession(
    locationId: string,
    params: NewSession,
  ): Promise<string | { problem: EnvironmentRefusal }>;
  /** Starts watching a session and returns it whole. Call again after a reload. */
  openSession(locationId: string, sessionId: string): Promise<SessionSnapshot>;
  /**
   * A text, or blocks: text and images. `steer`: into the running turn rather than the queue. `via`: what the person
   * pressed, for the count of how messages are sent (never their content).
   */
  prompt(
    locationId: string,
    sessionId: string,
    content: string | PromptBlock[],
    options?: { steer?: boolean; via?: SendVia },
  ): Promise<void>;
  cancel(locationId: string, sessionId: string): Promise<void>;
  /**
   * Files and folders of the session's folder, on the machine of the daemon, that fit what was typed after an @. A blank
   * conversation has no session yet and gives its folder: only a daemon with `filesInFolder` takes that.
   */
  searchFiles(
    locationId: string,
    where: { sessionId: string } | { cwd: string },
    query: string,
  ): Promise<FileSearch>;
  /** One folder of a session's folder, `path` relative to it. Fails with the daemon's reason, or when it is too old. */
  listFiles(locationId: string, sessionId: string, path: string): Promise<FileListing>;
  /** A file of a session's folder, text from `offset`. Fails with the daemon's reason, or when it is too old. */
  readFile(
    locationId: string,
    sessionId: string,
    path: string,
    offset?: number,
  ): Promise<FileContent>;
  /** Which files of a session's folder differ from HEAD. Fails with the daemon's reason, or when it is too old. */
  workspaceStatus(locationId: string, sessionId: string): Promise<WorkspaceStatus>;
  /** One file's patch against HEAD. Fails with the daemon's reason, or when it is too old. */
  workspaceFile(locationId: string, sessionId: string, path: string): Promise<WorkspacePatch>;
  /** A session's terminals, oldest first; none from a daemon that has none. */
  listTerminals(locationId: string, sessionId: string): Promise<TerminalInfo[]>;
  /**
   * Opens a shell in the session's folder, attached; or says why it could not. `actionId`: runs that action of the
   * session's environment in it instead (a daemon with `capabilities.environments`).
   */
  createTerminal(
    locationId: string,
    sessionId: string,
    cols: number,
    rows: number,
    actionId?: string,
  ): Promise<TerminalAttached | { problem: TerminalProblem; message?: string }>;
  /**
   * The terminal's screen now; its output comes after as `terminal-output` events, in no fixed order against this
   * answer. A lost connection lets go of it: attach again once the location is connected.
   */
  attachTerminal(locationId: string, terminalId: string): Promise<TerminalAttached>;
  detachTerminal(locationId: string, terminalId: string): Promise<void>;
  /** Keys and pastes, as they are. */
  terminalInput(locationId: string, terminalId: string, data: string): Promise<void>;
  resizeTerminal(locationId: string, terminalId: string, cols: number, rows: number): Promise<void>;
  /** Ends the shell and everything running in it. */
  closeTerminal(locationId: string, terminalId: string): Promise<void>;
  /**
   * The folders in a folder on that location's machine, for choosing where a session works. Without a path: its
   * home. Fails with the daemon's reason (not a folder, cannot be read) or when the daemon is too old.
   */
  listFolders(locationId: string, path?: string, hidden?: boolean): Promise<FolderListing>;
  /** Whether a folder on that location's machine is trusted. Fails when the daemon is too old. */
  readTrust(locationId: string, path: string): Promise<FolderTrust>;
  /** The latest plan usage of each agent on that location, by agent id; none from an older daemon. */
  planUsage(locationId: string): Promise<Record<string, PlanUsage>>;
  /** Records whether a folder on that location's machine is trusted; the folders under it follow. */
  setTrust(locationId: string, path: string, trusted: boolean): Promise<FolderTrust>;
  /** Takes a prompt back out of the queue, to be edited. Answers with its blocks; fails if it has gone. */
  ackReturn(locationId: string, sessionId: string, returnId: string): Promise<void>;
  dequeue(locationId: string, sessionId: string, queueId: string): Promise<PromptBlock[]>;
  setSessionConfig(
    locationId: string,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  /** `where`: what the title was edited in, for the usage statistics. */
  renameSession(
    locationId: string,
    sessionId: string,
    title: string,
    where?: "header" | "sidebar",
  ): Promise<void>;
  dismissBackground(locationId: string, sessionId: string, taskIds: string[]): Promise<void>;
  /**
   * Stops one sub-agent (CYCL-143). Only on a location whose `capabilities.stopSubagent` is true. False: there was
   * nothing to stop (the daemon's `stopping: false`).
   */
  stopSubagent(
    locationId: string,
    sessionId: string,
    childId: string,
    background: boolean,
  ): Promise<boolean>;
  archiveSession(locationId: string, sessionId: string, archived: boolean): Promise<void>;
  /** Says the session has been seen: its unread mark clears. Does nothing on a daemon that cannot. */
  markRead(locationId: string, sessionId: string): Promise<void>;
  /**
   * Deletes a session. A worktree Cycle made for it that holds unsaved work is not removed unless `discardWorktree`:
   * the answer is then what would be lost, for the person to confirm.
   */
  deleteSession(
    locationId: string,
    sessionId: string,
    discardWorktree?: boolean,
  ): Promise<{ unsaved: UnsavedWork } | undefined>;
  /** The branches a worktree for a session in `cwd` could start from; null when `cwd` is not in a git repository. */
  gitBranches(locationId: string, cwd: string): Promise<GitBranches | null>;
  answerPermission(key: string, optionId: string | "cancelled"): Promise<void>;
  answerForm(key: string, answer: FormAnswer): Promise<void>;

  agents(locationId: string): Promise<AgentInfo[]>;
  agentDefaults(locationId: string, agent: string): Promise<Record<string, string>>;
  setAgentDefaults(
    locationId: string,
    agent: string,
    config: Record<string, string>,
  ): Promise<void>;
  /** Read-only status, auth, runtime config, and host diagnostics for one agent (docs/protocol.md §16). */
  readAgentSetup(
    locationId: string,
    agent: string,
    options?: { refreshUsage?: boolean; forceRefresh?: boolean },
  ): Promise<AgentSetupSnapshot>;
  /** Patches hot-reloadable runtime settings (`null` unsets an override) with per-agent optimistic concurrency. */
  setAgentRuntimeSettings(
    locationId: string,
    agent: string,
    patch: Record<string, AgentRuntimePatchValue>,
    expectedRevision: number,
  ): Promise<AgentRuntimeSaveAnswer>;
  /**
   * The blank conversation chose this agent: start it ahead, when its location can, so the first message does not wait
   * for it. Never fails, and says nothing: the session starts its own agent if this did not come to anything.
   */
  prewarmAgent(locationId: string, agent: string): Promise<void>;
  /** Shows the local daemon's `config.json` in the system file manager; returns false on remote locations. */
  revealDaemonConfig(locationId: string): Promise<boolean>;
  /** Starts an in-app subscription sign-in flow; chooses mode by transport and validates URLs against hardcoded allowlist. */
  startAgentAuth(locationId: string, agent: string): Promise<AgentAuthStartAnswer>;
  /** Opens the main-process-verified auth URL for `flowId` in the system browser after explicit user click. */
  openAgentAuthUrl(locationId: string, flowId: string): Promise<boolean>;
  /** Submits a one-time hosted-callback authorization code for a `"code"` mode flow (memory-only). */
  submitAgentAuth(locationId: string, flowId: string, code: string): Promise<AgentAuthSubmitAnswer>;
  /** Cancels an active in-app sign-in flow. */
  cancelAgentAuth(locationId: string, flowId: string): Promise<void>;
  /** Signs out an agent's subscription on the daemon (the UI asks the person first). */
  logoutAgent(locationId: string, agent: string): Promise<AgentAuthLogoutAnswer>;

  /** The location's connectors. Fails when it is not connected or its daemon is too old. */
  listConnectors(locationId: string): Promise<ConnectorInfo[]>;
  addConnector(locationId: string, draft: ConnectorDraft): Promise<ConnectorAnswer>;
  updateConnector(
    locationId: string,
    id: string,
    change: ConnectorChange,
  ): Promise<ConnectorAnswer>;
  /** Removes a connector and its credentials for good. The page asks the person first. */
  removeConnector(
    locationId: string,
    id: string,
  ): Promise<{ removed: true } | { problem: ConnectorProblem; message?: string }>;
  /**
   * Signs in to a connector in the person's browser. Resolves when it is done, refused, or cancelled (by the person in
   * the browser, by `cancelConnectorAuth`, by another sign-in starting, or after ten minutes).
   */
  authorizeConnector(
    locationId: string,
    id: string,
  ): Promise<ConnectorAnswer | { cancelled: true }>;
  /** Stops the sign-in that is waiting for the browser, if there is one. */
  cancelConnectorAuth(): Promise<void>;
  /** Forgets the connector's token. */
  signOutConnector(locationId: string, id: string): Promise<ConnectorAnswer>;
  /** What each agent keeps in its home on the location. Fails when it is not connected or its daemon is too old. */
  readStorage(locationId: string): Promise<StorageAgent[]>;
  /** Clears one agent's caches (never its logins or histories). The page asks the person first. */
  cleanStorage(locationId: string, agent: string): Promise<StorageCleanAnswer>;
  /** The location's model providers (keys named, never given). Fails when it is not connected or its daemon is too old. */
  listProviders(locationId: string): Promise<ProvidersRead>;
  /** The models a known service is known to serve. Fails when it cannot be asked. */
  providerCatalog(locationId: string, kind: string): Promise<ProviderModel[]>;
  /** Adds a provider, or changes the one the draft's `id` names. The key goes to the daemon and is not kept here. */
  saveProvider(locationId: string, draft: ProviderDraft): Promise<ProviderAnswer>;
  /** Removes a provider and its key for good. The page asks the person first. */
  removeProvider(
    locationId: string,
    id: string,
  ): Promise<{ removed: true } | { problem: ProviderProblem; message?: string }>;
  /** The keys the location's vault (`secrets.env`) has a value for: names, never values. Fails when it cannot be asked. */
  listVault(locationId: string): Promise<string[]>;
  /** Adds the key or replaces its value. The value goes to the daemon and is not kept here. */
  setVaultItem(locationId: string, key: string, value: string): Promise<VaultAnswer>;
  /** Removes the key and its value for good. The page asks the person first. */
  removeVaultItem(locationId: string, key: string): Promise<VaultAnswer>;
  /** An agent's installed plugins and where its plugins come from. Fails when it cannot be asked. */
  listPlugins(
    locationId: string,
    agentId: string,
  ): Promise<{ sources: PluginSourceInfo[]; plugins: PluginInfo[] }>;
  /** What can be installed, a page at a time (`cursor` is the answer's `nextCursor`). */
  availablePlugins(
    locationId: string,
    query: { agentId: string; sourceId?: string; query?: string; cursor?: string; limit?: number },
  ): Promise<{ plugins: PluginInfo[]; nextCursor?: string | undefined; total: number }>;
  /** Installs a plugin, which can run code on the location's machine. The page asks the person first. */
  installPlugin(
    locationId: string,
    agentId: string,
    id: string,
  ): Promise<{ plugin: PluginInfo } | PluginFailure>;
  /** Removes a plugin and what it brought, sign-ins included. The page asks the person first. */
  uninstallPlugin(
    locationId: string,
    agentId: string,
    id: string,
  ): Promise<{ removed: true } | PluginFailure>;
  updatePlugin(
    locationId: string,
    agentId: string,
    id: string,
  ): Promise<{ plugin: PluginInfo; updated: boolean } | PluginFailure>;
  setPluginEnabled(
    locationId: string,
    agentId: string,
    id: string,
    enabled: boolean,
  ): Promise<{ plugin: PluginInfo } | PluginFailure>;
  /** Adds a place plugins come from. The page asks the person first. */
  addPluginSource(
    locationId: string,
    agentId: string,
    location: string,
  ): Promise<{ source: PluginSourceInfo } | PluginFailure>;
  removePluginSource(
    locationId: string,
    agentId: string,
    id: string,
  ): Promise<{ removed: true } | PluginFailure>;
  /** Fetches every source's list again. */
  refreshPluginSources(
    locationId: string,
    agentId: string,
  ): Promise<{ refreshed: true } | PluginFailure>;

  /** A directory chosen by the user, or undefined if they cancelled. */
  chooseDirectory(): Promise<string | undefined>;
  /** Puts text on the clipboard (a command, an output); false when it did not (too large). The page has no clipboard of its own. */
  copyText(text: string): Promise<boolean>;
  /**
   * Puts a picture on the clipboard: a PNG or JPEG the page already has, as base64 (the page turns any other kind into a
   * PNG first). False when it did not: not one of those, or too large.
   */
  copyImage(type: string, data: string): Promise<boolean>;
  /**
   * Saves a picture the page already has (base64 of one of the image types it shows) to a file the person picks in the
   * system's save dialog, offered under `name`. Main writes only where they chose.
   */
  saveImage(name: string, type: string, data: string): Promise<ImageSaved>;

  updateState(): Promise<UpdateState>;
  /** Asks now, and answers with what it found (or why it could not). */
  checkForUpdate(): Promise<UpdateState>;
  /** Downloads the update that was found, checks it, and restarts the app as the new version. */
  installUpdate(): Promise<void>;
  /**
   * Updates the daemon of a remote location by running `daemon.upgrade.command` on it over ssh. What is wrong comes
   * back in the location's status (`daemon.upgrade.error`), not as a throw. `when` is the person's choice when
   * sessions there are working: interrupt them `now`, or stop the old daemon `later`, once they finish.
   */
  upgradeDaemon(locationId: string, when?: "now" | "later"): Promise<void>;

  /** The environments and each workspace's default, as main keeps them (`environments.json`). */
  environments(): Promise<EnvironmentsState>;
  /** Adds or replaces one, by id. Checked first: what is wrong comes back, and nothing is kept. */
  saveEnvironment(
    environment: Environment,
  ): Promise<{ state: EnvironmentsState } | EnvironmentProblem>;
  /** Removes one, and the workspace defaults that name it. Sessions made with it keep their own copy. */
  removeEnvironment(environmentId: string): Promise<EnvironmentsState>;
  /** The environment a workspace starts with from now on; null: none. */
  setEnvironmentDefault(
    locationId: string,
    cwd: string,
    environmentId: string | null,
  ): Promise<EnvironmentsState>;

  /** How the app looks and reads, as the person chose. */
  preferences(): Promise<PreferencesState>;
  /** Changes some of them, keeps them, and applies them (the theme at once, to the whole window). */
  setPreferences(change: Partial<Preferences>): Promise<PreferencesState>;

  /** How the person's account stands. */
  account(): Promise<AccountStatus>;
  /** Opens the sign-in page in the browser, and answers once it has come back, been stopped, or failed. */
  signIn(): Promise<AccountStatus>;
  /** Stops waiting for the browser. */
  cancelSignIn(): Promise<void>;
  /** Ends the login (the page asks the person first). Local sessions, settings and connectors stay. */
  signOut(): Promise<void>;

  /** Reports an event the page alone can see (docs/analytics.md). Never fails and says nothing when it is off. */
  track(event: string, props?: TrackProps): Promise<void>;
  analytics(): Promise<AnalyticsStatus>;
  /** The person's answer about usage statistics. It also means they have been told. */
  setAnalytics(enabled: boolean): Promise<AnalyticsStatus>;

  /** The Projects the Loop server on this computer serves (docs/protocol.md §17). */
  loopProjects(): Promise<LoopProjectsAnswer>;
  /** One Project's itsaplan board, read with the person's own key, which stays in the main process. */
  loopBoard(projectKey: string): Promise<LoopBoardAnswer>;
  /** One ticket's body, acceptance criteria and PR/MR links, read with the person's own key. */
  loopTicket(projectKey: string, identifier: string): Promise<LoopTicketAnswer>;
  /** What needs a person in a Project: Blocked tickets, escalated reviews, sessions waiting on an answer (§17). */
  loopNotices(projectKey: string): Promise<LoopNoticesAnswer>;
  /**
   * Opens a conversation with an agent about a Backlog or Todo ticket (CYC-389): main reads the ticket again, takes the
   * default model of the agent, makes the session with the ticket's number in its first message.
   */
  loopChat(projectKey: string, identifier: string): Promise<LoopChatResult>;
  /**
   * Changes one ticket's state with the person's own key. `approve` writes nothing unless `confirmed` is true: main
   * refuses it, whatever the page did. Never throws for a failed write: the reason comes back.
   */
  loopAct(
    projectKey: string,
    identifier: string,
    action: LoopAction,
    confirmed?: boolean,
  ): Promise<LoopActResult>;
};

/** A Project of the Loop server: what `projects/list` says, and nothing secret. */
export type LoopProjectInfo = {
  name: string;
  projectKey: string;
  repo: { displayName: string; forge: "github" | "gitlab" };
};

/** `disconnected`: no Loop server answered on this computer. */
export type LoopProjectsAnswer =
  | { kind: "ok"; projects: LoopProjectInfo[] }
  | { kind: "disconnected" };

export type LoopTicket = {
  /** `CYC-386`. */
  identifier: string;
  title: string;
  priority: string | null;
  /** The name of the board column it is in (In Progress, In Review, Blocked...). */
  column: string;
  /** The buttons this ticket gets, from its column and label (main decides; the page only draws them). */
  actions: LoopAction[];
  /**
   * What the person can do with an agent here (main decides from the column): `new` a conversation about it (Backlog,
   * Todo); `watch` only look, as In Progress is taken to be Loop's (a ticket Loop left there when it died is too: CYC-390
   * corrects it); `none` neither.
   */
  chat: LoopChat;
};

export type LoopChat = "new" | "watch" | "none";

/** Why a conversation was not made: fixed words. `needs_model`: the agent's default model is not set (Settings). */
export type LoopChatFailure =
  | "needs_model"
  | "not_allowed"
  | "no_key"
  | "offline"
  | "refused"
  | "failed"
  | "no_folder"
  | "auth_required";
export type LoopChatResult =
  | { kind: "started"; locationId: string; sessionId: string }
  /** `sessionId`: the session was made but its first message did not go; it can be opened. */
  | { kind: "failed"; reason: LoopChatFailure; sessionId?: string; locationId?: string };

/** `approve`: Backlog to Todo with `auto`. `to_backlog`: back to Backlog, `auto` off. `to_todo`: back to Todo. */
export type LoopAction = "approve" | "to_backlog" | "to_todo";

/** Why a write did not happen: fixed words, never the tracker's text. */
export type LoopActFailure =
  | "unconfirmed"
  | "no_key"
  | "forbidden"
  | "conflict"
  | "not_allowed"
  | "offline"
  | "refused";
export type LoopActResult = { kind: "ok" } | { kind: "failed"; reason: LoopActFailure };

/** One thing that needs a person. Order on the page: `permission`, then `blocked`, then `review`. */
export type LoopNotice =
  /** A Dev session of a ticket waits on a permission or a form. */
  | {
      kind: "permission";
      identifier: string;
      locationId: string;
      sessionId: string;
    }
  /** A ticket in Blocked; `reason` is Loop's own words from its comment (may be empty when it cannot be read). */
  | { kind: "blocked"; identifier: string; title: string; reason: string }
  /** A ticket whose review was escalated to a person. */
  | { kind: "review"; identifier: string; title: string; conclusion: string };
export type LoopNoticesAnswer =
  | { kind: "ok"; notices: LoopNotice[] }
  | { kind: "no_key" }
  | { kind: "unreachable" };

export type LoopTicketDetail = LoopTicket & {
  /** Why a Blocked or escalated ticket needs a person, from Loop's comment on it. */
  attention?: {
    kind: "blocked" | "review";
    /** The reason (blocked) or the review's conclusion (review), as Loop wrote it. */
    text: string;
    /** The title of the Dev session to join, `[CYC-1] Dev`. */
    session?: string;
    /** The PR/MR the review is about. */
    prUrl?: string;
  };
  /** The ticket's text as written (Markdown). */
  body: string;
  /** The items of its acceptance criteria section, one per line. */
  acceptance: string[];
  /** Pull or merge request addresses (https only). */
  links: string[];
};
export type LoopTicketAnswer =
  | { kind: "ok"; ticket: LoopTicketDetail }
  | { kind: "no_key" }
  | { kind: "unreachable" };

/** One column of the Project's board, as itsaplan has it. `more`: the column has tickets that are not listed (a completed column lists the newest 20). */
export type LoopBoardColumn = {
  id: number;
  name: string;
  stateType: string;
  tickets: LoopTicket[];
  more: boolean;
};
/** The Project's columns in the tracker's board order, Canceled left out. */
export type LoopBoardAnswer =
  | { kind: "ok"; columns: LoopBoardColumn[] }
  /** There is no key file, or it is readable by others. */
  | { kind: "no_key" }
  /** The tracker did not answer, or refused the key. */
  | { kind: "unreachable" };

/** What came of saving a picture: written, the person closed the dialog, or it could not be (not a picture, a disk error). */
export type ImageSaved = "saved" | "cancelled" | "failed";

/** Subscribes to events. Returns the function that stops it. */
export type AppEvents = (listener: (event: AppEvent) => void) => () => void;

export type CycleBridge = AppApi & { onEvent: AppEvents };

/**
 * Every method of AppApi, once each, as an object of its keys: a method added to AppApi and not here, or here and
 * not there, is a type error. So the preload and main agree on the channels without a list in each.
 */
const METHODS: { readonly [method in keyof AppApi]-?: true } = {
  locations: true,
  saveLocation: true,
  removeLocation: true,
  connect: true,
  disconnect: true,
  sessions: true,
  createSession: true,
  openSession: true,
  prompt: true,
  cancel: true,
  dequeue: true,
  ackReturn: true,
  searchFiles: true,
  listFiles: true,
  readFile: true,
  workspaceStatus: true,
  workspaceFile: true,
  listTerminals: true,
  createTerminal: true,
  attachTerminal: true,
  detachTerminal: true,
  terminalInput: true,
  resizeTerminal: true,
  closeTerminal: true,
  listFolders: true,
  readTrust: true,
  planUsage: true,
  setTrust: true,
  setSessionConfig: true,
  renameSession: true,
  dismissBackground: true,
  stopSubagent: true,
  archiveSession: true,
  markRead: true,
  deleteSession: true,
  gitBranches: true,
  answerPermission: true,
  answerForm: true,
  agents: true,
  agentDefaults: true,
  setAgentDefaults: true,
  readAgentSetup: true,
  setAgentRuntimeSettings: true,
  prewarmAgent: true,
  revealDaemonConfig: true,
  startAgentAuth: true,
  openAgentAuthUrl: true,
  submitAgentAuth: true,
  cancelAgentAuth: true,
  logoutAgent: true,
  listConnectors: true,
  addConnector: true,
  updateConnector: true,
  removeConnector: true,
  authorizeConnector: true,
  cancelConnectorAuth: true,
  signOutConnector: true,
  listProviders: true,
  readStorage: true,
  cleanStorage: true,
  providerCatalog: true,
  saveProvider: true,
  removeProvider: true,
  listVault: true,
  setVaultItem: true,
  removeVaultItem: true,
  listPlugins: true,
  availablePlugins: true,
  installPlugin: true,
  uninstallPlugin: true,
  updatePlugin: true,
  setPluginEnabled: true,
  addPluginSource: true,
  removePluginSource: true,
  refreshPluginSources: true,
  chooseDirectory: true,
  copyText: true,
  copyImage: true,
  saveImage: true,
  updateState: true,
  checkForUpdate: true,
  installUpdate: true,
  upgradeDaemon: true,
  environments: true,
  saveEnvironment: true,
  removeEnvironment: true,
  setEnvironmentDefault: true,
  preferences: true,
  setPreferences: true,
  account: true,
  signIn: true,
  cancelSignIn: true,
  signOut: true,
  track: true,
  analytics: true,
  setAnalytics: true,
  loopProjects: true,
  loopBoard: true,
  loopTicket: true,
  loopAct: true,
  loopChat: true,
  loopNotices: true,
};

export type ApiMethod = keyof AppApi;
export const API_METHODS = Object.keys(METHODS) as readonly ApiMethod[];

export const channel = (method: string): string => `cycle:${method}`;
export const EVENT_CHANNEL = "cycle:event";
