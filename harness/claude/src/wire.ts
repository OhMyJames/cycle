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
}

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
  /** Who a `result`'s turn was for, when not the owner: as a task's news. */
  origin?: WireOrigin;
  // A task's news: `system` messages with a `task_*` subtype.
  task_id?: string;
  /** The tool call that started the task. */
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
