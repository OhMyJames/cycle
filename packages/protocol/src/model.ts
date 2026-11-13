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
}

export type Item =
  | (ItemBase & {
      kind: "userMessage";
      text: string;
      /** Paths or URLs of attached images. */
      images: string[];
    })
  | (ItemBase & { kind: "agentMessage"; text: string })
  | (ItemBase & { kind: "reasoning"; text: string })
  /** A plan the agent proposed, as markdown. */
  | (ItemBase & { kind: "plan"; text: string })
  | (ItemBase & {
      kind: "command";
      command: string;
      cwd: string;
      output: string;
      exitCode: number | null;
      durationMs: number | null;
      actions: CommandAction[];
      status: ItemStatus;
    })
  | (ItemBase & { kind: "fileChange"; changes: FileChange[]; status: ItemStatus })
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
  | (ItemBase & {
      kind: "agentCall";
      /** What was asked of the other agents: spawn, send, wait, close. */
      tool: string;
      prompt: string | null;
      /** Sessions of the agents this call reached. */
      receivers: string[];
      status: ItemStatus;
    })
  | (ItemBase & { kind: "image"; path: string })
  | (ItemBase & { kind: "review"; phase: "entered" | "exited"; text: string })
  | (ItemBase & { kind: "compaction" })
  /** A harness item the protocol has no first-class shape for yet. */
  | (ItemBase & { kind: "other"; type: string });

export type ItemKind = Item["kind"];

export type TurnStatus = "completed" | "interrupted" | "failed";

export interface Turn {
  id: string;
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
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

export interface Usage {
  /** Everything the session has used. */
  total: TokenCount;
  /** The latest request alone: `last.total` is what the context holds now. */
  last: TokenCount;
  contextWindow: number | null;
}

/**
 * How much an agent may do unasked.
 * - `readOnly`: reads freely, asks before any command or edit.
 * - `auto`: edits and runs inside the workspace, asks to leave it.
 * - `fullAccess`: never asks and has no sandbox.
 */
export type SessionMode = "readOnly" | "auto" | "fullAccess";

export const SESSION_MODES: readonly SessionMode[] = ["readOnly", "auto", "fullAccess"];

export type SessionStatus =
  /** Known to the harness but not loaded into memory. */
  | "stored"
  | "idle"
  | "running"
  /** A turn is blocked on the owner: an approval or a question. */
  | "waiting"
  | "error";

export interface WorktreeInfo {
  /** The repository the worktree was made from. */
  repo: string;
  /** The commit it started at, which its changes are read against. */
  base: string;
  branch: string;
}

export interface SessionInfo {
  id: string;
  harness: string;
  /** The owner's name for it, else the harness's, else null. */
  title: string | null;
  /** Start of the first prompt, for when there is no title. */
  preview: string;
  cwd: string;
  model: string;
  effort: string | null;
  mode: SessionMode;
  status: SessionStatus;
  branch: string | null;
  worktree: WorktreeInfo | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  /** Something finished or asked since the owner last opened it. */
  unread: boolean;
  /** The session this one was forked from. */
  forkedFrom: string | null;
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

export type Approval =
  | {
      id: string;
      kind: "command";
      itemId: string;
      command: string | null;
      cwd: string | null;
      reason: string | null;
    }
  | { id: string; kind: "fileChange"; itemId: string; reason: string | null }
  | { id: string; kind: "permissions"; itemId: string; reason: string | null; summary: string }
  | { id: string; kind: "question"; itemId: string; questions: Question[] };

export type ApprovalResponse =
  | { decision: ApprovalDecision }
  /** For a `question` approval: answers by question id. */
  | { answers: Record<string, string[]> };

export interface QueuedMessage {
  id: string;
  text: string;
  images: string[];
}

/** A change to one session's conversation. `sessionId` names the session. */
export type SessionEvent =
  | { type: "turn.started"; sessionId: string; turnId: string; startedAt: number | null }
  | { type: "item.started"; sessionId: string; turnId: string; item: Item }
  /** Appends text to an item: message, reasoning or plan text, or command output. */
  | { type: "item.delta"; sessionId: string; turnId: string; itemId: string; delta: string }
  | { type: "item.completed"; sessionId: string; turnId: string; item: Item }
  | { type: "plan.updated"; sessionId: string; plan: Plan }
  | { type: "diff.updated"; sessionId: string; turnId: string; diff: string }
  | { type: "usage.updated"; sessionId: string; usage: Usage }
  | { type: "approval.requested"; sessionId: string; turnId: string | null; approval: Approval }
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
  /** Something the owner should see that belongs to no item. */
  | { type: "notice"; sessionId: string; level: "info" | "warning" | "error"; message: string };

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  efforts: { id: string; description: string }[];
  defaultEffort: string | null;
  isDefault: boolean;
  /** Whether prompts to it may carry images. */
  images: boolean;
  /** The owner's provider that serves it, or null when it is the agent's own. */
  provider: { id: string; name: string } | null;
}

/**
 * Whether a session on one model may move to the other. The agent keeps a
 * conversation with the kind of provider it began on: its own, or the owner's.
 */
export function sameModelFamily(
  a: Pick<ModelInfo, "provider">,
  b: Pick<ModelInfo, "provider">,
): boolean {
  return (a.provider === null) === (b.provider === null);
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
  /** Null for a server a plugin brings: it is changed through its plugin. */
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

/** What the agent can do beyond its tools, as the harness's own configuration says. */
export interface AgentFeatures {
  /** It may start helper agents. Their tools go with every request of a model that offers them. */
  subagents: boolean;
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

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface AccountInfo {
  /** Null when signed out. */
  kind: "apiKey" | "chatgpt" | "other" | null;
  email: string | null;
  plan: string | null;
  limits: { primary: RateLimitWindow | null; secondary: RateLimitWindow | null } | null;
}

/** A sign-in under way: the owner finishes it in a browser at `url`. */
export interface AccountLogin {
  id: string;
  url: string;
}
