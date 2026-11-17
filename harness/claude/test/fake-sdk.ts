import type { ClaudeQuery, ClaudeSdk, QueryOptions } from "../src/index.ts";
import type {
  WireAccountInfo,
  WireContextUsage,
  WireHistoryMessage,
  WireMcpServerStatus,
  WireMessage,
  WireModelInfo,
  WireRewindFilesResult,
  WireSessionInfo,
  WireSlashCommand,
  WireUserMessage,
} from "../src/wire.ts";

/** A Claude Code process that runs nothing: a test says what it streams. */
export class FakeQuery implements ClaudeQuery {
  readonly options: QueryOptions;
  /** The prompts it was handed, in order. */
  readonly prompts: WireUserMessage[] = [];
  servers: Record<string, unknown> | null = null;
  /** What it was asked to change in place, in order: `mode plan`, `model x`, `effort low`. */
  readonly moves: string[] = [];
  /** Refuses the next change in place, as a process that went away would. */
  refuseMoves = false;
  interrupts = 0;
  /** The tasks it was asked to stop. */
  readonly stopped: string[] = [];
  closed = false;
  private readonly sdk: FakeSdk;
  private readonly waiting: (WireMessage | Error | null)[] = [];
  private wake: (() => void) | null = null;

  constructor(sdk: FakeSdk, options: QueryOptions) {
    this.sdk = sdk;
    this.options = options;
  }

  /** Streams one message. */
  say(message: WireMessage): void {
    this.waiting.push(message);
    this.wake?.();
  }

  /** The process goes away, with an error when it did not mean to. */
  exit(error?: Error): void {
    this.waiting.push(error ?? null);
    this.wake?.();
  }

  /** Each file rewind asked of it: the prompt's id, and whether it was a dry run. */
  readonly rewinds: { id: string; dryRun: boolean }[] = [];

  initializationResult = async () => {
    if (this.sdk.failStart) throw new Error(this.sdk.failStart);
    return {
      models: this.sdk.models,
      commands: this.sdk.commandsAt[this.options.cwd] ?? this.sdk.commands,
      agents: this.sdk.agents,
      account: this.sdk.account,
    };
  };
  accountInfo = async () => this.sdk.account;
  supportedCommands = async () => this.sdk.commands;
  mcpServerStatus = async () => this.sdk.serverReads.shift() ?? this.sdk.servers;
  getContextUsage = async () => this.sdk.context;
  rewindFiles = async (id: string, options: { dryRun: boolean }) => {
    this.rewinds.push({ id, dryRun: options.dryRun });
    return this.sdk.rewound;
  };
  interrupt = async () => {
    this.interrupts++;
  };
  private moved(what: string): void {
    if (this.refuseMoves) throw new Error("the process is gone");
    this.moves.push(what);
  }
  setPermissionMode = async (mode: string) => this.moved(`mode ${mode}`);
  setModel = async (model?: string) => this.moved(`model ${model ?? ""}`);
  stopTask = async (taskId: string) => {
    this.stopped.push(taskId);
  };
  /** The servers it was asked to connect again. */
  readonly reconnects: string[] = [];
  reconnectMcpServer = async (name: string) => {
    this.reconnects.push(name);
  };
  setMcpServers = async (servers: Record<string, unknown>) => {
    this.servers = servers;
  };
  /** Each flag layer merged in after start, in order. */
  readonly flags: Record<string, unknown>[] = [];
  /** An effort is a move in place; anything else is Cycle's configuration, kept in `flags`. */
  applyFlagSettings = async (settings: Record<string, unknown>) => {
    if ("effortLevel" in settings) {
      this.moved(`effort ${(settings["effortLevel"] as string | null) ?? "default"}`);
    } else {
      this.flags.push(settings);
    }
  };
  reloads = 0;
  reloadPlugins = async () => {
    this.reloads++;
    return { plugins: this.sdk.plugins };
  };
  close(): void {
    this.closed = true;
    this.exit();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WireMessage> {
    for (;;) {
      while (this.waiting.length > 0) {
        const next = this.waiting.shift();
        if (next instanceof Error) throw next;
        if (!next) return;
        yield next;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/** The SDK with nothing behind it: what is stored is what a test put there. */
export class FakeSdk implements ClaudeSdk {
  readonly queries: FakeQuery[] = [];
  /** The plugins a process says it loaded. */
  plugins: { name: string; path: string; source?: string; version?: string }[] = [];
  readonly calls: string[] = [];
  stored: WireSessionInfo[] = [];
  messages: Record<string, WireHistoryMessage[]> = {};
  /** What each stored session's helper agents said, by session and then by agent. */
  helpers: Record<string, Record<string, WireHistoryMessage[]>> = {};
  /** What each Claude Code home holds, when a test wants two homes to differ. */
  homes: Record<
    string,
    { stored?: WireSessionInfo[]; messages?: Record<string, WireHistoryMessage[]> }
  > = {};
  /** Each home a stored session was asked for, in order. */
  readonly read: string[] = [];
  /** The home the owner's own sessions are kept in, unless a test says another. */
  ownerHome = "/home/me/.claude";
  models: WireModelInfo[] = [
    {
      value: "default",
      resolvedModel: "claude-sonnet-5-5",
      displayName: "Default (recommended)",
      description: "Sonnet 5.5 · Efficient for routine tasks",
      supportedEffortLevels: ["low", "medium", "high"],
    },
  ];
  failStart: string | null = null;
  /** The helper agents a process says it can start. */
  agents: { name: string; description: string; model?: string }[] = [];
  commands: WireSlashCommand[] = [
    { name: "compact", description: "Compact the conversation", argumentHint: "", builtin: true },
    { name: "deploy", description: "Ship it", argumentHint: "<env>" },
  ];
  account: WireAccountInfo = { email: "me@example.test", subscriptionType: "max" };
  servers: WireMcpServerStatus[] = [];
  /** What the next reads of the servers answer, in order, before `servers`. */
  serverReads: WireMcpServerStatus[][] = [];
  /** The commands a process started in a folder offers, when they differ from `commands`. */
  commandsAt: Record<string, WireSlashCommand[]> = {};
  context: WireContextUsage = { categories: [], totalTokens: 0, maxTokens: 200_000 };
  rewound: WireRewindFilesResult = {
    canRewind: true,
    filesChanged: [],
    insertions: 0,
    deletions: 0,
  };

  /** The process started last. */
  get last(): FakeQuery {
    const query = this.queries.at(-1);
    if (!query) throw new Error("no process was started");
    return query;
  }

  query(params: { prompt: AsyncIterable<WireUserMessage>; options: QueryOptions }): FakeQuery {
    const query = new FakeQuery(this, params.options);
    this.queries.push(query);
    void (async () => {
      for await (const prompt of params.prompt) query.prompts.push(prompt);
    })();
    return query;
  }

  /** The Claude Code home the SDK is pointed at now, which is what it reads. */
  private get home(): string {
    return process.env["CLAUDE_CONFIG_DIR"] ?? "";
  }

  private at<T>(value: T): T {
    this.read.push(this.home);
    return value;
  }

  private get kept(): WireSessionInfo[] {
    const each = this.homes[this.home]?.stored;
    if (each) return each;
    return this.home === this.ownerHome ? this.stored : [];
  }

  private get said(): Record<string, WireHistoryMessage[]> {
    const each = this.homes[this.home]?.messages;
    if (each) return each;
    return this.home === this.ownerHome ? this.messages : {};
  }

  listSessions = async () => this.at(this.kept);
  getSessionInfo = async (sessionId: string) =>
    this.at(this.kept.find((info) => info.sessionId === sessionId));
  getSessionMessages = async (sessionId: string) => this.at(this.said[sessionId] ?? []);
  listSubagents = async (sessionId: string) => Object.keys(this.helpers[sessionId] ?? {});
  getSubagentMessages = async (sessionId: string, agentId: string) =>
    this.helpers[sessionId]?.[agentId] ?? [];
  forkSession = async (sessionId: string, options?: { upToMessageId?: string }) => {
    this.calls.push(`fork ${sessionId} ${options?.upToMessageId ?? "all"}`);
    const fork = `${sessionId}-fork`;
    this.stored.push({ sessionId: fork, summary: "", lastModified: 2, cwd: "/project" });
    return { sessionId: fork };
  };
  renameSession = async (sessionId: string, title: string) => {
    this.calls.push(`rename ${sessionId} ${title}`);
  };
  tagSession = async (sessionId: string, tag: string | null) => {
    this.calls.push(`tag ${sessionId} ${tag ?? "none"}`);
  };
  archiveSession = async (sessionId: string) => {
    this.calls.push(`archive ${sessionId}`);
  };
  unarchiveSession = async (sessionId: string) => {
    this.calls.push(`unarchive ${sessionId}`);
  };
  deleteSession = async (sessionId: string) => {
    this.calls.push(`delete ${sessionId}`);
  };
}

/** Lets what was started run as far as it can without a timer. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

export const user = (uuid: string, content: unknown): WireHistoryMessage => ({
  type: "user",
  uuid,
  message: { role: "user", content },
  parent_tool_use_id: null,
});

export const assistant = (uuid: string, content: unknown[], id = uuid): WireHistoryMessage => ({
  type: "assistant",
  uuid,
  message: { id, role: "assistant", model: "claude-sonnet-5-5", content },
  parent_tool_use_id: null,
});
