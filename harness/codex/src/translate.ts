import type {
  CommandAction,
  HarnessSession,
  Item,
  ItemStatus,
  McpServerInfo,
  ModelInfo,
  PromptInput,
  SessionMode,
  SkillInfo,
  TokenCount,
  Turn,
  Usage,
} from "@cycle/protocol";
import type {
  WireCommandAction,
  WireItem,
  WireMcpServer,
  WireModel,
  WireSandboxPolicy,
  WireSkill,
  WireStatus,
  WireThread,
  WireTokenBreakdown,
  WireTokenUsage,
  WireTurn,
  WireUnknownItem,
  WireUserInput,
} from "./wire.ts";

/** Pure translations between codex's wire shapes and Cycle's model. */

const STATUS: Record<WireStatus, ItemStatus> = {
  inProgress: "running",
  completed: "completed",
  failed: "failed",
  declined: "declined",
  interrupted: "failed",
};

function status(value: WireStatus | undefined): ItemStatus {
  return (value && STATUS[value]) ?? "running";
}

function json(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** The text of an MCP result: its text parts joined, else the JSON of the rest. */
function resultText(content: unknown[] | null | undefined, structured?: unknown): string | null {
  if (!content?.length) return structured == null ? null : json(structured);
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return json(part);
    })
    .join("\n");
}

function actions(raw: WireCommandAction[] | undefined): CommandAction[] {
  const out: CommandAction[] = [];
  for (const action of raw ?? []) {
    if (action.type === "read") out.push({ type: "read", path: action.path });
    else if (action.type === "listFiles") out.push({ type: "list", path: action.path });
    else if (action.type === "search") {
      out.push({ type: "search", query: action.query, path: action.path });
    }
  }
  return out;
}

function userText(content: WireUserInput[]): string {
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "skill") return `$${part.name}`;
      if (part.type === "mention") return `@${part.name}`;
      return "";
    })
    .join("");
}

function userImages(content: WireUserInput[]): string[] {
  const out: string[] = [];
  for (const part of content) {
    if (part.type === "image" && part.url) out.push(part.url);
    else if (part.type === "localImage") out.push(part.path);
  }
  return out;
}

const KNOWN = new Set([
  "userMessage",
  "agentMessage",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
]);

function isKnown(raw: WireItem | WireUnknownItem): raw is WireItem {
  return KNOWN.has(raw.type);
}

/** Translate a codex thread item into the harness-agnostic model. */
export function toItem(raw: WireItem | WireUnknownItem): Item {
  if (!isKnown(raw)) return { id: raw.id, kind: "other", type: raw.type };
  switch (raw.type) {
    case "userMessage":
      return {
        id: raw.id,
        kind: "userMessage",
        text: userText(raw.content),
        images: userImages(raw.content),
      };
    case "agentMessage":
      return { id: raw.id, kind: "agentMessage", text: raw.text };
    case "plan":
      return { id: raw.id, kind: "plan", text: raw.text };
    case "reasoning":
      return {
        id: raw.id,
        kind: "reasoning",
        text: (raw.summary.length ? raw.summary : raw.content).join("\n\n"),
      };
    case "commandExecution":
      return {
        id: raw.id,
        kind: "command",
        command: raw.command,
        cwd: raw.cwd,
        output: raw.aggregatedOutput ?? "",
        exitCode: raw.exitCode,
        durationMs: raw.durationMs,
        actions: actions(raw.commandActions),
        status: status(raw.status),
      };
    case "fileChange":
      return {
        id: raw.id,
        kind: "fileChange",
        changes: raw.changes.map((change) => ({
          path: change.path,
          change:
            change.kind.type === "add"
              ? "add"
              : change.kind.type === "delete"
                ? "delete"
                : "update",
          ...(change.kind.move_path ? { movePath: change.kind.move_path } : {}),
          diff: change.diff,
        })),
        status: status(raw.status),
      };
    case "mcpToolCall":
      return {
        id: raw.id,
        kind: "toolCall",
        server: raw.server,
        tool: raw.tool,
        args: json(raw.arguments),
        result: resultText(raw.result?.content, raw.result?.structuredContent),
        error: raw.error?.message ?? null,
        durationMs: raw.durationMs,
        status: status(raw.status),
      };
    case "dynamicToolCall":
      return {
        id: raw.id,
        kind: "toolCall",
        server: null,
        tool: raw.tool,
        args: json(raw.arguments),
        result: resultText(raw.contentItems),
        error: raw.success === false ? "The tool reported a failure." : null,
        durationMs: raw.durationMs,
        status: status(raw.status),
      };
    case "collabAgentToolCall":
      return {
        id: raw.id,
        kind: "agentCall",
        tool: raw.tool,
        prompt: raw.prompt,
        receivers: raw.receiverThreadIds,
        status: status(raw.status),
      };
    case "webSearch":
      return { id: raw.id, kind: "webSearch", query: raw.query || raw.action?.url || "" };
    case "imageView":
      return { id: raw.id, kind: "image", path: raw.path };
    case "enteredReviewMode":
      return { id: raw.id, kind: "review", phase: "entered", text: raw.review };
    case "exitedReviewMode":
      return { id: raw.id, kind: "review", phase: "exited", text: raw.review };
    case "contextCompaction":
      return { id: raw.id, kind: "compaction" };
  }
}

export function toTurn(raw: WireTurn): Turn {
  return {
    id: raw.id,
    status: raw.status === "inProgress" ? "running" : raw.status,
    error: raw.error?.message ?? null,
    startedAt: raw.startedAt === null ? null : raw.startedAt * 1000,
    durationMs: raw.durationMs,
    items: raw.items.map(toItem),
    diff: null,
  };
}

export function toSession(
  thread: WireThread,
  extra?: { model?: string; effort?: string | null },
): HarnessSession {
  return {
    id: thread.id,
    title: thread.name?.trim() || null,
    preview: thread.preview,
    cwd: thread.cwd,
    model: extra?.model ?? thread.model ?? "",
    effort: extra?.effort ?? thread.reasoningEffort,
    branch: thread.gitInfo?.branch ?? null,
    createdAt: thread.createdAt * 1000,
    updatedAt: thread.updatedAt * 1000,
    forkedFrom: thread.forkedFromId,
  };
}

function toCount(raw: WireTokenBreakdown): TokenCount {
  return {
    total: raw.totalTokens,
    input: raw.inputTokens,
    cachedInput: raw.cachedInputTokens,
    output: raw.outputTokens,
    reasoning: raw.reasoningOutputTokens,
  };
}

export function toUsage(raw: WireTokenUsage): Usage {
  return {
    total: toCount(raw.total),
    last: toCount(raw.last),
    contextWindow: raw.modelContextWindow,
  };
}

export function toModel(raw: WireModel): ModelInfo {
  return {
    id: raw.model || raw.id,
    name: raw.displayName || raw.model,
    description: raw.description,
    efforts: raw.supportedReasoningEfforts.map((effort) => ({
      id: effort.reasoningEffort,
      description: effort.description,
    })),
    defaultEffort: raw.defaultReasoningEffort,
    isDefault: raw.isDefault,
    images: raw.inputModalities?.includes("image") ?? true,
    provider: null,
  };
}

export function toSkill(raw: WireSkill): SkillInfo {
  return {
    name: raw.name,
    description: raw.shortDescription ?? raw.description,
    path: raw.path,
    scope: raw.scope,
    enabled: raw.enabled,
  };
}

export function toMcpServer(raw: WireMcpServer): McpServerInfo {
  const needsAuth =
    raw.runtimeStatus === "authenticationRequired" || raw.authStatus === "notLoggedIn";
  const state: McpServerInfo["status"] = needsAuth
    ? "needsAuth"
    : raw.runtimeStatus === "connected"
      ? "connected"
      : raw.runtimeStatus === "starting"
        ? "connecting"
        : raw.runtimeStatus === "failed"
          ? "failed"
          : "unknown";
  return {
    name: raw.name,
    status: state,
    tools: Object.entries(raw.tools).map(([name, tool]) => ({
      name,
      description: tool?.description ?? "",
    })),
    error: raw.toolsError,
  };
}

export function toInput(input: PromptInput): WireUserInput[] {
  const out: WireUserInput[] = [];
  if (input.text) out.push({ type: "text", text: input.text, text_elements: [] });
  for (const image of input.images) {
    if (/^(data:|https?:)/.test(image)) out.push({ type: "image", url: image });
    else out.push({ type: "localImage", path: image });
  }
  return out;
}

/** How each of Cycle's modes is put to codex: when it asks, and what it may touch. */
export function modePolicy(mode: SessionMode): {
  approvalPolicy: "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  sandboxPolicy: WireSandboxPolicy;
} {
  switch (mode) {
    case "readOnly":
      return {
        approvalPolicy: "on-request",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "fullAccess":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}
