/**
 * The slice of the `codex app-server` v2 protocol this harness consumes.
 * Hand-written and deliberately loose: unknown fields and item types must
 * not break us. The full bindings come from
 * `codex app-server generate-ts --out <dir>`.
 */

export type WireStatus = "inProgress" | "completed" | "failed" | "declined" | "interrupted";

export type WireCommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export type WireUserInput =
  | { type: "text"; text: string; text_elements?: unknown[] }
  | { type: "image"; url?: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type WireItem =
  | { type: "userMessage"; id: string; content: WireUserInput[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: WireStatus;
      commandActions?: WireCommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: { path: string; kind: { type: string; move_path?: string | null }; diff: string }[];
      status: WireStatus;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: WireStatus;
      arguments: unknown;
      result: { content: unknown[]; structuredContent: unknown } | null;
      error: { message: string } | null;
      durationMs: number | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: unknown;
      status: WireStatus;
      contentItems: unknown[] | null;
      success: boolean | null;
      durationMs: number | null;
    }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: string;
      status: WireStatus;
      receiverThreadIds: string[];
      prompt: string | null;
    }
  | {
      type: "webSearch";
      id: string;
      query: string;
      action?: { type: string; url?: string | null } | null;
    }
  | { type: "imageView"; id: string; path: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };

/** An item of a type this harness does not know. */
export interface WireUnknownItem {
  type: string;
  id: string;
}

export interface WireTurn {
  id: string;
  items: (WireItem | WireUnknownItem)[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string; additionalDetails?: string | null } | null;
  startedAt: number | null;
  durationMs: number | null;
}

export interface WireThread {
  id: string;
  forkedFromId: string | null;
  preview: string;
  model: string | null;
  /** The codex model provider the thread began on, and stays with. */
  modelProvider: string;
  reasoningEffort: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  gitInfo: { branch: string | null } | null;
  name: string | null;
  turns: WireTurn[];
}

export interface WireThreadResponse {
  thread: WireThread;
  model: string;
  cwd: string;
  reasoningEffort: string | null;
}

export interface WireTokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface WireTokenUsage {
  total: WireTokenBreakdown;
  last: WireTokenBreakdown;
  modelContextWindow: number | null;
}

export interface WireModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string | null;
  inputModalities?: string[];
  isDefault: boolean;
}

export interface WireSkill {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: string;
  enabled: boolean;
}

export interface WireMcpServer {
  name: string;
  runtimeStatus: string | null;
  tools: Record<string, { description?: string | null } | undefined>;
  toolsError: string | null;
  authStatus: string;
}

export interface WireRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export type WireSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };
