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
  /** A `permission_denied` message: the call refused without asking. Its reason is `message`. */
  tool_use_id?: string;
}

/** One stored message of a session, as `getSessionMessages` gives it. */
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
