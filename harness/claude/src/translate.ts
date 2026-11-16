import { toMachinePath } from "@cycle/protocol";
import type {
  AccountInfo,
  Approval,
  ApprovalResponse,
  CommandAction,
  ContextUsage,
  DocumentKind,
  FileRewind,
  HarnessSession,
  Item,
  ItemStatus,
  LimitWindow,
  McpServerInfo,
  ModelInfo,
  PromptInput,
  Question,
  ReviewTarget,
  SessionEvent,
  SessionMode,
  SkillInfo,
  SlashCommand,
  TokenCount,
  Turn,
} from "@cycle/protocol";
import type {
  WireAccountInfo,
  WireApiMessage,
  WireBlock,
  WireContextUsage,
  WireHistoryMessage,
  WireMcpServerStatus,
  WireMessage,
  WireModelInfo,
  WireModelUsage,
  WirePermissionResult,
  WirePermissionUpdate,
  WireRateLimitInfo,
  WireRewindFilesResult,
  WireSessionInfo,
  WireSlashCommand,
  WireUsage,
  WireUserMessage,
} from "./wire.ts";

/** What this harness is known by: on its sessions, its models and its events. */
export const HARNESS_NAME = "claude";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function blocksOf(content: WireApiMessage["content"]): WireBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content : [];
}

// Tools

function linesOf(body: string): string[] {
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A change whose place in the file is not known: what went, then what came. */
function bareDiff(before: string, after: string): string {
  return [
    ...linesOf(before).map((line) => `-${line}`),
    ...linesOf(after).map((line) => `+${line}`),
  ].join("\n");
}

/** The hunks Claude Code reports once an edit is made, as a unified diff. */
function patchDiff(hunks: unknown): string | null {
  if (!Array.isArray(hunks) || hunks.length === 0) return null;
  return hunks
    .map((raw) => {
      const hunk = record(raw);
      const lines = Array.isArray(hunk["lines"]) ? hunk["lines"].map(String) : [];
      return [
        `@@ -${Number(hunk["oldStart"])},${Number(hunk["oldLines"])} +${Number(hunk["newStart"])},${Number(hunk["newLines"])} @@`,
        ...lines,
      ].join("\n");
    })
    .join("\n");
}

/** A tool call as it begins, in the shape the conversation shows it. */
export function toolItem(
  id: string,
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  sandboxCwd: string | null = null,
): Item {
  /** The path as this machine knows it: a sandbox names the folder its own way. */
  const at = (path: string): string => toMachinePath(path, { cwd, sandboxCwd });
  const status: ItemStatus = "running";
  const command = (line: string, actions: CommandAction[]): Item => ({
    id,
    kind: "command",
    command: line,
    cwd,
    output: "",
    exitCode: null,
    durationMs: null,
    actions,
    status,
  });
  const change = (path: unknown, before: unknown, after: unknown): Item => ({
    id,
    kind: "fileChange",
    changes: [{ path: text(path), change: "update", diff: bareDiff(text(before), text(after)) }],
    status,
  });
  switch (name) {
    case "Bash":
      return command(text(input["command"]), []);
    case "Read": {
      const path = at(text(input["file_path"]));
      return command(`Read ${path}`, [{ type: "read", path }]);
    }
    case "Glob":
    case "Grep": {
      const query = text(input["pattern"]);
      const path = text(input["path"]);
      return command(`${name} ${query}`, [{ type: "search", query, path: path ? at(path) : null }]);
    }
    case "Edit":
      return change(at(text(input["file_path"])), input["old_string"], input["new_string"]);
    case "Write":
      return change(at(text(input["file_path"])), "", input["content"]);
    case "NotebookEdit":
      return change(at(text(input["notebook_path"])), "", input["new_source"]);
    case "MultiEdit": {
      const edits = Array.isArray(input["edits"]) ? input["edits"].map(record) : [];
      return {
        id,
        kind: "fileChange",
        changes: [
          {
            path: at(text(input["file_path"])),
            change: "update",
            diff: edits
              .map((edit) => bareDiff(text(edit["old_string"]), text(edit["new_string"])))
              .join("\n"),
          },
        ],
        status,
      };
    }
    case "WebSearch":
      return { id, kind: "webSearch", query: text(input["query"]) };
    case "Agent":
    case "Task":
      return {
        id,
        kind: "agentCall",
        tool: "spawn",
        prompt: text(input["prompt"]) || text(input["description"]) || null,
        receivers: [],
        status,
      };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return {
        id,
        kind: "toolCall",
        server: mcp?.[1] ?? null,
        tool: mcp?.[2] ?? name,
        args: JSON.stringify(input),
        result: null,
        error: null,
        durationMs: null,
        status,
      };
    }
  }
}

function resultText(block: WireBlock): string {
  if (typeof block.content === "string") return block.content;
  return (block.content ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

/**
 * A tool call once its result is in. `structured` is the result as data, which
 * only a running session has: a stored one is read from the text alone.
 */
export function finishTool(
  item: Item,
  result: WireBlock,
  structured: unknown,
  declined: boolean,
): Item {
  const failed = result.is_error === true;
  const status: ItemStatus = declined ? "declined" : failed ? "failed" : "completed";
  const said = resultText(result);
  const data = record(structured);
  switch (item.kind) {
    case "command": {
      const ran = typeof data["stdout"] === "string";
      // What a file held is on disk: only a read that failed has something to say.
      const read = item.actions.some((action) => action.type === "read");
      const output = ran
        ? [text(data["stdout"]), text(data["stderr"])].filter(Boolean).join("\n")
        : read && !failed
          ? ""
          : said;
      const code = /^Exit code (\d+)/.exec(said);
      return {
        ...item,
        output,
        exitCode: declined ? null : failed ? Number(code?.[1] ?? 1) : 0,
        status,
      };
    }
    case "fileChange": {
      const diff = patchDiff(data["structuredPatch"]);
      const [first, ...rest] = item.changes;
      if (!first) return { ...item, status };
      return {
        ...item,
        status,
        changes: [
          {
            ...first,
            change: data["type"] === "create" ? "add" : first.change,
            diff: diff ?? first.diff,
          },
          ...rest,
        ],
      };
    }
    case "toolCall":
      return { ...item, status, result: failed ? null : said, error: failed ? said : null };
    case "agentCall":
      return { ...item, status };
    default:
      return item;
  }
}

// A running session

export function toCount(usage: WireUsage | undefined): TokenCount {
  const cached = usage?.cache_read_input_tokens ?? 0;
  const written = usage?.cache_creation_input_tokens ?? 0;
  const input = (usage?.input_tokens ?? 0) + cached + written;
  const output = usage?.output_tokens ?? 0;
  return {
    total: input + output,
    input,
    cachedInput: cached,
    cacheWrite: written,
    output,
    reasoning: 0,
  };
}

export const NO_TOKENS: TokenCount = {
  total: 0,
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
};

export function addCounts(a: TokenCount, b: TokenCount): TokenCount {
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** What a process used since it started, over every model it asked, and the most one can read. */
export function usedBy(models: Record<string, WireModelUsage> | undefined): {
  count: TokenCount;
  contextWindow: number | null;
  costUsd: number | null;
} {
  let count = NO_TOKENS;
  let contextWindow: number | null = null;
  let costUsd: number | null = null;
  for (const used of Object.values(models ?? {})) {
    const cached = used.cacheReadInputTokens ?? 0;
    const written = used.cacheCreationInputTokens ?? 0;
    const input = (used.inputTokens ?? 0) + cached + written;
    const output = used.outputTokens ?? 0;
    count = addCounts(count, {
      total: input + output,
      input,
      cachedInput: cached,
      cacheWrite: written,
      output,
      reasoning: 0,
    });
    if (used.contextWindow) contextWindow = Math.max(contextWindow ?? 0, used.contextWindow);
    if (used.costUSD !== undefined) costUsd = (costUsd ?? 0) + used.costUSD;
  }
  return { count, contextWindow, costUsd };
}

interface Streamed {
  id: string;
  kind: "agentMessage" | "reasoning";
  started: boolean;
}

/**
 * Reads one session's stream and says what changed in its conversation. Text
 * and reasoning arrive twice, in pieces and then whole: the pieces start an
 * item and the whole one completes it. A tool call starts as the agent asks
 * for it and completes with its result. What a helper agent says is left out.
 */
export class StreamReader {
  /** Tool calls the owner refused, which their results do not tell from ones that failed. */
  readonly declined = new Set<string>();
  /** What the latest request used: its total is what the context holds now. */
  last: TokenCount | null = null;
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly sandboxCwd: string | null;
  private messageId = "";
  private readonly blocks = new Map<number, Streamed>();
  /** Items the pieces started, waiting for the whole text. */
  private readonly open: Streamed[] = [];
  private readonly tools = new Map<string, Item>();

  constructor(sessionId: string, cwd: string, sandboxCwd: string | null = null) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.sandboxCwd = sandboxCwd;
  }

  read(turnId: string, message: WireMessage): SessionEvent[] {
    if (message.parent_tool_use_id) return [];
    const { sessionId } = this;
    const started = (item: Item): SessionEvent => ({
      type: "item.started",
      sessionId,
      turnId,
      item,
    });
    const completed = (item: Item): SessionEvent => ({
      type: "item.completed",
      sessionId,
      turnId,
      item,
    });
    switch (message.type) {
      case "stream_event": {
        const event = message.event;
        if (!event) return [];
        if (event.type === "message_start") {
          this.messageId = event.message?.id ?? "";
          this.blocks.clear();
          return [];
        }
        const index = event.index ?? 0;
        if (event.type === "content_block_start") {
          const type = event.content_block?.type;
          if (type !== "text" && type !== "thinking") return [];
          this.blocks.set(index, {
            id: `${this.messageId}:${index}`,
            kind: type === "text" ? "agentMessage" : "reasoning",
            started: false,
          });
          return [];
        }
        if (event.type !== "content_block_delta") return [];
        const block = this.blocks.get(index);
        const delta = event.delta?.text ?? event.delta?.thinking ?? "";
        if (!block || !delta) return [];
        const events: SessionEvent[] = [];
        if (!block.started) {
          block.started = true;
          this.open.push(block);
          events.push(started({ id: block.id, kind: block.kind, text: "" }));
        }
        events.push({ type: "item.delta", sessionId, turnId, itemId: block.id, delta });
        return events;
      }
      case "assistant": {
        if (message.message?.usage) this.last = toCount(message.message.usage);
        const events: SessionEvent[] = [];
        blocksOf(message.message?.content).forEach((block, index) => {
          if (block.type === "tool_use" && block.id) {
            const item = toolItem(
              block.id,
              block.name ?? "",
              block.input ?? {},
              this.cwd,
              this.sandboxCwd,
            );
            this.tools.set(block.id, item);
            events.push(started(item));
            return;
          }
          if (block.type !== "text" && block.type !== "thinking") return;
          const kind = block.type === "text" ? "agentMessage" : "reasoning";
          const body = (block.type === "text" ? block.text : block.thinking) ?? "";
          const at = this.open.findIndex((streamed) => streamed.kind === kind);
          const streamed = at === -1 ? null : this.open.splice(at, 1)[0];
          // Reasoning the model keeps to itself arrives as an empty block.
          if (!streamed && !body) return;
          events.push(
            completed({ id: streamed?.id ?? `${message.uuid}:${index}`, kind, text: body }),
          );
        });
        return events;
      }
      case "user": {
        const events: SessionEvent[] = [];
        for (const block of blocksOf(message.message?.content)) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const item = this.tools.get(block.tool_use_id);
          if (!item) continue;
          this.tools.delete(block.tool_use_id);
          const declined = this.declined.delete(block.tool_use_id);
          events.push(completed(finishTool(item, block, message.tool_use_result, declined)));
        }
        return events;
      }
      case "system":
        if (message.subtype !== "compact_boundary" || !message.uuid) return [];
        return [completed({ id: message.uuid, kind: "compaction" })];
      default:
        return [];
    }
  }
}

// A stored session

const INTERRUPTED = "[Request interrupted by user";
const CONTINUED = "This session is being continued from a previous conversation";
/** What Claude Code writes into the conversation for itself, which is no prompt of the owner's. */
const NOISE = /^<(local-command-|command-name|command-message|system-reminder|task-notification)/;

type Entry = "prompt" | "results" | "interrupted" | "compaction" | "noise";

function userEntry(blocks: WireBlock[]): Entry {
  if (blocks.some((block) => block.type === "tool_result")) return "results";
  const said = blocks.find((block) => block.type === "text")?.text?.trimStart() ?? "";
  if (said.startsWith(INTERRUPTED)) return "interrupted";
  if (said.startsWith(CONTINUED)) return "compaction";
  if (NOISE.test(said)) return "noise";
  return "prompt";
}

function apiMessage(message: WireHistoryMessage): WireBlock[] {
  return blocksOf((record(message.message) as WireApiMessage).content);
}

function imageOf(block: WireBlock): string | null {
  const source = block.source;
  if (block.type !== "image" || !source) return null;
  if (source.type === "url") return source.url ?? null;
  return source.data ? `data:${source.media_type ?? "image/png"};base64,${source.data}` : null;
}

/** The documents a prompt carried, by name, when it carried any. */
function documentsOf(blocks: WireBlock[]): { documents?: { kind: DocumentKind; name: string }[] } {
  const documents = blocks.flatMap((block) =>
    block.type === "document"
      ? [
          {
            kind: block.source?.type === "text" ? ("text" as const) : ("pdf" as const),
            name: block.title ?? "",
          },
        ]
      : [],
  );
  return documents.length ? { documents } : {};
}

/** Whether a stored message begins a turn: a prompt of the owner's, or a summary of what came before. */
function beginsTurn(message: WireHistoryMessage): boolean {
  if (message.type !== "user" || message.parent_tool_use_id) return false;
  const entry = userEntry(apiMessage(message));
  return entry === "prompt" || entry === "compaction";
}

/**
 * A stored conversation as turns. A turn begins at each prompt and is known by
 * that prompt's id, which is also what a running turn is known by.
 */
export function toTurns(
  messages: WireHistoryMessage[],
  cwd: string,
  sandboxCwd: string | null = null,
): Turn[] {
  const turns: Turn[] = [];
  const tools = new Map<string, { turn: Turn; at: number }>();
  let turn: Turn | null = null;
  const open = (id: string): Turn => {
    const next: Turn = {
      id,
      status: "completed",
      error: null,
      startedAt: null,
      durationMs: null,
      items: [],
      diff: null,
    };
    turns.push(next);
    return next;
  };
  for (const message of messages) {
    if (message.parent_tool_use_id) continue;
    const blocks = apiMessage(message);
    if (message.type === "assistant") {
      const current: Turn = (turn ??= open(message.uuid));
      blocks.forEach((block, index) => {
        if (block.type === "tool_use" && block.id) {
          tools.set(block.id, { turn: current, at: current.items.length });
          current.items.push(
            toolItem(block.id, block.name ?? "", block.input ?? {}, cwd, sandboxCwd),
          );
        } else if (block.type === "text" && block.text) {
          current.items.push({
            id: `${message.uuid}:${index}`,
            kind: "agentMessage",
            text: block.text,
          });
        } else if (block.type === "thinking" && block.thinking) {
          current.items.push({
            id: `${message.uuid}:${index}`,
            kind: "reasoning",
            text: block.thinking,
          });
        }
      });
      continue;
    }
    if (message.type !== "user") continue;
    switch (userEntry(blocks)) {
      case "results":
        for (const block of blocks) {
          const call = block.tool_use_id ? tools.get(block.tool_use_id) : undefined;
          const item = call?.turn.items[call.at];
          if (!call || !item || block.type !== "tool_result") continue;
          call.turn.items[call.at] = finishTool(item, block, undefined, false);
        }
        break;
      case "interrupted":
        if (turn) turn.status = "interrupted";
        break;
      case "compaction":
        turn = open(message.uuid);
        turn.items.push({ id: message.uuid, kind: "compaction" });
        break;
      case "prompt":
        turn = open(message.uuid);
        turn.items.push({
          id: message.uuid,
          kind: "userMessage",
          text: blocks
            .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
            .filter(Boolean)
            .join("\n"),
          images: blocks.map(imageOf).filter((image) => image !== null),
          ...documentsOf(blocks),
        });
        break;
      case "noise":
        break;
    }
  }
  // A call with no result was cut off, or its turn was.
  for (const each of turns) {
    each.items = each.items.map((item) =>
      "status" in item && item.status === "running"
        ? { ...item, status: each.status === "interrupted" ? "failed" : "completed" }
        : item,
    );
  }
  return turns;
}

/**
 * Where a stored conversation ends when it is cut before a turn: the entry
 * just ahead of the turn's prompt. Null when the turn is the first, or unknown.
 */
export function entryBefore(messages: WireHistoryMessage[], turnId: string): string | null {
  const at = messages.findIndex((message) => message.uuid === turnId);
  return at > 0 ? (messages[at - 1]?.uuid ?? null) : null;
}

/** Whether the conversation has this turn, and whether it is its first. */
export function turnPlace(
  messages: WireHistoryMessage[],
  turnId: string,
): "first" | "later" | "unknown" {
  const first = messages.find(beginsTurn);
  if (first?.uuid === turnId) return "first";
  return messages.some((message) => message.uuid === turnId && beginsTurn(message))
    ? "later"
    : "unknown";
}

/** The last entry of a turn: the one ahead of the next turn's prompt. Null for the last turn. */
export function lastEntryOf(messages: WireHistoryMessage[], turnId: string): string | null {
  const at = messages.findIndex((message) => message.uuid === turnId);
  if (at === -1) return null;
  const next = messages.findIndex((message, index) => index > at && beginsTurn(message));
  return next === -1 ? null : (messages[next - 1]?.uuid ?? null);
}

/** The model a stored conversation last ran on. */
export function historyModel(messages: WireHistoryMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.type !== "assistant") continue;
    const model = (record(message.message) as WireApiMessage).model;
    // Claude Code writes what it says itself, as an error, under a model that is none.
    if (model && !model.startsWith("<")) return model;
  }
  return null;
}

export function toSession(
  info: WireSessionInfo,
  extra?: {
    model?: string;
    forkedFrom?: string;
    sandbox?: string;
    /** The folder as this machine knows it, when Claude Code stored another path. */
    cwd?: string;
    sandboxCwd?: string | null;
  },
): HarnessSession {
  return {
    id: info.sessionId,
    harness: HARNESS_NAME,
    title: info.customTitle?.trim() || null,
    preview: info.firstPrompt ?? "",
    cwd: extra?.cwd ?? info.cwd ?? "",
    model: extra?.model ?? "",
    effort: null,
    // A commit checked out by itself is no branch.
    branch: info.gitBranch && info.gitBranch !== "HEAD" ? info.gitBranch : null,
    sandbox: extra?.sandbox ?? null,
    sandboxCwd: extra?.sandboxCwd ?? null,
    createdAt: info.createdAt ?? info.lastModified,
    updatedAt: info.lastModified,
    forkedFrom: extra?.forkedFrom ?? null,
  };
}

// Models and modes

/** The effort a session runs at when the owner chose none, on a model that has it. */
export const DEFAULT_EFFORT = "high";

/**
 * Claude Code's models as a session can choose them. It names them by alias,
 * and two aliases may mean one model: each model is offered once, under its
 * own id, so a session keeps the model it began on when an alias moves.
 */
export function toModels(raw: WireModelInfo[], sandbox = false): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const model of raw) {
    const id = model.resolvedModel ?? model.value;
    if (models.some((known) => known.id === id)) continue;
    // "Sonnet 5.5 · Efficient for routine tasks": the name, then what it is for.
    const [name, ...about] = model.description.split(" · ");
    const efforts = model.supportedEffortLevels ?? [];
    models.push({
      id,
      harness: HARNESS_NAME,
      name: (about.length ? name : "") || model.displayName,
      description: about.join(" · ") || model.description,
      efforts: efforts.map((effort) => ({ id: effort, description: "" })),
      defaultEffort: efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (efforts[0] ?? null),
      isDefault: model.value === "default",
      images: true,
      sandbox,
      provider: null,
    });
  }
  return models;
}

export interface ModeOptions {
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  allowDangerouslySkipPermissions?: boolean;
  sandbox?: { enabled: boolean; autoAllowBashIfSandboxed: boolean };
}

/**
 * How each of Cycle's modes is put to Claude Code. `readOnly` asks before any
 * edit and any command that changes something. `auto` edits inside the folder
 * unasked and runs commands in Claude Code's sandbox, which keeps them to the
 * folder; where the sandbox cannot start, a command asks first instead.
 * `fullAccess` never asks and has no sandbox.
 *
 * `contained` is a session whose agent already runs in a sandbox of the machine's: Claude Code's
 * own is left off there, so in `auto` a command asks first.
 */
export function modeOptions(mode: SessionMode, contained = false): ModeOptions {
  switch (mode) {
    case "readOnly":
      return { permissionMode: "default" };
    case "auto":
      return {
        permissionMode: "acceptEdits",
        ...(contained ? {} : { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }),
      };
    case "fullAccess":
      return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  }
}

// Approvals

function toQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input["questions"]) ? input["questions"].map(record) : [];
  return raw.map((question) => ({
    // Claude Code takes its answers by the question's own text.
    id: text(question["question"]),
    header: text(question["header"]),
    question: text(question["question"]),
    options: (Array.isArray(question["options"]) ? question["options"].map(record) : []).map(
      (option) => ({ label: text(option["label"]), description: text(option["description"]) }),
    ),
    allowOther: true,
    secret: false,
  }));
}

/** What Claude Code asks before a tool call, as the owner is asked it. The call's id names both. */
export function toApproval(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  hint: { cwd: string; title?: string | undefined; reason?: string | undefined },
): Approval {
  const reason = hint.reason ?? null;
  if (tool === "Bash") {
    return {
      id,
      kind: "command",
      itemId: id,
      command: text(input["command"]) || null,
      cwd: hint.cwd,
      reason: reason ?? (text(input["description"]) || null),
    };
  }
  if (EDIT_TOOLS.has(tool)) return { id, kind: "fileChange", itemId: id, reason };
  if (tool === "AskUserQuestion") {
    return { id, kind: "question", itemId: id, questions: toQuestions(input) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  const name = mcp ? `${mcp[1]}.${mcp[2]}` : tool;
  const args = JSON.stringify(input);
  return {
    id,
    kind: "permissions",
    itemId: id,
    reason,
    summary: hint.title ?? `${name} ${args.length > 200 ? `${args.slice(0, 200)}…` : args}`,
  };
}

/**
 * The owner's answer as Claude Code takes it. "For the session" keeps the
 * rules Claude Code proposed, for this session only: nothing is written to
 * the owner's settings, and the mode stays Cycle's to set.
 */
export function toPermission(
  tool: string,
  input: Record<string, unknown>,
  suggestions: WirePermissionUpdate[] | undefined,
  response: ApprovalResponse,
): WirePermissionResult {
  if ("answers" in response) {
    const answers = Object.fromEntries(
      Object.entries(response.answers).map(([question, chosen]) => [question, chosen.join(", ")]),
    );
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  switch (response.decision) {
    case "accept":
      return { behavior: "allow", updatedInput: input };
    case "acceptForSession": {
      const rules: WirePermissionUpdate[] = (suggestions ?? [])
        .filter((update) => update.type === "addRules" || update.type === "addDirectories")
        .map((update) => ({ ...update, destination: "session" }));
      if (!rules.some((update) => update.type === "addRules")) {
        rules.push({
          type: "addRules",
          rules: [{ toolName: tool }],
          behavior: "allow",
          destination: "session",
        });
      }
      return { behavior: "allow", updatedInput: input, updatedPermissions: rules };
    }
    case "decline":
      return {
        behavior: "deny",
        message: "The owner declined this. Do not try it another way: ask what to do instead.",
      };
    case "cancel":
      return { behavior: "deny", message: "The owner stopped the turn.", interrupt: true };
  }
}

// Prompts

/** A prompt as the SDK takes it. An image that is a path is named: the agent reads it itself. */
export function toUserMessage(
  input: PromptInput,
  uuid: string,
  sessionId: string,
  priority?: "next",
): WireUserMessage {
  const content: WireBlock[] = [];
  let said = input.text;
  for (const image of input.images) {
    const data = /^data:([^;,]+);base64,(.+)$/s.exec(image);
    if (data) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: data[1] ?? "", data: data[2] ?? "" },
      });
    } else if (/^https?:/.test(image)) {
      content.push({ type: "image", source: { type: "url", url: image } });
    } else {
      said += `${said ? "\n\n" : ""}[Image: ${image}]`;
    }
  }
  for (const document of input.documents ?? []) {
    const data = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(document.data);
    if (!data) continue;
    const body = data[3] ?? "";
    content.push(
      document.kind === "pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: body },
            title: document.name,
          }
        : {
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: data[2]
                ? new TextDecoder().decode(
                    Uint8Array.from(atob(body), (char) => char.charCodeAt(0)),
                  )
                : decodeURIComponent(body),
            },
            title: document.name,
          },
    );
  }
  content.push({ type: "text", text: said });
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content },
    ...(priority ? { priority } : {}),
  };
}

const REVIEW_RULES =
  "Read the changes with git and the files around them. Report what is wrong or risky, most serious first, each with its file and line and why it matters. Change nothing.";

/** What a review asks. Claude Code has no review of its own to start, so it is a prompt. */
export function reviewPrompt(target: ReviewTarget): string {
  switch (target.kind) {
    case "uncommitted":
      return `Review the changes in this folder that are not committed: staged, unstaged and untracked. ${REVIEW_RULES}`;
    case "branch":
      return `Review everything the current branch changed since it left \`${target.branch}\`. ${REVIEW_RULES}`;
    case "commit":
      return `Review commit \`${target.sha}\`. ${REVIEW_RULES}`;
    case "custom":
      return target.instructions;
  }
}

// What the agent offers and reads

export function toCommands(raw: WireSlashCommand[]): SlashCommand[] {
  return raw.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    aliases: command.aliases ?? [],
    builtin: command.builtin === true,
  }));
}

/** The commands a skill of the owner's, a project's or a plugin's brings: what Claude Code's skills are. */
export function toSkills(commands: SlashCommand[]): SkillInfo[] {
  return commands
    .filter((command) => !command.builtin)
    .map((command) => ({
      name: command.name,
      description: command.description,
      path: "",
      scope: "claude",
      enabled: true,
    }));
}

const LIMIT_NAMES: Record<string, { name: string; minutes: number | null }> = {
  five_hour: { name: "5-hour limit", minutes: 5 * 60 },
  seven_day: { name: "Weekly limit", minutes: 7 * 24 * 60 },
  seven_day_opus: { name: "Weekly Opus limit", minutes: 7 * 24 * 60 },
  seven_day_sonnet: { name: "Weekly Sonnet limit", minutes: 7 * 24 * 60 },
  seven_day_overage_included: { name: "Weekly limit, with overage", minutes: 7 * 24 * 60 },
  overage: { name: "Overage", minutes: null },
};

/** One of a subscription's limits, as a `rate_limit_event` tells of it. */
export function toLimit(raw: WireRateLimitInfo): LimitWindow {
  const id = raw.rateLimitType ?? "limit";
  const known = LIMIT_NAMES[id];
  return {
    id,
    name: known?.name ?? id.replaceAll("_", " "),
    usedPercent: raw.utilization === undefined ? null : Math.round(raw.utilization * 100),
    windowMinutes: known?.minutes ?? null,
    resetsAt: raw.resetsAt === undefined ? null : raw.resetsAt * 1000,
    status:
      raw.status === "rejected" ? "exceeded" : raw.status === "allowed_warning" ? "warning" : "ok",
    overage: raw.isUsingOverage === true,
  };
}

/**
 * Who is signed in to Claude Code, and how. Of the credential only where it is read from is kept:
 * the SDK says no more, and none of it is a secret.
 */
export function toAccount(raw: WireAccountInfo | null, limits: LimitWindow[]): AccountInfo {
  const info = raw ?? {};
  const provider = info.apiProvider && info.apiProvider !== "firstParty" ? info.apiProvider : null;
  const kind: AccountInfo["kind"] = provider
    ? "cloud"
    : info.apiKeySource && info.apiKeySource !== "none"
      ? "apiKey"
      : info.subscriptionType || info.email
        ? "subscription"
        : info.tokenSource && info.tokenSource !== "none"
          ? "other"
          : null;
  return {
    harness: HARNESS_NAME,
    kind,
    email: info.email ?? null,
    plan: info.subscriptionType ?? null,
    organization: info.organization ?? null,
    provider,
    source:
      (info.apiKeySource && info.apiKeySource !== "none" ? info.apiKeySource : null) ??
      (info.tokenSource && info.tokenSource !== "none" ? info.tokenSource : null),
    limits,
  };
}

/**
 * Claude Code's MCP servers as one of its processes sees them. A server's headers are never read,
 * and of its environment only the names. `own` is the client's own server, which is not the owner's.
 */
export function toMcpServers(raw: WireMcpServerStatus[], own: string | null): McpServerInfo[] {
  return raw
    .filter((server) => server.name !== own)
    .map((server) => {
      const config = server.config;
      const transport: McpServerInfo["transport"] =
        config?.command !== undefined
          ? {
              kind: "stdio",
              command: config.command,
              args: config.args ?? [],
              env: Object.keys(config.env ?? {}),
            }
          : config?.url !== undefined
            ? { kind: "http", url: config.url, bearerTokenEnvVar: null }
            : null;
      return {
        name: server.name,
        enabled: server.status !== "disabled",
        transport,
        // A plugin's server is named `plugin:<plugin>:<server>`, a name its author chose, and the SDK
        // says nothing of its marketplace: the `name@marketplace` id a plugin is known by cannot be
        // made from it. A server that says it comes from a plugin is still marked by `source`.
        pluginId: null,
        status:
          server.status === "needs-auth"
            ? "needsAuth"
            : server.status === "pending"
              ? "unknown"
              : server.status,
        auth: server.status === "needs-auth" ? "signedOut" : "none",
        tools: (server.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          enabled: true,
          tokens: null,
        })),
        error: server.error ?? null,
      };
    });
}

export function toContext(raw: WireContextUsage): ContextUsage {
  return {
    tokens: raw.totalTokens,
    window: raw.maxTokens || null,
    parts: raw.categories.map((part) => ({
      id: part.id ?? part.name,
      name: part.name,
      tokens: part.tokens,
      kind: part.kind,
    })),
  };
}

/** What putting files back did or would do. `place` turns a path the agent saw into this machine's. */
export function toFileRewind(
  raw: WireRewindFilesResult,
  place: (path: string) => string = (path) => path,
): FileRewind {
  return {
    possible: raw.canRewind,
    error: raw.error ?? null,
    files: (raw.filesChanged ?? []).map(place),
    insertions: raw.insertions ?? 0,
    deletions: raw.deletions ?? 0,
  };
}
