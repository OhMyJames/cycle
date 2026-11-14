import type {
  Approval,
  ApprovalResponse,
  CommandAction,
  HarnessSession,
  Item,
  ItemStatus,
  ModelInfo,
  PromptInput,
  Question,
  ReviewTarget,
  SessionEvent,
  SessionMode,
  TokenCount,
  Turn,
} from "@cycle/protocol";
import type {
  WireApiMessage,
  WireBlock,
  WireHistoryMessage,
  WireMessage,
  WireModelInfo,
  WireModelUsage,
  WirePermissionResult,
  WirePermissionUpdate,
  WireSessionInfo,
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
): Item {
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
      const path = text(input["file_path"]);
      return command(`Read ${path}`, [{ type: "read", path }]);
    }
    case "Glob":
    case "Grep": {
      const query = text(input["pattern"]);
      return command(`${name} ${query}`, [
        { type: "search", query, path: text(input["path"]) || null },
      ]);
    }
    case "Edit":
      return change(input["file_path"], input["old_string"], input["new_string"]);
    case "Write":
      return change(input["file_path"], "", input["content"]);
    case "NotebookEdit":
      return change(input["notebook_path"], "", input["new_source"]);
    case "MultiEdit": {
      const edits = Array.isArray(input["edits"]) ? input["edits"].map(record) : [];
      return {
        id,
        kind: "fileChange",
        changes: [
          {
            path: text(input["file_path"]),
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
  const input = (usage?.input_tokens ?? 0) + cached + (usage?.cache_creation_input_tokens ?? 0);
  const output = usage?.output_tokens ?? 0;
  return { total: input + output, input, cachedInput: cached, output, reasoning: 0 };
}

export const NO_TOKENS: TokenCount = {
  total: 0,
  input: 0,
  cachedInput: 0,
  output: 0,
  reasoning: 0,
};

export function addCounts(a: TokenCount, b: TokenCount): TokenCount {
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** What a process used since it started, over every model it asked, and the most one can read. */
export function usedBy(models: Record<string, WireModelUsage> | undefined): {
  count: TokenCount;
  contextWindow: number | null;
} {
  let count = NO_TOKENS;
  let contextWindow: number | null = null;
  for (const used of Object.values(models ?? {})) {
    const cached = used.cacheReadInputTokens ?? 0;
    const input = (used.inputTokens ?? 0) + cached + (used.cacheCreationInputTokens ?? 0);
    const output = used.outputTokens ?? 0;
    count = addCounts(count, {
      total: input + output,
      input,
      cachedInput: cached,
      output,
      reasoning: 0,
    });
    if (used.contextWindow) contextWindow = Math.max(contextWindow ?? 0, used.contextWindow);
  }
  return { count, contextWindow };
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
  private messageId = "";
  private readonly blocks = new Map<number, Streamed>();
  /** Items the pieces started, waiting for the whole text. */
  private readonly open: Streamed[] = [];
  private readonly tools = new Map<string, Item>();

  constructor(sessionId: string, cwd: string) {
    this.sessionId = sessionId;
    this.cwd = cwd;
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
            const item = toolItem(block.id, block.name ?? "", block.input ?? {}, this.cwd);
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
export function toTurns(messages: WireHistoryMessage[], cwd: string): Turn[] {
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
          current.items.push(toolItem(block.id, block.name ?? "", block.input ?? {}, cwd));
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
  extra?: { model?: string; forkedFrom?: string; sandbox?: string },
): HarnessSession {
  return {
    id: info.sessionId,
    harness: HARNESS_NAME,
    title: info.customTitle?.trim() || null,
    preview: info.firstPrompt ?? "",
    cwd: info.cwd ?? "",
    model: extra?.model ?? "",
    effort: null,
    // A commit checked out by itself is no branch.
    branch: info.gitBranch && info.gitBranch !== "HEAD" ? info.gitBranch : null,
    sandbox: extra?.sandbox ?? null,
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
