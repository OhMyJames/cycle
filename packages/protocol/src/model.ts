/**
 * Harness-agnostic domain model. Everything above `harness/*` (daemon, UI,
 * desktop) speaks only these types, never a specific agent's wire format.
 */

export type ItemStatus = "running" | "completed" | "failed" | "declined";

/** What a shell command was for, when the harness can tell. */
export type CommandAction =
  | { type: "read"; path: string }
  | { type: "list"; path: string | null }
  | { type: "search"; query: string | null; path: string | null };

export interface FileChange {
  path: string;
  change: "add" | "delete" | "update";
  /** Set when an update also renames the file. */
  movePath?: string;
  /** Unified diff of this file. */
  diff: string;
}

interface ItemBase {
  id: string;
  /**
   * The `task` item this one is part of: what a helper agent did. Absent for the turn's own items.
   * A view shows it inside its task, and a task that ends ends what it left running.
   */
  parentId?: string;
}

/** What kind of work a task is. */
export type TaskKind = "agent" | "command" | "workflow" | "other";

/** Where a task is. Unlike an item's, it can outlive its turn: a task in the background goes on. */
export type TaskStatus = "pending" | "running" | "paused" | "completed" | "failed" | "stopped";

/** Whether a task can still change by itself. */
export function taskLive(status: TaskStatus): boolean {
  return status === "pending" || status === "running" || status === "paused";
}

export interface TaskUsage {
  tokens: number;
  toolUses: number;
  durationMs: number;
}

/** A task that runs in the background now, which the owner can stop by itself. */
export interface BackgroundTask {
  /** The harness's id for it, which `session.stopTask` takes. */
  id: string;
  task: TaskKind;
  description: string;
  /** A helper agent's kind, as `general-purpose`. */
  agent: string | null;
  /** The `task` item that shows it in the conversation, when there is one. */
  itemId: string | null;
}

export type Item =
  | (ItemBase & {
      kind: "userMessage";
      text: string;
      /** Paths or URLs of attached images. */
      images: string[];
      /** Documents attached beside them, by name. */
      documents?: { kind: DocumentKind; name: string }[];
    })
  | (ItemBase & {
      kind: "agentMessage";
      text: string;
      /** Questions it leaves the owner to answer when they like, each with answers to pick from. */
      questions?: { title: string; options: string[] }[];
    })
  | (ItemBase & { kind: "reasoning"; text: string })
  /** A plan the agent proposed, as markdown. */
  | (ItemBase & { kind: "plan"; text: string })
  | (ItemBase & {
      kind: "command";
      command: string;
      /** What the agent said the command is for, in a sentence: a row says it, and the command opens. */
      description?: string;
      cwd: string;
      output: string;
      exitCode: number | null;
      durationMs: number | null;
      actions: CommandAction[];
      status: ItemStatus;
    })
  | (ItemBase & {
      kind: "fileChange";
      changes: FileChange[];
      status: ItemStatus;
    })
  | (ItemBase & {
      kind: "toolCall";
      /** The MCP server, or null for a harness-native tool. */
      server: string | null;
      tool: string;
      /** JSON text of the arguments. */
      args: string;
      /** Text of the result, when there is one. */
      result: string | null;
      error: string | null;
      durationMs: number | null;
      status: ItemStatus;
    })
  | (ItemBase & { kind: "webSearch"; query: string })
  /** A call that reaches codex's helper agents, each a session of its own: spawn, send, wait, close. */
  | (ItemBase & {
      kind: "agentCall";
      /** What was asked of the other agents: spawn, send, wait, close. */
      tool: string;
      prompt: string | null;
      /** Sessions of the agents this call reached. */
      receivers: string[];
      status: ItemStatus;
    })
  /** An image the agent looked at, or made when `generated`. */
  | (ItemBase & {
      kind: "image";
      path: string;
      generated?: boolean;
      status?: ItemStatus;
    })
  /** The agent waited, on purpose, this long. */
  | (ItemBase & { kind: "wait"; durationMs: number; status: ItemStatus })
  /** What a hook of the owner's added to the conversation. */
  | (ItemBase & { kind: "hook"; text: string })
  /**
   * Work the agent handed off and is told about: a helper agent, a command or a workflow. It may go
   * on in the background after its turn ends. What a helper agent does names it as `parentId`.
   */
  | (ItemBase & {
      kind: "task";
      /** The harness's id for it, once it has started. */
      taskId: string | null;
      task: TaskKind;
      description: string;
      /** A helper agent's kind, as `general-purpose`. */
      agent: string | null;
      /** What it was asked to do. */
      prompt: string | null;
      status: TaskStatus;
      background: boolean;
      usage: TaskUsage | null;
      /** The latest word of how it goes, or of how it ended. */
      summary: string | null;
      error: string | null;
    })
  /**
   * News of one of codex's helper agents, which are sessions of their own rather than tasks inside
   * this one: it started, was messaged, was stopped or finished.
   */
  | (ItemBase & {
      kind: "agentActivity";
      activity: "started" | "interacted" | "interrupted" | "completed";
      /** The agent's name in the tree of agents, as `/root/explorer`. */
      agent: string;
      model: string | null;
    })
  | (ItemBase & { kind: "review"; phase: "entered" | "exited"; text: string })
  | (ItemBase & { kind: "compaction" })
  /** A harness item the protocol has no first-class shape for yet. */
  | (ItemBase & { kind: "other"; type: string });

export type ItemKind = Item["kind"];

export type TurnStatus = "completed" | "interrupted" | "failed";

/** Who began a turn. */
export type TurnOrigin =
  | { kind: "owner" }
  /** A schedule of the owner's ran its prompt. */
  | { kind: "schedule"; scheduleId: string }
  /** The agent took up the news of a task of its own that ended. */
  | { kind: "task"; taskId: string | null }
  /** Another session sent it something. */
  | { kind: "peer"; from: string | null }
  /** The agent began it for a reason the harness does not say. */
  | { kind: "agent" };

export interface Turn {
  id: string;
  /** Who began it. Absent: the owner. */
  origin?: TurnOrigin;
  status: "running" | TurnStatus;
  error: string | null;
  /** Milliseconds since the epoch, when the harness reports it. */
  startedAt: number | null;
  durationMs: number | null;
  items: Item[];
  /** Unified diff of everything the turn changed so far. */
  diff: string | null;
}

export interface PlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface Plan {
  explanation: string | null;
  steps: PlanStep[];
}

export interface TokenCount {
  total: number;
  /** Everything read, cached or not. */
  input: number;
  /** Of `input`, what was read from the cache. */
  cachedInput: number;
  /** Of `input`, what was written to the cache. */
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export interface Usage {
  /** Everything the session has used. */
  total: TokenCount;
  /** The latest request alone: `last.total` is what the context holds now. */
  last: TokenCount;
  contextWindow: number | null;
  /** What the session has cost, in US dollars, when the agent estimates it. */
  costUsd: number | null;
}

/** What a session's context holds now, part by part when its agent can tell. */
export interface ContextUsage {
  tokens: number;
  window: number | null;
  parts: ContextPart[];
}

export interface ContextPart {
  /** The agent's own name for the part, as `system_prompt` or `mcp_tools`; else its `name`. */
  id: string;
  name: string;
  tokens: number;
  /** `free` is room left; `buffer` is kept back for compaction; `deferred` is outside the window. */
  kind: "used" | "free" | "buffer" | "deferred";
}

/** A command a session's agent runs when a prompt begins with `/name`. */
export interface SlashCommand {
  name: string;
  description: string;
  /** What it takes after its name, as `<file>`. */
  argumentHint: string;
  aliases: string[];
  /** The agent's own, rather than the owner's, a project's or a plugin's. */
  builtin: boolean;
}

/** What putting a session's files back before a turn changes, or changed. */
export interface FileRewind {
  /** False when the agent cannot, with `error` saying why. */
  possible: boolean;
  error: string | null;
  files: string[];
  insertions: number;
  deletions: number;
}

/**
 * How much an agent may do unasked: the id of one of the modes its harness offers (`ModeInfo`).
 * Each agent names its own, so one id may mean different things on two agents.
 */
export type PermissionMode = string;

/**
 * Cycle's own modes from before each agent named its own, as stored then: `readOnly` asked before
 * any command or edit, `auto` worked inside the workspace, `fullAccess` never asked.
 */
export type LegacyMode = "readOnly" | "auto" | "fullAccess";

/** How a stored mode from before agents named their own is marked, to be read as `replaces` says. */
export const LEGACY_MODE_PREFIX = "legacy:";

/** One mode an agent offers. */
export interface ModeInfo {
  id: PermissionMode;
  /** The name of the harness that offers it. */
  harness: string;
  name: string;
  /** What it lets the agent do unasked, in a line. */
  description: string;
  /** It runs commands unasked with no sandbox. Never a default, and taken only by a press. */
  dangerous: boolean;
  /** The agent only plans, and changes nothing until the owner approves its plan. */
  plan: boolean;
  /** What a session of this agent starts in when the owner chose nothing. */
  isDefault: boolean;
  /** The mode of Cycle's own that this one is, for what was stored before. */
  replaces: LegacyMode | null;
}

/** An agent's modes from what each says of itself: the rest is the same for every mode. */
export function defineModes(
  harness: string,
  modes: (Partial<ModeInfo> & Pick<ModeInfo, "id" | "name" | "description">)[],
): ModeInfo[] {
  return modes.map((mode) => ({
    harness,
    dangerous: false,
    plan: false,
    isDefault: false,
    replaces: null,
    ...mode,
  }));
}

/** Marks a mode stored before agents named their own, so it is read by what it meant then. */
export function legacyMode(value: string): string {
  return value === "readOnly" || value === "auto" || value === "fullAccess"
    ? `${LEGACY_MODE_PREFIX}${value}`
    : value;
}

/**
 * The mode a stored or chosen value means among one agent's modes: its own id, or a marked legacy
 * mode by what it replaces. Anything else, or nothing, is the agent's default.
 */
export function resolveMode(
  modes: readonly ModeInfo[],
  value: string | null | undefined,
): ModeInfo | undefined {
  const legacy = value?.startsWith(LEGACY_MODE_PREFIX)
    ? value.slice(LEGACY_MODE_PREFIX.length)
    : null;
  const found = legacy
    ? modes.find((mode) => mode.replaces === legacy)
    : modes.find((mode) => mode.id === value);
  return found ?? modes.find((mode) => mode.isDefault) ?? modes[0];
}

/** What a session is doing: the three states a client reads, whether or not it is in memory. */
export type SessionActivity =
  | "idle"
  | "running"
  /** A turn is blocked on the owner: an approval or a question. */
  | "requires_action";

export interface WorktreeInfo {
  /** The repository the worktree was made from. */
  repo: string;
  /** The commit it started at, which its changes are read against. */
  base: string;
  branch: string;
  /** The worktree's root: its identity, and what removing it acts on. */
  path: string;
  /** Who made it: `owner` as the session was made, `agent` when the agent entered it. */
  origin: "owner" | "agent";
}

export interface Session {
  id: string;
  harness: string;
  /** The owner's name for it, else the harness's, else null. */
  title: string | null;
  /** Start of the first prompt, for when there is no title. */
  preview: string;
  cwd: string;
  model: string;
  effort: string | null;
  mode: PermissionMode;
  /** What it is doing. */
  activity: SessionActivity;
  /** The daemon holds the session in memory. */
  loaded: boolean;
  /** Its last turn ended in failure, or its agent exited under it: not working, and so `idle`. */
  failed: boolean;
  branch: string | null;
  worktree: WorktreeInfo | null;
  /**
   * The environment the owner chose for it, by id: where its agent runs. Null when none, and it runs
   * on this machine. The id stays when the environment is removed. It replaces `sandbox`.
   */
  environment: string | null;
  /** The sandbox its agent runs in, by name. Null when it runs on this machine. */
  sandbox: string | null;
  /** Where that sandbox sees the folder. Null when its paths are this machine's. */
  sandboxCwd: string | null;
  /** Folders beyond `cwd` its agent may reach. */
  directories: string[];
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  /** Something finished or asked since the owner last opened it. */
  unread: boolean;
  /** The session this one was forked from. */
  forkedFrom: string | null;
  /** A label the owner put on it, where the agent keeps one. Absent: none. */
  tag?: string;
  /** The schedule whose run started it. It stays after the schedule is deleted. */
  scheduleId: string | null;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface Question {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  /** Whether a free-text answer is offered beside the options. */
  allowOther: boolean;
  secret: boolean;
}

/**
 * A rule the agent offers with a request, which lets what is asked, and what is like it, through
 * without asking again. It holds for the rest of the session.
 *
 * shortcut: a rule is kept for the session alone; upgrade when Cycle keeps a Claude configuration
 * of its own, and a rule can be kept in it for the project or for the owner.
 */
export interface ApprovalRule {
  id: string;
  /** What it lets through, as `Bash(npm test:*)`, or a folder it opens. */
  label: string;
}

/** One field of a form an MCP server asks the owner to fill. */
export interface FormField {
  name: string;
  title: string;
  description: string;
  type: "string" | "number" | "integer" | "boolean";
  /** The values it may take, when it is one of a list. */
  options: string[] | null;
  required: boolean;
}

export type Approval =
  | {
      id: string;
      kind: "command";
      itemId: string;
      command: string | null;
      cwd: string | null;
      reason: string | null;
      /** Rules that would let it, and the like of it, through from now on. */
      rules?: ApprovalRule[];
      /** The owner may change the command before it runs. */
      editable?: boolean;
      /** The agent is told what the owner says on declining it. */
      notes?: boolean;
    }
  | {
      id: string;
      kind: "fileChange";
      itemId: string;
      reason: string | null;
      rules?: ApprovalRule[];
      notes?: boolean;
    }
  | {
      id: string;
      kind: "permissions";
      itemId: string;
      reason: string | null;
      summary: string;
    }
  /** Any other tool the agent asks to call. */
  | {
      id: string;
      kind: "tool";
      itemId: string;
      /** The MCP server, or null for one of the agent's own tools. */
      server: string | null;
      tool: string;
      /** JSON text of its input, which the owner may change before it runs. */
      input: string;
      /** The request as the agent puts it, as a sentence. */
      title: string | null;
      reason: string | null;
      rules: ApprovalRule[];
    }
  | { id: string; kind: "question"; itemId: string; questions: Question[] }
  /**
   * The agent finished planning and asks to go on. Approved, it works in the mode the owner picks
   * of `modes`; declined, it plans again, with what the owner said.
   */
  | { id: string; kind: "plan"; itemId: string; plan: string; modes: PermissionMode[] }
  /** An MCP server asks the owner for something: a form to fill, or a page to visit. */
  | {
      id: string;
      kind: "elicitation";
      itemId: string;
      server: string;
      message: string;
      /** A page to open and finish there. Null for a form. */
      url: string | null;
      /** The form's fields, or null when it is not one, or too involved to draw as fields. */
      fields: FormField[] | null;
      /** JSON text of the form's schema, for a form that has no `fields`. */
      schema: string | null;
    };

/** The owner's answer to an approval. What does not apply to its kind is ignored. */
export interface ApprovalAnswer {
  decision: ApprovalDecision;
  /** On accept: the offered rules, by id, to keep for the rest of the session. */
  rules?: string[];
  /** On accept: the command as the owner changed it, or a tool's input as JSON text. */
  edited?: string;
  /** On decline: what the agent is told, as why or what to do instead. */
  message?: string;
  /** On accepting a plan: the mode to work in. */
  mode?: PermissionMode;
  /** On accepting a form: what the owner filled in. */
  content?: Record<string, unknown>;
}

export type ApprovalResponse =
  | ApprovalAnswer
  /** For a `question` approval: answers by question id. */
  | { answers: Record<string, string[]> };

export interface QueuedMessage {
  id: string;
  text: string;
  images: string[];
  /**
   * The documents it carries, by name. Their data stays in the daemon until the prompt is sent, so a
   * session's state and the frames kept for a returning client never hold it.
   */
  documents?: { kind: DocumentKind; name: string }[];
}

export type DocumentKind = "pdf" | "text";
export type AttachmentKind = "image" | DocumentKind;

/** A document a prompt carries, beside its images. */
export interface PromptDocument {
  kind: DocumentKind;
  name: string;
  /** A base64 data URL. */
  data: string;
}

/**
 * What an agent can do beyond what every agent does. The page offers a session what its agent can,
 * and the daemon refuses the rest.
 */
export interface AgentCapabilities {
  /** What a prompt may carry. */
  attachments: AttachmentKind[];
  /** It can put the files back as they were before a turn, with the conversation. */
  rewindFiles: boolean;
  /** It lists the commands a prompt can begin with (`commands.list`); without, its skills. */
  commands: boolean;
  /** A session can reach folders beyond its own. */
  directories: boolean;
  /** Whether its MCP servers, skills and plugins can be changed in Cycle, or only read. */
  connector: "edit" | "read";
  /** Whether the owner signs in to it in Cycle. Without, its own command line does it. */
  login: boolean;
  /** It has switches of its own configuration: `features.*`. */
  features: boolean;
  /** Cycle keeps hooks for it, and can turn the owner's own off: `hooks.*`, `skills.enable`. */
  hooks: boolean;
  /** A server that failed can be connected again in a process that runs: `mcp.reconnect`. */
  mcpReconnect: boolean;
  /** It lists the helper agents a session can start: `subagents.list`. */
  subagents: boolean;
  /** A conversation can carry a tag the owner sets: `session.update`'s `tag`. */
  tags: boolean;
}

/** A helper agent an agent can start, as it lists them. */
export interface SubagentInfo {
  name: string;
  description: string;
  /** What it runs on: an alias or an id, or `inherit` for the session's. Null for the default. */
  model: string | null;
}

/** An agent the daemon runs, and what it can do. */
export interface AgentInfo {
  name: string;
  capabilities: AgentCapabilities;
}

/** What a code review reads. */
export type ReviewTarget =
  /** What is staged, unstaged and untracked in the session's folder. */
  | { kind: "uncommitted" }
  /** Everything since the current branch left this one. */
  | { kind: "branch"; branch: string }
  | { kind: "commit"; sha: string }
  | { kind: "custom"; instructions: string };

/** A change to one session's conversation. `sessionId` names the session. */
export type SessionEvent =
  | {
      type: "turn.started";
      sessionId: string;
      turnId: string;
      startedAt: number | null;
      /** Absent: the owner. */
      origin?: TurnOrigin;
    }
  | { type: "item.started"; sessionId: string; turnId: string; item: Item }
  /** Appends text to an item: message, reasoning or plan text, or command output. */
  | {
      type: "item.delta";
      sessionId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | { type: "item.completed"; sessionId: string; turnId: string; item: Item }
  | { type: "plan.updated"; sessionId: string; plan: Plan }
  | { type: "diff.updated"; sessionId: string; turnId: string; diff: string }
  | { type: "usage.updated"; sessionId: string; usage: Usage }
  | {
      type: "approval.requested";
      sessionId: string;
      turnId: string | null;
      approval: Approval;
    }
  | { type: "approval.resolved"; sessionId: string; approvalId: string }
  | { type: "queue.updated"; sessionId: string; queue: QueuedMessage[] }
  | {
      type: "turn.completed";
      sessionId: string;
      turnId: string;
      status: TurnStatus;
      error: string | null;
      durationMs: number | null;
    }
  /** Every task running in the background now, replacing the list before. It belongs to no turn. */
  | { type: "tasks.updated"; sessionId: string; tasks: BackgroundTask[] }
  /** The conversation went back to before this turn: it and every later turn are gone. */
  | { type: "turns.rewound"; sessionId: string; turnId: string }
  /** Something the owner should see that belongs to no item. */
  | {
      type: "notice";
      sessionId: string;
      level: "info" | "warning" | "error";
      message: string;
    };

export interface ModelInfo {
  id: string;
  /** The name of the harness that runs it. */
  harness: string;
  name: string;
  description: string;
  efforts: { id: string; description: string }[];
  defaultEffort: string | null;
  isDefault: boolean;
  /** Whether prompts to it may carry images. */
  images: boolean;
  /** Whether a session on it can run in a sandbox here. */
  sandbox: boolean;
  /** The owner's provider that serves it, or null when it is the agent's own. */
  provider: { id: string; name: string } | null;
}

/** A harness's name as the owner reads it: `codex` is Codex. */
export function harnessLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Whether a session on one model may move to the other. A session stays with
 * the harness it began on, and that agent keeps a conversation with the kind
 * of provider it began on: its own, or the owner's.
 */
export function sameModelFamily(
  a: Pick<ModelInfo, "harness" | "provider">,
  b: Pick<ModelInfo, "harness" | "provider">,
): boolean {
  return a.harness === b.harness && (a.provider === null) === (b.provider === null);
}

/** The protocols an endpoint of the owner's own may speak. */
export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/** The kind of a provider that is an endpoint the owner describes, not a known service. */
export const CUSTOM_PROVIDER_KIND = "custom";

export interface ProviderModel {
  id: string;
  name: string;
  /** Whether it can think before it answers. */
  reasoning: boolean;
  images: boolean;
  /** Tokens it can read, and the most it may write in one answer. */
  contextWindow: number;
  maxTokens: number;
}

/** A known service a provider can be for, with the models it is known to serve. */
export interface ProviderKind {
  id: string;
  name: string;
}

/** A model provider of the owner's. Its key stays in the daemon. */
export interface ModelProvider {
  id: string;
  name: string;
  /** A `ProviderKind` id, or `CUSTOM_PROVIDER_KIND`. */
  kind: string;
  /** What a custom endpoint speaks. Null for a known service. */
  api: ProviderApi | null;
  /** A custom endpoint's address, or another address for a known service. */
  baseUrl: string | null;
  hasKey: boolean;
  /** The models the owner chose to use. */
  models: ProviderModel[];
}

/** What the owner sends to add a provider, or to change the one with this id. */
export interface ModelProviderDraft {
  id?: string;
  name: string;
  kind: string;
  api: ProviderApi | null;
  baseUrl: string | null;
  /** A new key. Left out, the stored one stays. */
  apiKey?: string;
  models: ProviderModel[];
}

/**
 * What a session's sandbox is made with. The owner keeps a few, by name, and a new session chooses
 * one. A variable's value stays in the daemon: the page is given the names.
 */
export interface SandboxEnvironment {
  id: string;
  name: string;
  /** How many CPUs a sandbox may use. Null leaves it to Docker, which gives it all of them. */
  cpus: number | null;
  /** Its memory in GiB. Null leaves it to Docker, which gives it half of the machine's. */
  memoryGb: number | null;
  /** The hosts it may reach beyond what Docker allows every sandbox. */
  hosts: string[];
  /** The names of its environment variables. */
  variables: string[];
  /** A script run once in a new sandbox, in the folder. */
  setup: string;
}

/** What the owner sends to add an environment, or to change the one with this id. */
export interface SandboxEnvironmentDraft {
  id?: string;
  name: string;
  cpus: number | null;
  memoryGb: number | null;
  hosts: string[];
  /** Every variable by name. Null keeps the value stored under that name. */
  variables: Record<string, string | null>;
  setup: string;
}

/** A service a sandbox can be signed in to, and whether a secret is kept for it. */
export interface SandboxSecret {
  service: string;
  set: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
}

/** How an MCP server is reached. A stdio server's environment is named, never shown. */
export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: string[] }
  | { kind: "http"; url: string; bearerTokenEnvVar: string | null };

export interface McpServerInfo {
  name: string;
  enabled: boolean;
  /**
   * Where it is kept. `config`: in the configuration Cycle edits, so it can be changed and removed.
   * `owner`: in the owner's own configuration of the agent, which Cycle only turns on or off.
   * `plugin`: a plugin brings it, and it is changed through its plugin.
   */
  origin: "config" | "owner" | "plugin";
  /** Null when Cycle does not know how it is reached: a plugin's, or an owner's turned off. */
  transport: McpTransport | null;
  pluginId: string | null;
  status: "connected" | "failed" | "needsAuth" | "disabled" | "unknown";
  /** `none`: it asks for no sign-in. `token`: it reads a token from the environment. */
  auth: "none" | "signedOut" | "signedIn" | "token";
  tools: McpToolInfo[];
  error: string | null;
}

/** One of a server's tools. A tool turned off is known by its name only. */
export interface McpToolInfo {
  name: string;
  description: string;
  enabled: boolean;
  /** About how much of every request it takes, when it is on. */
  tokens: number | null;
}

/** Codex's switches of what it may do beyond its tools, as its own configuration says. */
export interface AgentFeatures {
  /** It may start helper agents. Their tools go with every request of a model that offers them. */
  subagents: boolean;
}

/** The events Claude Code runs a command hook on, by its names for them. */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
] as const;

/** A command an agent runs as the owner when one of its events comes. */
export interface HookInfo {
  /** Cycle's own name for it, stable while it is kept. */
  id: string;
  /** The agent's name for the event, as `PreToolUse`. */
  event: string;
  /** Which tools it is for, as the agent matches them; empty for all. */
  matcher: string;
  command: string;
  /** Seconds it may run; null for the agent's own limit. */
  timeout: number | null;
}

/**
 * What an agent's process is started with beyond its tools and settings: the agent's own options,
 * kept for it. A change reaches a session the next time its process starts.
 */
export interface RunSettings {
  /** Models to try, in order and comma-separated, when the one in use is overloaded. */
  fallbackModel: string | null;
  /** Most requests to the model one process makes; the agent counts them from the process's start. */
  maxTurns: number | null;
  /** Most the agent may spend, in USD, from its process's start. It then stops the turn. */
  maxBudgetUsd: number | null;
  /** The agent says, after a turn, what the owner might send next. */
  promptSuggestions: boolean;
}

/** The hooks Cycle keeps for an agent, and how much of the owner's own configuration applies. */
export interface HookSettings {
  hooks: HookInfo[];
  /** What a process is started with. */
  run: RunSettings;
  /** The owner's own hooks run. Off, every hook is off, Cycle's too: the agent has one switch. */
  ownerHooks: boolean;
  /** The owner's own configuration of the agent is read: their settings, servers, plugins, skills. */
  ownerSettings: boolean;
  /** Which change of them this is. A change sent with an older one is refused. */
  revision: number;
}

/** What the owner says about an MCP server of their own. */
export interface McpServerInput {
  name: string;
  transport:
    | {
        kind: "stdio";
        command: string;
        args: string[];
        /** A null value keeps the one stored under that name: the page never holds it. */
        env: Record<string, string | null>;
      }
    | { kind: "http"; url: string; bearerTokenEnvVar: string | null };
}

export interface PluginInfo {
  /** `name@marketplace`. */
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string | null;
  installed: boolean;
  enabled: boolean;
  /** False when it cannot be installed here, with `unavailable` saying why. */
  available: boolean;
  unavailable: string | null;
}

export interface PluginMarketplace {
  name: string;
  displayName: string;
  /** Where it was added from, when it is a folder or a repository on this machine. */
  path: string | null;
  plugins: PluginInfo[];
}

export interface PluginCatalog {
  marketplaces: PluginMarketplace[];
  /** Marketplaces that could not be read, each as one line. */
  errors: string[];
}

/** What a plugin brings, read before it is installed. */
export interface PluginDetail {
  plugin: PluginInfo;
  description: string;
  skills: { name: string; description: string }[];
  mcpServers: string[];
  hooks: number;
  apps: string[];
}

/** One of an account's usage limits. */
export interface LimitWindow {
  /** The agent's own name for it, as `five_hour` or `primary`. */
  id: string;
  /** As the owner reads it: "5-hour limit". */
  name: string;
  /** Null when the agent says only whether it is reached. */
  usedPercent: number | null;
  windowMinutes: number | null;
  /** Milliseconds since the epoch. */
  resetsAt: number | null;
  /** `warning`: close to it. `exceeded`: requests are refused, or paid for as overage. */
  status: "ok" | "warning" | "exceeded";
  /** Requests past it are being paid for as overage. */
  overage: boolean;
}

/** The owner's account with whoever serves a harness's models. No secret is in it. */
export interface AccountInfo {
  harness: string;
  /**
   * Null when signed out. `subscription`: a plan of the agent's maker, as ChatGPT's or Claude's.
   * `cloud`: a cloud provider serves it, which signs in on its own.
   */
  kind: "apiKey" | "chatgpt" | "subscription" | "cloud" | "other" | null;
  email: string | null;
  plan: string | null;
  organization: string | null;
  /** Who serves the models, when it is not the agent's maker: `bedrock`, `vertex`. */
  provider: string | null;
  /** Where the credential is read from, by name alone: never its value. */
  source: string | null;
  limits: LimitWindow[];
}

/** A sign-in under way: the owner finishes it in a browser at `url`. */
export interface AccountLogin {
  id: string;
  url: string;
}
