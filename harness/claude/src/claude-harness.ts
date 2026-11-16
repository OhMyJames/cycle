import {
  type AccountInfo,
  type Agent,
  type AgentCapabilities,
  type AgentReads,
  type ApprovalResponse,
  type ContextUsage,
  type CreateSessionOptions,
  type FileRewind,
  type HarnessEvent,
  type HarnessSession,
  type LimitWindow,
  type McpServerInfo,
  type ModelInfo,
  type PromptInput,
  type ReviewTarget,
  type SkillInfo,
  type SlashCommand,
  type Turn,
  type TurnOptions,
  type Usage,
  toMachinePath,
} from "@cycle/protocol";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Sandboxes, claudeHomeOf, projectFolder, sandboxCwd } from "./sandbox.ts";
import {
  atHome,
  type ClaudeQuery,
  type ClaudeSdk,
  type QueryOptions,
  realSdk,
  withHome,
} from "./sdk.ts";
import {
  DEFAULT_EFFORT,
  HARNESS_NAME,
  NO_TOKENS,
  StreamReader,
  entryBefore,
  historyModel,
  lastEntryOf,
  modeOptions,
  reviewPrompt,
  toAccount,
  toApproval,
  toCommands,
  toContext,
  toFileRewind,
  toLimit,
  toMcpServers,
  toModels,
  toPermission,
  toSession,
  toSkills,
  toTurns,
  toUserMessage,
  turnPlace,
  usedBy,
} from "./translate.ts";
import type {
  WireAccountInfo,
  WireHistoryMessage,
  WireMcpServerStatus,
  WireMessage,
  WireSessionInfo,
  WirePermissionResult,
  WirePermissionUpdate,
  WireUserMessage,
} from "./wire.ts";

/** The client's own MCP server: where it is, and the key Claude Code sends it. */
export interface OwnTools {
  name: string;
  url: string;
  key: string;
}

/** The few file moves a sandbox's conversations need, so a test can give its own. */
export interface SessionFiles {
  /** Moves a file or a folder; answers false when there was nothing there. */
  move(from: string, to: string): Promise<boolean>;
}

export interface ClaudeHarnessOptions {
  /**
   * The `claude` executable: a path, or a name to find on the `PATH`. Defaults to
   * `CYCLE_CLAUDE_BIN`, then the one the SDK brings.
   */
  bin?: string;
  env?: Record<string, string | undefined>;
  /** Receives what Claude Code prints to stderr. */
  onLog?: (line: string) => void;
  /** An MCP server of the client's own that every session reaches, behind a key. */
  tools?: OwnTools;
  /**
   * Starts Claude Code somewhere other than this machine: a container, a
   * sandbox, another host. It is given the command and must answer a process
   * whose stdin and stdout reach it. Sessions are then that place's to keep.
   */
  spawn?: QueryOptions["spawnClaudeCodeProcess"];
  /** Sandboxes a session's agent can run in. Without them, a session asked into one is refused. */
  sandboxes?: Sandboxes;
  /** Where a conversation kept in the owner's home is moved from, once. */
  files?: SessionFiles;
  sdk?: ClaudeSdk;
  /** Runs something later, and answers how to call it off. */
  schedule?: (run: () => void, ms: number) => () => void;
  now?: () => number;
  newId?: () => string;
}

/** What is known of a session without asking Claude Code. */
interface Known {
  cwd: string;
  /** Whether Claude Code has written it down: one with no turn yet is only ours. */
  stored: boolean;
  model?: string;
  /** The sandbox its agent runs in, by name. */
  sandbox?: string;
  /** Folders beyond `cwd` its agent may reach. */
  directories?: string[];
}

/** One Claude Code process, which holds one session. */
interface Running {
  sessionId: string;
  known: Known;
  query: ClaudeQuery;
  input: Inbox<WireUserMessage>;
  reader: StreamReader;
  /** The mode, model and effort it was started with: another means another process. */
  spec: string;
  /** The turn it runs now, known by the prompt that began it. */
  turn: string | null;
  /** Prompts sent into the running turn, until it is known whether it took them. */
  steers: Map<string, PromptInput>;
  /** The owner asked it to stop: the turn's end is theirs, not a failure. */
  stopping: boolean;
  cancelIdle: (() => void) | null;
  /** We closed it ourselves. */
  closed: boolean;
  /** The commands its prompts can begin with, as it last said. */
  commands: SlashCommand[];
  /** What it said the session had cost at its last result. Null before its first. */
  costSeen: number | null;
}

interface PendingApproval {
  sessionId: string;
  answer(response: ApprovalResponse): void;
}

interface AskContext {
  signal: AbortSignal;
  suggestions?: WirePermissionUpdate[];
  title?: string;
  decisionReason?: string;
  toolUseID: string;
}

/** A process nobody has prompted for this long is closed. Its session comes back with the next prompt. */
const IDLE_MS = 5 * 60_000;
/** A list of MCP servers read without a session's process is kept this long. */
const MCP_KEEP_MS = 5 * 60_000;
/** How often, and how many times, a process is asked again while its servers are still connecting. */
const MCP_POLL_MS = 250;
const MCP_POLLS = 40;
const LIST_LIMIT = 500;

/** Prompts handed to a process as they come, for as long as it lives. */
class Inbox<T> implements AsyncIterable<T> {
  private readonly waiting: T[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(value: T): void {
    this.waiting.push(value);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.waiting.length > 0) yield this.waiting.shift() as T;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Moves a conversation, and the folder that holds what it read, into a sandbox's home. */
const realFiles: SessionFiles = {
  async move(from, to) {
    await mkdir(dirname(to), { recursive: true });
    try {
      await rename(from, to);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    }
    await cp(from, to, { recursive: true, errorOnExist: false, force: true });
    await rm(from, { recursive: true, force: true });
    return true;
  },
};

/**
 * Drives Claude Code through the Claude Agent SDK. Each session that is in
 * use has a process of its own, started with the session's mode, model and
 * effort and closed when it has been idle a while; the conversation itself is
 * Claude Code's, in its own home, so a session made in the `claude` CLI shows
 * up here and one made here can be continued there.
 *
 * It is an agent only: files, commands and terminals are the main harness's.
 */
export class ClaudeHarness implements Agent, AgentReads {
  readonly name = HARNESS_NAME;
  readonly capabilities: AgentCapabilities = {
    attachments: ["image", "pdf", "text"],
    rewindFiles: true,
    commands: true,
    directories: true,
    connector: "read",
    login: false,
    features: false,
  };
  private readonly sdk: ClaudeSdk;
  private readonly options: ClaudeHarnessOptions;
  private readonly env: Record<string, string>;
  /** The owner's Claude Code home: what a session on this machine reads and writes. */
  private readonly home: string;
  private readonly files: SessionFiles;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly known = new Map<string, Known>();
  private readonly live = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<Running>>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** What each session was last asked to run with, for work that brings no options of its own. */
  private readonly asked = new Map<string, TurnOptions>();
  /**
   * What each session last said it used. Claude Code counts a session's use across its
   * processes, so a new one carries on from the last; a daemon that never saw a turn knows nothing.
   */
  private readonly usage = new Map<string, Usage>();
  /**
   * Where a conversation the owner took back now ends: an entry's id, or
   * `start` for before its first turn. Claude Code cuts a conversation only as
   * it takes the next prompt, so until then the cut is ours to remember.
   *
   * shortcut: a cut is lost if the daemon stops before the next prompt, and the turns come back;
   * upgrade when the SDK can cut a stored conversation without running a turn.
   */
  private readonly cuts = new Map<string, string>();
  private models: Promise<ModelInfo[]> | null = null;
  /**
   * What the latest process to start said of the account and of the commands a prompt outside any
   * session can begin with. Claude Code reads its sign-in as it starts, so a new one shows with the
   * next process.
   */
  private latest: { account: WireAccountInfo | null } = { account: null };
  /**
   * The commands a prompt can begin with in each folder, as a process on this machine in it last
   * said: the owner's, and the folder's project's own.
   */
  private readonly commandsAt = new Map<string, SlashCommand[]>();
  /** The MCP servers as last read, and when. */
  private mcp: { at: number; servers: McpServerInfo[] } | null = null;
  /**
   * What each session has cost so far, over all its processes. Kept apart from `usage`, which going
   * back clears: what was spent stays spent.
   */
  private readonly costs = new Map<string, number>();
  /** The subscription's limits, as the processes last told of each. */
  private readonly limits = new Map<string, LimitWindow>();

  constructor(options: ClaudeHarnessOptions = {}) {
    this.options = options;
    this.sdk = options.sdk ?? realSdk;
    this.env = {};
    for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
      if (value !== undefined) this.env[key] = value;
    }
    this.home = claudeHomeOf(this.env);
    this.files = options.files ?? realFiles;
    this.schedule =
      options.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Claude Code must be there and start: its models are the proof. */
  async start(): Promise<void> {
    await this.listModels();
  }

  async dispose(): Promise<void> {
    for (const running of this.live.values()) this.stop(running);
  }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Sessions

  async createSession(options: CreateSessionOptions): Promise<HarnessSession> {
    const sandbox = options.sandboxed
      ? await this.sandboxes().ensure(options.cwd, { environment: options.sandboxed })
      : null;
    const id = this.newId();
    const at = this.now();
    this.known.set(id, {
      cwd: options.cwd,
      stored: false,
      ...(options.model ? { model: options.model } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(options.directories?.length ? { directories: options.directories } : {}),
    });
    this.asked.set(id, options);
    return {
      id,
      harness: this.name,
      title: null,
      preview: "",
      cwd: options.cwd,
      model: options.model ?? "",
      effort: options.effort ?? null,
      branch: null,
      sandbox,
      sandboxCwd: sandbox ? sandboxCwd(options.cwd) : null,
      createdAt: at,
      updatedAt: at,
      forkedFrom: null,
    };
  }

  /**
   * What Claude Code keeps here, and what each sandbox keeps in its own home. A sandbox's
   * conversation says the folder as the sandbox knows it, which is put back to this machine's.
   */
  async listSessions(filter: { archived: boolean }): Promise<HarnessSession[]> {
    const out: HarnessSession[] = [];
    const seen = new Set<string>();
    const take = (info: WireSessionInfo, sandbox: { name: string; cwd: string } | null): void => {
      // One with no folder cannot be continued.
      if (!info.cwd || (info.archived === true) !== filter.archived) return;
      if (seen.has(info.sessionId)) return;
      seen.add(info.sessionId);
      const cwd = sandbox?.cwd ?? info.cwd;
      const where = sandbox?.name;
      const known = this.known.get(info.sessionId);
      if (known) known.stored = true;
      else
        this.known.set(info.sessionId, {
          cwd,
          stored: true,
          ...(sandbox ? { sandbox: sandbox.name } : {}),
        });
      const extra: { model?: string; sandbox?: string } = {};
      if (known?.model) extra.model = known.model;
      const named = known?.sandbox ?? where;
      if (named !== undefined) extra.sandbox = named;
      out.push(toSession(info, { cwd, sandboxCwd: sandbox ? sandboxCwd(cwd) : null, ...extra }));
    };
    for (const info of await atHome(this.sdk, this.home).listSessions({ limit: LIST_LIMIT })) {
      take(info, null);
    }
    for (const each of this.options.sandboxes?.made() ?? []) {
      const list = await atHome(this.sdk, this.homeOf(each.name)).listSessions({
        limit: LIST_LIMIT,
      });
      for (const info of list) take(info, each);
    }
    return out;
  }

  async loadSession(
    sessionId: string,
    options: TurnOptions,
  ): Promise<{ session: HarnessSession; turns: Turn[]; usage: Usage | null }> {
    const known = await this.find(sessionId);
    this.asked.set(sessionId, options);
    if (options.sandbox) known.sandbox = options.sandbox;
    if (options.directories) known.directories = options.directories;
    if (known.sandbox && known.stored) await this.adopt(sessionId, known);
    const at = this.now();
    const inside = known.sandbox ? this.cwdOf(known) : null;
    const fresh: HarnessSession = {
      id: sessionId,
      harness: this.name,
      title: null,
      preview: "",
      cwd: known.cwd,
      model: options.model ?? known.model ?? "",
      effort: options.effort ?? null,
      branch: null,
      sandbox: known.sandbox ?? null,
      sandboxCwd: inside,
      createdAt: at,
      updatedAt: at,
      forkedFrom: null,
    };
    if (!known.stored) return { session: fresh, turns: [], usage: null };
    const sdk = this.sdkFor(known);
    const dir = { dir: inside ?? known.cwd };
    const [info, stored] = await Promise.all([
      sdk.getSessionInfo(sessionId, dir),
      sdk.getSessionMessages(sessionId, dir),
    ]);
    const messages = this.kept(sessionId, stored);
    const model = options.model ?? known.model ?? historyModel(messages) ?? "";
    if (model) known.model = model;
    return {
      session: info
        ? toSession(info, {
            cwd: known.cwd,
            sandboxCwd: inside,
            model,
            ...(known.sandbox ? { sandbox: known.sandbox } : {}),
          })
        : { ...fresh, model },
      turns: toTurns(messages, known.cwd, inside),
      usage: this.usage.get(sessionId) ?? null,
    };
  }

  async forkSession(sessionId: string, turnId: string | null): Promise<HarnessSession> {
    const known = await this.find(sessionId);
    if (!known.stored) throw new Error("There is nothing in this session to copy yet.");
    const sdk = this.sdkFor(known);
    const dir = { dir: this.cwdOf(known) };
    const messages = this.kept(sessionId, await sdk.getSessionMessages(sessionId, dir));
    // The whole of a conversation that was taken back ends where it was cut.
    const upTo = (turnId ? lastEntryOf(messages, turnId) : null) ?? this.cutOf(sessionId, messages);
    const fork = await sdk.forkSession(sessionId, {
      ...dir,
      ...(upTo ? { upToMessageId: upTo } : {}),
    });
    this.known.set(fork.sessionId, { ...known, stored: true });
    const info = await sdk.getSessionInfo(fork.sessionId, dir);
    if (!info) throw new Error("Claude Code made the copy, and then could not find it.");
    return toSession(info, {
      forkedFrom: sessionId,
      cwd: known.cwd,
      sandboxCwd: known.sandbox ? dir.dir : null,
      ...(known.model ? { model: known.model } : {}),
      ...(known.sandbox ? { sandbox: known.sandbox } : {}),
    });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const known = await this.find(sessionId);
    // One with no turn yet has no place for a name: the client keeps the owner's own.
    if (known.stored)
      await this.sdkFor(known).renameSession(sessionId, title, { dir: this.cwdOf(known) });
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    const known = await this.find(sessionId);
    const running = this.live.get(sessionId);
    if (running) this.stop(running);
    if (!known.stored) return;
    const sdk = this.sdkFor(known);
    const dir = { dir: this.cwdOf(known) };
    if (archived) await sdk.archiveSession(sessionId, dir);
    else await sdk.unarchiveSession(sessionId, dir);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const known = await this.find(sessionId);
    const running = this.live.get(sessionId);
    if (running) this.stop(running);
    if (known.stored) await this.sdkFor(known).deleteSession(sessionId, { dir: this.cwdOf(known) });
    this.known.delete(sessionId);
    this.cuts.delete(sessionId);
    this.asked.delete(sessionId);
    this.usage.delete(sessionId);
    this.costs.delete(sessionId);
  }

  /** Claude Code compacts when asked as a prompt would ask it: the turn it makes holds the mark. */
  async compactSession(sessionId: string): Promise<void> {
    const running = await this.running(sessionId, this.asked.get(sessionId) ?? {});
    if (running.turn !== null) throw new Error("Wait for the turn to finish before compacting.");
    const turnId = this.newId();
    this.begin(running, turnId);
    running.input.push(toUserMessage({ text: "/compact", images: [] }, turnId, sessionId));
  }

  async rewindSession(sessionId: string, turnId: string): Promise<{ from: string }> {
    const known = await this.find(sessionId);
    const stored = known.stored
      ? await this.sdkFor(known).getSessionMessages(sessionId, { dir: this.cwdOf(known) })
      : [];
    const messages = this.kept(sessionId, stored);
    const place = turnPlace(messages, turnId);
    if (place === "unknown") {
      throw new Error(
        "Claude Code no longer keeps that turn: the conversation was compacted since.",
      );
    }
    const before = place === "first" ? null : entryBefore(messages, turnId);
    this.cuts.set(sessionId, before ?? CUT_START);
    // It counts again from the shorter conversation.
    this.usage.delete(sessionId);
    // The process holds the conversation as it was.
    const running = this.live.get(sessionId);
    if (running) this.stop(running);
    return { from: turnId };
  }

  // Turns

  async send(
    sessionId: string,
    input: PromptInput,
    options: TurnOptions,
  ): Promise<{ turnId: string }> {
    this.asked.set(sessionId, options);
    const running = await this.running(sessionId, options);
    if (running.turn !== null) throw new Error("A turn is already running in this session.");
    const turnId = this.newId();
    this.begin(running, turnId, input);
    running.input.push(toUserMessage(input, turnId, sessionId));
    return { turnId };
  }

  review(
    sessionId: string,
    target: ReviewTarget,
    options: TurnOptions,
  ): Promise<{ turnId: string }> {
    return this.send(sessionId, { text: reviewPrompt(target), images: [] }, options);
  }

  /** The prompt joins the running turn at its next tool call, or begins the next turn if there is none. */
  async steer(sessionId: string, input: PromptInput): Promise<void> {
    const running = this.live.get(sessionId);
    if (!running || running.turn === null) throw new Error("No turn is running.");
    const id = this.newId();
    running.steers.set(id, input);
    this.said(running, running.turn, id, input);
    running.input.push(toUserMessage(input, id, sessionId, "next"));
  }

  async interrupt(sessionId: string): Promise<void> {
    const running = this.live.get(sessionId);
    if (!running || running.turn === null) return;
    running.stopping = true;
    await running.query.interrupt();
  }

  respondApproval(approvalId: string, response: ApprovalResponse): void {
    this.approvals.get(approvalId)?.answer(response);
  }

  /**
   * Puts the files back as they were when the turn's prompt was sent, from the copies Claude Code
   * kept as the agent changed them. The session's process is started for it if it has none.
   */
  async rewindFiles(sessionId: string, turnId: string, dryRun: boolean): Promise<FileRewind> {
    const running = await this.running(sessionId, this.asked.get(sessionId) ?? {});
    if (running.turn !== null) throw new Error("Stop the turn before putting files back.");
    const inside = running.known.sandbox ? this.cwdOf(running.known) : null;
    const done = await running.query.rewindFiles(turnId, { dryRun });
    return toFileRewind(done, (path) =>
      toMachinePath(path, { cwd: running.known.cwd, sandboxCwd: inside }),
    );
  }

  /**
   * A session's commands, as its process last said, or those of a folder: a project brings commands
   * of its own, so each folder has its own list. A folder no process has run in yet is asked of one
   * started there for the answer, once.
   *
   * shortcut: a folder's list is kept until a process runs there again; upgrade when commands added
   * in a project with no session running should show at once.
   */
  async listCommands(target: { sessionId: string } | { cwd: string }): Promise<SlashCommand[]> {
    let cwd: string;
    if ("sessionId" in target) {
      const running = this.live.get(target.sessionId);
      if (running) return running.commands;
      cwd = (await this.find(target.sessionId)).cwd;
    } else {
      cwd = target.cwd;
    }
    const kept = this.commandsAt.get(cwd);
    if (kept) return kept;
    return this.probe(async () => this.commandsAt.get(cwd) ?? [], cwd);
  }

  /** What a session's context holds, from its last request. Null when it has no process now. */
  async readContext(sessionId: string): Promise<ContextUsage | null> {
    const running = this.live.get(sessionId);
    if (!running) return null;
    return toContext(await running.query.getContextUsage({ detail: "summary" }));
  }

  /**
   * Who Claude Code is signed in as here, asked of a process that runs on this machine, and the
   * limits seen so far. A sandbox's sign-in is its own, and not the owner's account.
   */
  async readAccount(): Promise<AccountInfo> {
    const running = this.here();
    if (running) {
      this.latest.account = await running.query.accountInfo().catch(() => this.latest.account);
    } else if (!this.latest.account) {
      await this.listModels();
    }
    return toAccount(this.latest.account, [...this.limits.values()]);
  }

  /**
   * The servers Claude Code reaches, once they have finished connecting. A process on this machine
   * that runs is asked. With none, the last answer is given while it is a few minutes old; after
   * that a process is started for the answer, which starts every stdio server of the owner's too,
   * so it is kept rather than asked again with each look at the page.
   */
  async listMcpServers(): Promise<McpServerInfo[]> {
    const own = this.options.tools?.name ?? null;
    const running = this.here();
    const read = async (query: ClaudeQuery) => {
      const servers = toMcpServers(await this.connected(query), own);
      this.mcp = { at: this.now(), servers };
      return servers;
    };
    if (running) return read(running.query);
    if (this.mcp && this.now() - this.mcp.at < MCP_KEEP_MS) return this.mcp.servers;
    return this.probe(read);
  }

  /** Claude Code's skills in a folder are the commands the owner, its project or a plugin brings. */
  async listSkills(cwd: string): Promise<SkillInfo[]> {
    return toSkills(await this.listCommands({ cwd }));
  }

  /**
   * Claude Code says which models it offers as a process starts, so one is
   * started for the answer and closed.
   *
   * shortcut: the answer is kept for as long as the daemon runs; upgrade when the owner changes
   * accounts or Claude Code under a running daemon and expects the list to follow.
   */
  listModels(): Promise<ModelInfo[]> {
    this.models ??= this.readModels().catch((error: unknown) => {
      this.models = null;
      throw error;
    });
    return this.models;
  }

  // Inside

  private readModels(): Promise<ModelInfo[]> {
    return this.probe(async () => this.offered);
  }

  /** The models the latest process to start for the purpose said it offers. */
  private offered: ModelInfo[] = [];

  /**
   * Starts a process that holds no session, for what only a running one says, and closes it. What it
   * says as it starts is kept.
   */
  private async probe<T>(ask: (query: ClaudeQuery) => Promise<T>, cwd = homedir()): Promise<T> {
    let query: ClaudeQuery | null = null;
    try {
      query = await withHome(this.home, () =>
        this.sdk.query({
          prompt: new Inbox<WireUserMessage>(),
          options: { ...this.shared(), cwd, permissionMode: "default" },
        }),
      );
      const init = await query.initializationResult();
      this.offered = toModels(init.models ?? [], this.options.sandboxes?.available() ?? false);
      this.heard(init, cwd);
      return await ask(query);
    } catch (error) {
      throw new Error(`Claude Code could not start: ${message(error)}`, { cause: error });
    } finally {
      query?.close();
    }
  }

  /** A process that runs on this machine, with the owner's own settings and sign-in. */
  private here(): Running | undefined {
    return [...this.live.values()].find((each) => !each.known.sandbox);
  }

  /**
   * Keeps what a process said as it started, and answers its commands. A sandbox's process has a
   * sign-in and settings of its own, which are not the owner's: only its commands are its own.
   */
  private heard(
    init: Awaited<ReturnType<ClaudeQuery["initializationResult"]>>,
    /** The folder it runs in on this machine; null for a sandbox's. */
    cwd: string | null,
  ): SlashCommand[] {
    const commands = toCommands(init.commands ?? []);
    if (cwd === null) return commands;
    if (init.account) this.latest.account = init.account;
    this.commandsAt.set(cwd, commands);
    return commands;
  }

  /**
   * A process's MCP servers once none is still connecting, or as they are after a while: a server
   * read too soon shows no tools.
   */
  private async connected(query: ClaudeQuery): Promise<WireMcpServerStatus[]> {
    for (let poll = 1; ; poll++) {
      const servers = await query.mcpServerStatus();
      if (poll >= MCP_POLLS || !servers.some((server) => server.status === "pending")) {
        return servers;
      }
      await new Promise<void>((resolve) => this.schedule(resolve, MCP_POLL_MS));
    }
  }

  /** What every process is started with. The owner's own Claude Code settings apply, as in its CLI. */
  private shared(
    sandbox: string | null = null,
  ): Pick<
    QueryOptions,
    | "env"
    | "settingSources"
    | "systemPrompt"
    | "includePartialMessages"
    | "pathToClaudeCodeExecutable"
    | "spawnClaudeCodeProcess"
    | "stderr"
  > {
    const { onLog } = this.options;
    // A sandbox has a Claude Code of its own, which `sbx` starts. The SDK still wants the path to
    // one before it hands the process over; `sbx exec` starts the sandbox's `claude` by name.
    const bin = sandbox ? "claude" : this.bin();
    const spawn = sandbox
      ? (request: Parameters<Sandboxes["start"]>[1]) => this.sandboxes().start(sandbox, request)
      : this.options.spawn;
    return {
      env: this.env,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
      ...(spawn ? { spawnClaudeCodeProcess: spawn } : {}),
      ...(onLog ? { stderr: (data: string) => onLog(data.trimEnd()) } : {}),
    };
  }

  /** Where Claude Code is. A name is looked for where the owner's shell would look. */
  private bin(): string | undefined {
    const named = this.options.bin ?? this.env["CYCLE_CLAUDE_BIN"];
    if (!named || named.includes("/")) return named || undefined;
    const found = Bun.which(named, { PATH: this.env["PATH"] ?? "" });
    if (!found) throw new Error(`\`${named}\` is not installed, or not on the PATH.`);
    return found;
  }

  private sandboxes(): Sandboxes {
    const { sandboxes } = this.options;
    if (!sandboxes?.available()) {
      throw new Error("Docker Sandboxes is not installed: `sbx` is not on the PATH.");
    }
    return sandboxes;
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async find(sessionId: string): Promise<Known> {
    const known = this.known.get(sessionId);
    if (known) return known;
    const here = await atHome(this.sdk, this.home).getSessionInfo(sessionId);
    if (here?.cwd) {
      const found: Known = { cwd: here.cwd, stored: true };
      this.known.set(sessionId, found);
      return found;
    }
    for (const each of this.options.sandboxes?.made() ?? []) {
      const info = await atHome(this.sdk, this.homeOf(each.name)).getSessionInfo(sessionId);
      if (!info?.cwd) continue;
      const found: Known = { cwd: each.cwd, stored: true, sandbox: each.name };
      this.known.set(sessionId, found);
      return found;
    }
    throw new Error("This session is not in Claude Code's history.");
  }

  /** The SDK as the session's conversation is kept: its sandbox's home, or the owner's. */
  private sdkFor(known: Known): ClaudeSdk {
    const sandbox = known.sandbox;
    return atHome(this.sdk, sandbox ? this.homeOf(sandbox) : this.home);
  }

  /** Where a sandbox keeps its conversations, which reads without sbx being there. */
  private homeOf(name: string): string {
    const sandboxes = this.options.sandboxes;
    if (!sandboxes) throw new Error("Sandboxes are not set up here.");
    return sandboxes.home(name);
  }

  /** The folder as the session's agent knows it: a sandbox's own name for it, or this path. */
  private cwdOf(known: Known): string {
    return known.sandbox ? sandboxCwd(known.cwd) : known.cwd;
  }

  /**
   * A conversation this machine kept before sandboxes had a home of their own is moved into its
   * sandbox's, the first time it is opened. One already there is left as it is.
   */
  private async adopt(sessionId: string, known: Known): Promise<void> {
    const sandbox = known.sandbox;
    if (!sandbox) return;
    const home = this.homeOf(sandbox);
    if (await atHome(this.sdk, home).getSessionInfo(sessionId)) return;
    if (!(await atHome(this.sdk, this.home).getSessionInfo(sessionId))) return;
    // Its conversations are about to be found under the sandbox, so the folder it works in is kept.
    this.options.sandboxes?.remember(sandbox, known.cwd);
    const from = join(this.home, "projects", projectFolder(known.cwd), sessionId);
    const to = join(home, "projects", projectFolder(sandboxCwd(known.cwd)), sessionId);
    if (await this.files.move(`${from}.jsonl`, `${to}.jsonl`)) await this.files.move(from, to);
  }

  /** A stored conversation up to where the owner took it back. */
  private kept(sessionId: string, messages: WireHistoryMessage[]): WireHistoryMessage[] {
    const cut = this.cuts.get(sessionId);
    if (!cut) return messages;
    if (cut === CUT_START) return [];
    const at = messages.findIndex((entry) => entry.uuid === cut);
    return at === -1 ? messages : messages.slice(0, at + 1);
  }

  /** The entry a taken-back conversation ends at, when it has one and still holds something. */
  private cutOf(sessionId: string, messages: WireHistoryMessage[]): string | null {
    const cut = this.cuts.get(sessionId);
    if (!cut) return null;
    if (cut === CUT_START) throw new Error("There is nothing in this session to copy yet.");
    return messages.some((entry) => entry.uuid === cut) ? cut : null;
  }

  /** The session's process, started if it has none, and started again if it must run otherwise. */
  private async running(sessionId: string, options: TurnOptions): Promise<Running> {
    const known = await this.find(sessionId);
    // A daemon that started since the session was made is told where it runs.
    if (options.sandbox) known.sandbox = options.sandbox;
    if (options.directories) known.directories = options.directories;
    const model = options.model ?? known.model;
    const effort = options.effort ?? (await this.defaultEffort(model));
    const spec = JSON.stringify([
      options.mode ?? "readOnly",
      model ?? "",
      effort ?? "",
      known.directories ?? [],
    ]);
    const starting = this.starting.get(sessionId);
    if (starting) return starting;
    const running = this.live.get(sessionId);
    if (running && (running.spec === spec || running.turn !== null)) return running;
    if (running) this.stop(running);
    const launch = this.launch(sessionId, known, options, spec, model, effort).finally(() =>
      this.starting.delete(sessionId),
    );
    this.starting.set(sessionId, launch);
    return launch;
  }

  /** What a model runs at when the owner chose no effort, when it is known to have one. */
  private async defaultEffort(model: string | undefined): Promise<string | undefined> {
    const models = await this.listModels().catch(() => []);
    const found = models.find((entry) => entry.id === model);
    return found?.efforts.some((effort) => effort.id === DEFAULT_EFFORT)
      ? DEFAULT_EFFORT
      : undefined;
  }

  private async launch(
    sessionId: string,
    known: Known,
    options: TurnOptions,
    spec: string,
    model: string | undefined,
    effort: string | undefined,
  ): Promise<Running> {
    const cut = this.cuts.get(sessionId);
    if (cut === CUT_START && known.stored) {
      // Back before its first turn, a conversation begins again under the id it had.
      await this.sdkFor(known).deleteSession(sessionId, { dir: this.cwdOf(known) });
      known.stored = false;
    }
    const inside = known.sandbox ? this.cwdOf(known) : null;
    const input = new Inbox<WireUserMessage>();
    // The sandbox may have been removed since, or its environment changed: it is made again, and
    // its agent starts in it.
    const sandbox = known.sandbox
      ? await this.sandboxes().ensure(known.cwd, { name: known.sandbox })
      : null;
    // Cycle's tools answer on this machine's loopback alone, which a sandbox is not on.
    const tools = sandbox ? undefined : this.options.tools;
    // The SDK's own reads of a home are the owner's here, whichever home the agent runs in.
    const query = await withHome(this.home, () =>
      this.sdk.query({
        prompt: input,
        options: {
          ...this.shared(sandbox),
          ...modeOptions(options.mode ?? "readOnly", sandbox !== null),
          cwd: this.cwdOf(known),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          // So the files can go back with the conversation.
          enableFileCheckpointing: true,
          // A sandbox holds the session's folder alone.
          ...(known.directories?.length && !sandbox
            ? { additionalDirectories: known.directories }
            : {}),
          ...(known.stored
            ? { resume: sessionId, ...(cut && cut !== CUT_START ? { resumeSessionAt: cut } : {}) }
            : { sessionId }),
          canUseTool: (tool, toolInput, context) => this.ask(running, tool, toolInput, context),
        },
      }),
    );
    const running: Running = {
      sessionId,
      known,
      input,
      reader: new StreamReader(sessionId, known.cwd, inside),
      spec,
      turn: null,
      steers: new Map(),
      stopping: false,
      cancelIdle: null,
      closed: false,
      query,
      commands: [],
      costSeen: null,
    };
    try {
      running.commands = this.heard(
        await running.query.initializationResult(),
        sandbox === null ? known.cwd : null,
      );
      // The key goes down the process's own pipe: not its arguments, which any command can list,
      // nor its environment, which the commands it runs inherit.
      if (tools) {
        await running.query.setMcpServers({
          [tools.name]: {
            type: "http",
            url: tools.url,
            headers: { Authorization: `Bearer ${tools.key}` },
          },
        });
      }
    } catch (error) {
      running.closed = true;
      running.query.close();
      throw new Error(`Claude Code could not start: ${message(error)}`, { cause: error });
    }
    this.cuts.delete(sessionId);
    this.live.set(sessionId, running);
    void this.pump(running);
    return running;
  }

  private stop(running: Running): void {
    running.closed = true;
    running.cancelIdle?.();
    if (this.live.get(running.sessionId) === running) this.live.delete(running.sessionId);
    running.input.end();
    running.query.close();
  }

  /** Starts a turn in the conversation. With `input`, the prompt is its first item. */
  private begin(running: Running, turnId: string, input?: PromptInput): void {
    running.cancelIdle?.();
    running.cancelIdle = null;
    running.turn = turnId;
    running.stopping = false;
    this.emit({
      type: "turn.started",
      sessionId: running.sessionId,
      turnId,
      startedAt: this.now(),
    });
    if (input) this.said(running, turnId, turnId, input);
  }

  private said(running: Running, turnId: string, id: string, input: PromptInput): void {
    this.emit({
      type: "item.completed",
      sessionId: running.sessionId,
      turnId,
      item: {
        id,
        kind: "userMessage",
        text: input.text,
        images: input.images,
        ...(input.documents?.length
          ? { documents: input.documents.map(({ kind, name }) => ({ kind, name })) }
          : {}),
      },
    });
  }

  private async pump(running: Running): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const each of running.query) this.handle(running, each);
    } catch (error) {
      failure = error;
    }
    this.ended(running, failure);
  }

  private handle(running: Running, each: WireMessage): void {
    if (each.type === "rate_limit_event" && each.rate_limit_info) {
      const limit = toLimit(each.rate_limit_info);
      this.limits.set(limit.id, limit);
      this.emit({ type: "limits.changed", harness: this.name });
      return;
    }
    if (each.type === "system" && each.subtype === "commands_changed" && each.commands) {
      running.commands = toCommands(each.commands);
      if (!running.known.sandbox) this.commandsAt.set(running.known.cwd, running.commands);
      this.emit({
        type: "commands.changed",
        sessionId: running.sessionId,
        commands: running.commands,
      });
      return;
    }
    if (each.type === "result") {
      this.finish(running, each);
      return;
    }
    if (running.turn === null) return;
    for (const event of running.reader.read(running.turn, each)) this.emit(event);
  }

  /** A turn ended: what it used, how it went, and the turn that follows by itself, if one does. */
  private finish(running: Running, result: WireMessage): void {
    const { sessionId } = running;
    const turnId = running.turn;
    if (turnId === null) return;
    const used = usedBy(result.modelUsage);
    const before = this.usage.get(sessionId);
    const usage: Usage = {
      total: used.count,
      last: running.reader.last ?? NO_TOKENS,
      contextWindow: used.contextWindow ?? before?.contextWindow ?? null,
      costUsd: this.cost(running, result.total_cost_usd ?? used.costUsd),
    };
    this.usage.set(sessionId, usage);
    this.emit({ type: "usage.updated", sessionId, usage });
    const failed = result.is_error === true || result.subtype !== "success";
    const status = running.stopping ? "interrupted" : failed ? "failed" : "completed";
    running.stopping = false;
    running.turn = null;
    running.known.stored = true;
    this.emit({
      type: "turn.completed",
      sessionId,
      turnId,
      status,
      error:
        status === "failed"
          ? result.errors?.join("\n") || result.result || "The turn failed."
          : null,
      durationMs: result.duration_ms ?? null,
    });
    // A prompt sent into the turn that it ended without taking begins the next one.
    const taken = result.user_message_uuids;
    if (taken) for (const id of taken) running.steers.delete(id);
    else running.steers.clear();
    const [next] = running.steers;
    if (next) {
      running.steers.delete(next[0]);
      this.begin(running, next[0], next[1]);
      return;
    }
    running.cancelIdle = this.schedule(() => {
      if (running.turn === null && !running.closed) this.stop(running);
    }, IDLE_MS);
  }

  /**
   * What the session has cost, from what a process says it has: a total for its session, which a
   * process resuming a conversation carries on from what was spent before it (as seen with Claude
   * Code 2.1.325), and which one that does not begins at nothing. A process's first total below what
   * the session had cost began at nothing, and adds to it; one at or above it carried on. Later
   * totals add what they grew by; one that fell began again (`/clear`) and adds in full.
   *
   * shortcut: a process that began at nothing and spends more on its first turn than the session had
   * before is taken to have carried on, and that earlier cost is lost; upgrade when the SDK says
   * whether a total carried on.
   */
  private cost(running: Running, said: number | null | undefined): number | null {
    const { sessionId } = running;
    const before = this.costs.get(sessionId);
    if (said === null || said === undefined) return before ?? null;
    let now: number;
    if (running.costSeen === null) now = said >= (before ?? 0) ? said : (before ?? 0) + said;
    else now = (before ?? 0) + (said >= running.costSeen ? said - running.costSeen : said);
    running.costSeen = said;
    this.costs.set(sessionId, now);
    return now;
  }

  /** The process went away. A turn it was in the middle of will never finish. */
  private ended(running: Running, failure: unknown): void {
    const { sessionId } = running;
    running.cancelIdle?.();
    if (this.live.get(sessionId) === running) this.live.delete(sessionId);
    for (const [id, pending] of this.approvals) {
      if (pending.sessionId !== sessionId) continue;
      this.approvals.delete(id);
      this.emit({ type: "approval.resolved", sessionId, approvalId: id });
    }
    if (failure && !running.closed) this.options.onLog?.(`claude: ${message(failure)}`);
    const turnId = running.turn;
    if (turnId === null) return;
    running.turn = null;
    this.emit({
      type: "turn.completed",
      sessionId,
      turnId,
      status: running.stopping ? "interrupted" : "failed",
      error: running.stopping
        ? null
        : `Claude Code stopped${failure ? `: ${message(failure)}` : ""}. It starts again with your next message.`,
      durationMs: null,
    });
  }

  /** Claude Code asks before a tool call it may not make unasked: the owner answers. */
  private ask(
    running: Running,
    tool: string,
    input: Record<string, unknown>,
    context: AskContext,
  ): Promise<WirePermissionResult> {
    const { sessionId } = running;
    const { tools } = this.options;
    // Cycle's own tools only read, and are the client's to offer.
    if (tools && tool.startsWith(`mcp__${tools.name}__`)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    const id = context.toolUseID;
    return new Promise((resolve) => {
      const settle = (result: WirePermissionResult) => {
        if (!this.approvals.delete(id)) return;
        context.signal.removeEventListener("abort", stopped);
        if (result.behavior === "deny") {
          running.reader.declined.add(id);
          if (result.interrupt) running.stopping = true;
        }
        this.emit({ type: "approval.resolved", sessionId, approvalId: id });
        resolve(result);
      };
      const stopped = () => settle({ behavior: "deny", message: "The turn was stopped." });
      this.approvals.set(id, {
        sessionId,
        answer: (response) => settle(toPermission(tool, input, context.suggestions, response)),
      });
      context.signal.addEventListener("abort", stopped);
      this.emit({
        type: "approval.requested",
        sessionId,
        turnId: running.turn,
        approval: toApproval(id, tool, input, {
          cwd: running.known.cwd,
          title: context.title,
          reason: context.decisionReason,
        }),
      });
    });
  }
}

/** A cut before a conversation's first turn, where there is no entry to end at. */
const CUT_START = "start";
