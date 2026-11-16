import {
  archiveSession,
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  unarchiveSession,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  WireElicitation,
  WireElicitationResult,
  WireAccountInfo,
  WireContextUsage,
  WireHistoryMessage,
  WireMcpServerStatus,
  WireMessage,
  WireModelInfo,
  WirePermissionMode,
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
  /** Always given: left out, Claude Code may start in a mode of its own choosing. */
  permissionMode: WirePermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  sandbox?: { enabled: boolean; autoAllowBashIfSandboxed: boolean };
  includePartialMessages: boolean;
  /** Keeps a copy of each file before the agent changes it, so `rewindFiles` can put it back. */
  enableFileCheckpointing?: boolean;
  /** Folders beyond `cwd` the session may reach. */
  additionalDirectories?: string[];
  settingSources: ("user" | "project" | "local")[];
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
  /** An MCP server asks the owner for something. Left out, every such request is declined. */
  onElicitation?: (
    request: WireElicitation,
    options: { signal: AbortSignal },
  ) => Promise<WireElicitationResult>;
  // shortcut: no `onUserDialog`, so Claude Code sends no dialog and a refused answer ends the turn
  // with its error, as in its CLI without a fallback model; upgrade when the SDK documents the
  // `refusal_fallback_prompt` payload, or another dialog kind is worth drawing.
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
  setPermissionMode(mode: WirePermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  /** Sets settings for this process alone, over its pipe: here, the effort as `effortLevel`. */
  applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void>;
  accountInfo(): Promise<WireAccountInfo>;
  supportedCommands(): Promise<WireSlashCommand[]>;
  mcpServerStatus(): Promise<WireMcpServerStatus[]>;
  /** `summary` answers from the last request's usage, with no request of its own. */
  getContextUsage(options: { detail: "summary" | "full" }): Promise<WireContextUsage>;
  rewindFiles(userMessageId: string, options: { dryRun: boolean }): Promise<WireRewindFilesResult>;
  /** Sets the MCP servers given to this process alone, over its own pipe. */
  setMcpServers(servers: Record<string, unknown>): Promise<unknown>;
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
  forkSession: (sessionId, options) => forkSession(sessionId, options),
  renameSession: (sessionId, title, options) => renameSession(sessionId, title, options),
  archiveSession: (sessionId, options) => archiveSession(sessionId, options),
  unarchiveSession: (sessionId, options) => unarchiveSession(sessionId, options),
  deleteSession: (sessionId, options) => deleteSession(sessionId, options),
};
