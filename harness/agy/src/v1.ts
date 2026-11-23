import type { PromptCapabilities } from "@cycle/protocol";

/**
 * Minimum `agy` version required for reliable ACP v1 behavior (1.5.10 fixed background task wake-up delivery
 * and cancelling sub-agents/background tasks on `session/cancel`; 1.5.9/1.5.4 fixed login fallback and approvals).
 */
export const AGY_MIN_VERSION = "1.5.10";

export const AGY_PROMPT_CAPABILITIES = {
  image: {},
  embeddedContext: {},
} as const satisfies PromptCapabilities;

/** Parse a leading `major.minor.patch` triple from an agy version string (e.g. `"1.5.15"` or `"1.5.15-rc.1"`). */
export const parseVersion = (raw: string): [number, number, number] | undefined => {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const isVersionSupported = (raw: string, min: string = AGY_MIN_VERSION): boolean => {
  const actual = parseVersion(raw);
  const required = parseVersion(min);
  if (!actual || !required) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((actual[i] as number) !== (required[i] as number)) {
      return (actual[i] as number) > (required[i] as number);
    }
  }
  return true;
};

// Minimal ACP v1 wire types used between harness/agy and agy acp.
// Kept local so this package stays strictly on the experimental/v2 ACP SDK entry point.

export type V1InitializeResult = {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: Record<string, unknown>;
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    auth?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
};

export type V1ConfigOptionChoice = {
  value: string;
  name: string;
  description?: string;
};

export type V1ConfigOption = {
  id: string;
  name: string;
  category?: string;
  type: "select" | string;
  currentValue: string;
  options?: V1ConfigOptionChoice[];
};

export type V1ModeInfo = {
  id: string;
  name: string;
  description?: string;
};

export type V1ModelInfo = {
  modelId: string;
  name: string;
};

export type V1SessionResponse = {
  sessionId: string;
  modes?: {
    currentModeId: string;
    availableModes: V1ModeInfo[];
  };
  models?: {
    currentModelId: string;
    availableModels: V1ModelInfo[];
  };
  configOptions?: V1ConfigOption[];
  _meta?: Record<string, unknown>;
};

export type V1ResumeResponse = Omit<V1SessionResponse, "sessionId"> & {
  sessionId?: string;
};

export type V1PromptResult = {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
};

export type V1PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
};

export type V1PermissionRequest = {
  sessionId: string;
  toolCall: V1ToolCallPayload;
  options: V1PermissionOption[];
};

export type V1ElicitationRequest = {
  sessionId: string;
  toolCallId?: string;
  mode?: string;
  message?: string;
  requestedSchema?: Record<string, unknown>;
  [key: string]: unknown;
};

export type V1ToolCallContent =
  | { type: "content"; content: Record<string, unknown> }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type V1ToolCallPayload = {
  sessionUpdate?: string;
  toolCallId: string;
  name?: string;
  args?: Record<string, unknown>;
  title?: string;
  kind?: string;
  status?: string;
  locations?: Array<{ path: string; line?: number | null }>;
  content?: V1ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type V1SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: Record<string, unknown> }
  | { sessionUpdate: "agent_thought_chunk"; content: Record<string, unknown> }
  | { sessionUpdate: "user_message_chunk"; content: Record<string, unknown> }
  | ({ sessionUpdate: "tool_call" } & V1ToolCallPayload)
  | ({ sessionUpdate: "tool_call_update" } & V1ToolCallPayload)
  | {
      sessionUpdate: "plan";
      entries: Array<{ content: string; priority?: string; status: string }>;
    }
  | {
      sessionUpdate: "available_commands_update";
      availableCommands: Array<{
        name: string;
        description: string;
        input?: { hint: string } | null;
      }>;
    }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: V1ConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null }
  | {
      sessionUpdate: "usage_update";
      used: number;
      size: number;
      cost?: { amount: number; currency: string } | null;
    }
  | { sessionUpdate: string; [key: string]: unknown };

export type V1UpdateNotification = {
  sessionId: string;
  update: V1SessionUpdate;
};
