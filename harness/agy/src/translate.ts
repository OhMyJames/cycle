import type { SessionUpdate, ToolCallStatus } from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import type { V1SessionUpdate, V1ToolCallPayload } from "./v1.ts";

const VALID_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

const VALID_STATUSES = new Set<ToolCallStatus>(["pending", "in_progress", "completed", "failed"]);

const normalizeKind = (kind?: string) => (kind && VALID_KINDS.has(kind) ? kind : "other");

const normalizeStatus = (status?: string): ToolCallStatus =>
  status && VALID_STATUSES.has(status as ToolCallStatus)
    ? (status as ToolCallStatus)
    : "in_progress";

/** Extract structured `_meta["cycle/toolResult"]` where agy gives exact numbers (e.g. command exit code). */
const toolResultMeta = (payload: V1ToolCallPayload): Record<string, unknown> | undefined => {
  if (payload.status !== "completed" && payload.status !== "failed") return undefined;
  const raw = payload.rawOutput as Record<string, unknown> | undefined;
  if (
    payload.kind === "execute" &&
    raw &&
    typeof raw.exit_code === "number" &&
    Number.isInteger(raw.exit_code) &&
    raw.exit_code >= 0
  ) {
    return { [META.toolResult]: { run: { exitCode: raw.exit_code } } };
  }
  return undefined;
};

export const toV2ToolCallUpdate = (payload: V1ToolCallPayload): SessionUpdate => {
  const meta = toolResultMeta(payload);
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: payload.toolCallId,
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    title: payload.title ?? payload.name ?? "Tool",
    kind: normalizeKind(payload.kind),
    status: normalizeStatus(payload.status),
    ...(payload.locations !== undefined ? { locations: payload.locations } : {}),
    ...(payload.content !== undefined ? { content: payload.content } : {}),
    ...(payload.rawInput !== undefined ? { rawInput: payload.rawInput } : {}),
    ...(payload.rawOutput !== undefined ? { rawOutput: payload.rawOutput } : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
  } as SessionUpdate;
};

/**
 * Translate a single ACP v1 `session/update` payload into ACP v2.
 * Returns `undefined` for updates handled specially by the adapter (like config/mode updates)
 * or unknown future v1 updates that should be dropped safely.
 */
export const translateSimpleUpdate = (
  update: V1SessionUpdate,
  messageId: string,
  logUnknown: (kind: string) => void,
): SessionUpdate | undefined => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return {
        sessionUpdate: update.sessionUpdate,
        messageId,
        content: update.content,
      } as SessionUpdate;
    case "tool_call":
    case "tool_call_update":
      return toV2ToolCallUpdate(update as V1ToolCallPayload);
    case "plan":
      return {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: messageId,
          entries: (update as { entries: unknown[] }).entries,
        },
      } as SessionUpdate;
    case "session_info_update":
      return {
        sessionUpdate: "session_info_update",
        ...((update as { title?: string | null }).title !== undefined
          ? { title: (update as { title?: string | null }).title }
          : {}),
        ...((update as { updatedAt?: string | null }).updatedAt !== undefined
          ? { updatedAt: (update as { updatedAt?: string | null }).updatedAt }
          : {}),
      } as SessionUpdate;
    case "usage_update": {
      const u = update as {
        used: number;
        size: number;
        cost?: { amount: number; currency: string } | null;
      };
      return {
        sessionUpdate: "usage_update",
        used: u.used,
        size: u.size,
        ...(u.cost != null ? { cost: u.cost } : {}),
      } as SessionUpdate;
    }
    case "available_commands_update":
      return {
        sessionUpdate: "available_commands_update",
        availableCommands: (update as { availableCommands: unknown[] }).availableCommands,
      } as SessionUpdate;
    case "user_message_chunk":
      return undefined;
    default:
      logUnknown(String(update.sessionUpdate));
      return undefined;
  }
};
