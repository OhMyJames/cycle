/**
 * What the Claude Agent SDK streams and stores, narrowed to the fields this
 * harness reads. The SDK's own types are wider and move with each release;
 * these say what is depended on.
 */

/** One block of a message's content, as the Messages API has it. */
export interface WireBlock {
  type: string;
  text?: string;
  thinking?: string;
  /** A `tool_use` block's id, tool and arguments. */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** A `tool_result` block: whose result it is, and what it said. */
  tool_use_id?: string;
  content?: string | WireBlock[];
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  /** A `document` block's name. */
  title?: string;
}

export interface WireUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

export interface WireApiMessage {
  id?: string;
  role?: string;
  model?: string;
  content?: string | WireBlock[];
  usage?: WireUsage;
}

export interface WireStreamEvent {
  type: string;
  index?: number;
  message?: { id?: string };
  content_block?: WireBlock;
  delta?: { type: string; text?: string; thinking?: string };
}

/** What each model used since the process started. */
export interface WireModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  costUSD?: number;
}

/** A `rate_limit_event`'s news of one of a subscription's limits. */
export interface WireRateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  /** Seconds since the epoch. */
  resetsAt?: number;
  rateLimitType?: string;
  /** From 0 to 1. */
  utilization?: number;
  isUsingOverage?: boolean;
}

export interface WireSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  builtin?: boolean;
}

/** Who is signed in. Of the credential, only where it is read from: no value. */
export interface WireAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

export interface WireMcpServerStatus {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  error?: string;
  /** Its headers and environment hold secrets: only the names of the latter are ever read. */
  config?: {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  };
  scope?: string;
  source?: string;
  tools?: { name: string; description?: string }[];
}

export interface WireContextUsage {
  categories: {
    id?: string;
    name: string;
    tokens: number;
    kind: "used" | "free" | "buffer" | "deferred";
  }[];
  totalTokens: number;
  maxTokens: number;
}

export interface WireRewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/** Claude Code's modes, as it names them. */
export type WirePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/** One message of a running query's stream. */
export interface WireMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  /** Set on what a helper agent said: the tool call that started it. */
  parent_tool_use_id?: string | null;
  message?: WireApiMessage;
  /** A tool's result as data, beside the text the model reads. */
  tool_use_result?: unknown;
  event?: WireStreamEvent;
  // A `result` message, which ends a turn.
  is_error?: boolean;
  duration_ms?: number;
  errors?: string[];
  result?: string;
  /** The prompts the turn took in: the one that began it, and any that joined it. */
  user_message_uuids?: string[];
  modelUsage?: Record<string, WireModelUsage>;
  /** A `status` message: the mode the process is in now, which the model may have changed. */
  permissionMode?: string;
  /** What the process has cost so far, in all. */
  total_cost_usd?: number;
  // `api_retry`: a request failed and is made again.
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  /** `model_refusal_*`: what the model's refusal came to, said for the owner. */
  content?: string;
  original_model?: string;
  /** `model_refusal_fallback`: the model the turn was tried on instead. */
  fallback_model?: string;
  direction?: string;
  scope?: string;
  /** A `rate_limit_event`. */
  rate_limit_info?: WireRateLimitInfo;
  /** A `commands_changed` system message: the whole list. */
  commands?: WireSlashCommand[];
  /** Who a `result`'s turn was for, when not the owner: as a task's news. */
  origin?: WireOrigin;
  // A task's news: `system` messages with a `task_*` subtype.
  task_id?: string;
  /**
   * The tool call that started the task; in a `permission_denied` message, the call refused
   * without asking, whose reason is `message`.
   */
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  /** `local_agent`, `local_bash`, `local_workflow`, and more. */
  task_type?: string;
  is_backgrounded?: boolean;
  /** The task whose agent started this one. */
  parent_task_id?: string;
  prompt?: string;
  /** A task to keep out of the conversation. */
  skip_transcript?: boolean;
  patch?: { status?: string; description?: string; error?: string; is_backgrounded?: boolean };
  /** How a task ended: `completed`, `failed` or `stopped`. */
  status?: string;
  summary?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  /** `background_tasks_changed`: every one running now. */
  tasks?: WireBackgroundTask[];
  // `tool_progress`: how long a tool call has run.
  elapsed_time_seconds?: number;
}

export interface WireOrigin {
  kind: string;
  from?: string;
  fromSession?: string;
}

export interface WireBackgroundTask {
  task_id: string;
  task_type: string;
  subagent_type?: string;
  description: string;
  /** Not work of the agent's, as a watcher: not shown as activity. */
  ambient?: boolean;
}

/**
 * One stored message of a session, as `getSessionMessages` gives it, or of a helper agent's
 * conversation, as `getSubagentMessages` does: those name the tool call that started the agent.
 */
export interface WireHistoryMessage {
  type: string;
  uuid: string;
  message: unknown;
  parent_tool_use_id?: string | null;
}

export interface WireSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  createdAt?: number;
  archived?: boolean;
}

export interface WireModelInfo {
  /** What the model is asked for by: an alias, as `sonnet`. */
  value: string;
  /** The model the alias means now. */
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportedEffortLevels?: string[];
}

/** A change to what the agent may do unasked, which it offers with a request for permission. */
export interface WirePermissionUpdate {
  type: string;
  destination?: string;
  [key: string]: unknown;
}

export type WirePermissionResult =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
      updatedPermissions?: WirePermissionUpdate[];
    }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/** What an MCP server asks the owner for: a form, or a page to visit. */
export interface WireElicitation {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  requestedSchema?: Record<string, unknown>;
}

export interface WireElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** A prompt as the SDK takes it. `uuid` is what the stored conversation knows it by. */
export interface WireUserMessage {
  type: "user";
  uuid: string;
  session_id: string;
  parent_tool_use_id: null;
  message: { role: "user"; content: WireBlock[] };
  /** `next` joins the turn that is running at its next tool call. */
  priority?: "now" | "next" | "later";
}
