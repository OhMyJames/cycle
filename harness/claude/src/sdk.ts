import {
  archiveSession,
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  query,
  renameSession,
  unarchiveSession,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  WireAccountInfo,
  WireContextUsage,
  WireHistoryMessage,
  WireMcpServerStatus,
  WireMessage,
  WireModelInfo,
  WireRewindFilesResult,
  WireSlashCommand,
  WirePermissionResult,
  WirePermissionUpdate,
  WireSessionInfo,
  WireUserMessage,
} from "./wire.ts";

/** A process the SDK was given in place of one it starts itself. */
export interface SpawnedProcess {
  stdin: unknown;
  stdout: unknown;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: string): boolean;
  on(event: string, listener: (...args: never[]) => void): void;
  once(event: string, listener: (...args: never[]) => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
}

/** What the harness starts a Claude Code process with: the SDK's options it uses, and no others. */
export interface QueryOptions {
  cwd: string;
  env: Record<string, string>;
  model?: string;
  effort?: string;
  /** The id a new session takes. */
  sessionId?: string;
  /** The stored session to continue, and the entry to cut it after first. */
  resume?: string;
  resumeSessionAt?: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  allowDangerouslySkipPermissions?: boolean;
  sandbox?: { enabled: boolean; autoAllowBashIfSandboxed: boolean };
  includePartialMessages: boolean;
  /** Helper agents' text and reasoning come too, not only their tool calls. */
  forwardSubagentText?: boolean;
  /** Tasks are stopped one by one, so stopping a turn leaves those in the background running. */
  perTaskStopAffordance?: boolean;
  /** Keeps a copy of each file before the agent changes it, so `rewindFiles` can put it back. */
  enableFileCheckpointing?: boolean;
  /** Folders beyond `cwd` the session may reach. */
  additionalDirectories?: string[];
  settingSources: ("user" | "project" | "local")[];
  /** A settings file, the flag layer. Only its path goes on the command line. */
  settings?: string;
  /** Tools it may not use, by name. Names only: they go on the command line. */
  disallowedTools?: string[];
  /** Plugin folders, handed over its pipe with `pluginDelivery: "initialize"`. */
  plugins?: { type: "local"; path: string }[];
  pluginDelivery?: "initialize";
  systemPrompt: { type: "preset"; preset: "claude_code" };
  canUseTool?: (
    tool: string,
    input: Record<string, unknown>,
    context: {
      signal: AbortSignal;
      suggestions?: WirePermissionUpdate[];
      title?: string;
      decisionReason?: string;
      toolUseID: string;
    },
  ) => Promise<WirePermissionResult>;
  pathToClaudeCodeExecutable?: string;
  spawnClaudeCodeProcess?: (options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => SpawnedProcess;
  stderr?: (data: string) => void;
}

/** A running Claude Code process: its stream, and what can be asked of it meanwhile. */
export interface ClaudeQuery extends AsyncIterable<WireMessage> {
  /** Answers once the process is up, with what it offers. Fails if it could not start. */
  initializationResult(): Promise<{
    models?: WireModelInfo[];
    commands?: WireSlashCommand[];
    account?: WireAccountInfo;
  }>;
  interrupt(): Promise<unknown>;
  /** Stops one task. Its news, that it stopped, follows on the stream. */
  stopTask(taskId: string): Promise<void>;
  accountInfo(): Promise<WireAccountInfo>;
  supportedCommands(): Promise<WireSlashCommand[]>;
  mcpServerStatus(): Promise<WireMcpServerStatus[]>;
  /** `summary` answers from the last request's usage, with no request of its own. */
  getContextUsage(options: { detail: "summary" | "full" }): Promise<WireContextUsage>;
  rewindFiles(userMessageId: string, options: { dryRun: boolean }): Promise<WireRewindFilesResult>;
  /** Sets the MCP servers given to this process alone, over its own pipe. */
  setMcpServers(servers: Record<string, unknown>): Promise<unknown>;
  /** Merges settings into this process's flag layer, over its own pipe. */
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  /** Loads its plugins again, and answers which it has. Waits while a turn runs. */
  reloadPlugins(): Promise<{
    plugins: { name: string; path: string; source?: string; version?: string }[];
  }>;
  close(): void;
}

interface InFolder {
  dir?: string;
}

/** The Claude Agent SDK as this harness uses it, so a test can stand in for it. */
export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<WireUserMessage>; options: QueryOptions }): ClaudeQuery;
  listSessions(options?: { limit?: number }): Promise<WireSessionInfo[]>;
  getSessionInfo(sessionId: string, options?: InFolder): Promise<WireSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: InFolder): Promise<WireHistoryMessage[]>;
  /** The helper agents a stored session ran, by id. */
  listSubagents(sessionId: string, options?: InFolder): Promise<string[]>;
  /** What one helper agent of a stored session said and did. */
  getSubagentMessages(
    sessionId: string,
    agentId: string,
    options?: InFolder,
  ): Promise<WireHistoryMessage[]>;
  forkSession(
    sessionId: string,
    options?: InFolder & { upToMessageId?: string },
  ): Promise<{ sessionId: string }>;
  renameSession(sessionId: string, title: string, options?: InFolder): Promise<void>;
  archiveSession(sessionId: string, options?: InFolder): Promise<void>;
  unarchiveSession(sessionId: string, options?: InFolder): Promise<void>;
  deleteSession(sessionId: string, options?: InFolder): Promise<void>;
}

/**
 * The SDK finds a Claude Code home in the environment, and reads it as it is called. One call at a
 * time is given a home, so two homes are never read as one.
 */
let reading: Promise<unknown> = Promise.resolve();

/** Runs `use` with the SDK pointed at `home`, after every call before it has finished. */
export function withHome<T>(home: string, use: () => T | Promise<T>): Promise<T> {
  const next = reading.then(async () => {
    const before = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = home;
    try {
      return await use();
    } finally {
      if (before === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = before;
    }
  });
  reading = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** The SDK as it reads one home: its session calls are given that home, one at a time. */
export function atHome(sdk: ClaudeSdk, home: string): ClaudeSdk {
  return {
    query: (params) => sdk.query(params),
    listSessions: (options) => withHome(home, () => sdk.listSessions(options)),
    getSessionInfo: (sessionId, options) =>
      withHome(home, () => sdk.getSessionInfo(sessionId, options)),
    getSessionMessages: (sessionId, options) =>
      withHome(home, () => sdk.getSessionMessages(sessionId, options)),
    listSubagents: (sessionId, options) =>
      withHome(home, () => sdk.listSubagents(sessionId, options)),
    getSubagentMessages: (sessionId, agentId, options) =>
      withHome(home, () => sdk.getSubagentMessages(sessionId, agentId, options)),
    forkSession: (sessionId, options) => withHome(home, () => sdk.forkSession(sessionId, options)),
    renameSession: (sessionId, title, options) =>
      withHome(home, () => sdk.renameSession(sessionId, title, options)),
    archiveSession: (sessionId, options) =>
      withHome(home, () => sdk.archiveSession(sessionId, options)),
    unarchiveSession: (sessionId, options) =>
      withHome(home, () => sdk.unarchiveSession(sessionId, options)),
    deleteSession: (sessionId, options) =>
      withHome(home, () => sdk.deleteSession(sessionId, options)),
  };
}

/** The SDK itself. Its types are wider than ours and are narrowed here, in one place. */
export const realSdk: ClaudeSdk = {
  query: (params) =>
    query(params as unknown as Parameters<typeof query>[0]) as unknown as ClaudeQuery,
  listSessions: (options) => listSessions(options),
  getSessionInfo: (sessionId, options) => getSessionInfo(sessionId, options),
  getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options),
  listSubagents: (sessionId, options) => listSubagents(sessionId, options),
  getSubagentMessages: (sessionId, agentId, options) =>
    getSubagentMessages(sessionId, agentId, options),
  forkSession: (sessionId, options) => forkSession(sessionId, options),
  renameSession: (sessionId, title, options) => renameSession(sessionId, title, options),
  archiveSession: (sessionId, options) => archiveSession(sessionId, options),
  unarchiveSession: (sessionId, options) => unarchiveSession(sessionId, options),
  deleteSession: (sessionId, options) => deleteSession(sessionId, options),
};
