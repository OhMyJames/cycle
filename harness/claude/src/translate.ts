import { formFields, toMachinePath } from "@cycle/protocol";
import type {
  Approval,
  ApprovalResponse,
  ApprovalRule,
  CommandAction,
  HarnessSession,
  Item,
  ItemStatus,
  ModeInfo,
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
  WireElicitation,
  WireElicitationResult,
  WireHistoryMessage,
  WireMessage,
  WireModelInfo,
  WireModelUsage,
  WirePermissionMode,
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
    case "ExitPlanMode":
      return { id, kind: "plan", text: text(input["plan"]) };
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
  private readonly sandboxCwd: string | null;
  private messageId = "";
  private readonly blocks = new Map<number, Streamed>();
  /** Items the pieces started, waiting for the whole text. */
  private readonly open: Streamed[] = [];
  private readonly tools = new Map<string, Item>();
  private readonly draft = new PlanDraft();
  /** Why calls refused without asking were refused, until their results come in. */
  private readonly refused = new Map<string, string>();

  constructor(sessionId: string, cwd: string, sandboxCwd: string | null = null) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.sandboxCwd = sandboxCwd;
  }

  /** The plan a request to leave plan mode carries, by the call's id. */
  planFor(toolUseId: string): string {
    const item = this.tools.get(toolUseId);
    return item?.kind === "plan" ? item.text : "";
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
            const name = block.name ?? "";
            this.draft.see(name, block.input ?? {});
            const item = toolItem(
              block.id,
              name,
              this.draft.fill(name, block.input ?? {}),
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
          const why = this.refused.get(block.tool_use_id);
          this.refused.delete(block.tool_use_id);
          events.push(completed(finishTool(item, block, message.tool_use_result, declined)));
          // A command or a tool says why in its output; an edit has nowhere to.
          if (why && item.kind !== "command" && item.kind !== "toolCall") {
            events.push({ type: "notice", sessionId, level: "warning", message: why });
          }
        }
        return events;
      }
      case "system":
        if (message.subtype === "permission_denied" && message.tool_use_id) {
          // Refused by a rule, the mode or the classifier, without asking: the result says why.
          this.declined.add(message.tool_use_id);
          const why = text(record(message)["message"]);
          if (why) this.refused.set(message.tool_use_id, why);
          return [];
        }
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
export function toTurns(
  messages: WireHistoryMessage[],
  cwd: string,
  sandboxCwd: string | null = null,
): Turn[] {
  const turns: Turn[] = [];
  const tools = new Map<string, { turn: Turn; at: number }>();
  const draft = new PlanDraft();
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
          const name = block.name ?? "";
          draft.see(name, block.input ?? {});
          tools.set(block.id, { turn: current, at: current.items.length });
          current.items.push(
            toolItem(block.id, name, draft.fill(name, block.input ?? {}), cwd, sandboxCwd),
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

/** Claude Code's modes, each as it names it. */
export const CLAUDE_MODES: readonly ModeInfo[] = (
  [
    {
      id: "default",
      name: "Ask first",
      description: "Reads freely, asks before commands and edits",
      replaces: "readOnly",
    },
    {
      id: "acceptEdits",
      name: "Accept edits",
      description: "Edits in the project and runs commands in a sandbox, asks to leave it",
      isDefault: true,
      replaces: "auto",
    },
    {
      id: "plan",
      name: "Plan",
      description: "Reads and plans, changes nothing until you approve the plan",
      plan: true,
    },
    {
      id: "auto",
      name: "Auto",
      description: "A classifier approves each call, and asks you when it cannot tell",
    },
    {
      id: "dontAsk",
      name: "Don't ask",
      description: "Never asks: does what your rules allow and is refused the rest",
    },
    {
      id: "bypassPermissions",
      name: "Bypass permissions",
      description: "Never asks, no sandbox",
      dangerous: true,
      replaces: "fullAccess",
    },
  ] satisfies (Partial<ModeInfo> & Pick<ModeInfo, "id" | "name" | "description">)[]
).map((mode): ModeInfo => ({
  harness: HARNESS_NAME,
  dangerous: false,
  plan: false,
  isDefault: false,
  replaces: null,
  ...mode,
}));

/** Claude Code's mode of this id; anything it does not offer is the one that asks first. */
function wireMode(mode: SessionMode): WirePermissionMode {
  const found = CLAUDE_MODES.find((each) => each.id === mode);
  return (found?.id ?? "default") as WirePermissionMode;
}

/** The modes a plan, once approved, can be carried out in: none that never asks, nor planning. */
export const AFTER_PLAN: readonly SessionMode[] = CLAUDE_MODES.filter(
  (mode) => !mode.dangerous && !mode.plan,
).map((mode) => mode.id);

export interface ModeOptions {
  permissionMode: WirePermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  sandbox?: { enabled: boolean; autoAllowBashIfSandboxed: boolean };
}

/**
 * How each mode is put to Claude Code. Every mode is given by name, so Claude Code never picks
 * its own. `acceptEdits` and `auto` run commands in Claude Code's sandbox, which keeps them to the
 * folder; where the sandbox cannot start, a command asks first instead. `bypassPermissions` never
 * asks and has no sandbox, and must be allowed as the process starts.
 *
 * `contained` is a session whose agent already runs in a sandbox of the machine's: Claude Code's
 * own is left off there, so in `acceptEdits` a command asks first.
 */
export function modeOptions(mode: SessionMode, contained = false): ModeOptions {
  const permissionMode = wireMode(mode);
  const sandboxed = contained ? {} : { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } };
  switch (permissionMode) {
    case "acceptEdits":
    case "auto":
      return { permissionMode, ...sandboxed };
    case "bypassPermissions":
      return { permissionMode, allowDangerouslySkipPermissions: true };
    default:
      return { permissionMode };
  }
}

/**
 * What only a process's start can set for a mode. Two modes alike in it are one process, which
 * moves between them in place; any other move needs another process.
 */
export function processSpec(mode: SessionMode, contained = false): string {
  const { permissionMode: _, ...rest } = modeOptions(mode, contained);
  return JSON.stringify(rest);
}

// Plans

const PLAN_FILE = /\/plans\/[^/]+\.md$/;

/**
 * The plan Claude Code is writing. The model writes it to a file of Claude Code's, then asks to
 * leave plan mode, and the request itself does not carry it.
 */
export class PlanDraft {
  private written = "";

  /** Follows a tool call, which may be one that writes the plan. */
  see(name: string, input: Record<string, unknown>): void {
    if (!PLAN_FILE.test(text(input["file_path"]))) return;
    if (name === "Write") this.written = text(input["content"]);
    else if (name === "Edit") {
      this.written = this.written.replace(text(input["old_string"]), text(input["new_string"]));
    }
  }

  /** A call's input, given the plan as written when it asks to leave plan mode without one. */
  fill(name: string, input: Record<string, unknown>): Record<string, unknown> {
    return name === "ExitPlanMode" && !text(input["plan"]) && this.written
      ? { ...input, plan: this.written }
      : input;
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

/** What a suggested change lets through, as the owner reads it. Null for one not offered. */
function ruleLabel(update: WirePermissionUpdate): string | null {
  switch (update.type) {
    case "addRules": {
      if (update["behavior"] !== "allow") return null;
      const rules = Array.isArray(update["rules"]) ? update["rules"].map(record) : [];
      const said = rules.map((rule) => {
        const content = text(rule["ruleContent"]);
        return content ? `${text(rule["toolName"])}(${content})` : text(rule["toolName"]);
      });
      return said.length ? said.join(", ") : null;
    }
    case "addDirectories": {
      const directories = Array.isArray(update["directories"]) ? update["directories"] : [];
      return directories.length ? `Work in ${directories.map(String).join(", ")}` : null;
    }
    case "setMode": {
      const mode = CLAUDE_MODES.find((each) => each.id === update["mode"]);
      return mode && !mode.dangerous ? `Switch to ${mode.name}` : null;
    }
    default:
      return null;
  }
}

/** The changes Claude Code suggests, as rules the owner can keep: each by its place in the list. */
export function toRules(suggestions: WirePermissionUpdate[] | undefined): ApprovalRule[] {
  return (suggestions ?? []).flatMap((update, index) => {
    const label = ruleLabel(update);
    return label ? [{ id: String(index), label }] : [];
  });
}

/** What Claude Code asks before a tool call, as the owner is asked it. The call's id names both. */
export function toApproval(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  hint: {
    cwd: string;
    title?: string | undefined;
    reason?: string | undefined;
    suggestions?: WirePermissionUpdate[] | undefined;
    /** The plan, for a request to leave plan mode. */
    plan?: string | undefined;
  },
): Approval {
  const reason = hint.reason ?? null;
  const rules = toRules(hint.suggestions);
  if (tool === "Bash") {
    return {
      id,
      kind: "command",
      itemId: id,
      command: text(input["command"]) || null,
      cwd: hint.cwd,
      reason: reason ?? (text(input["description"]) || null),
      rules,
      editable: true,
      notes: true,
    };
  }
  if (EDIT_TOOLS.has(tool)) {
    return { id, kind: "fileChange", itemId: id, reason, rules, notes: true };
  }
  if (tool === "AskUserQuestion") {
    return { id, kind: "question", itemId: id, questions: toQuestions(input) };
  }
  if (tool === "ExitPlanMode") {
    return {
      id,
      kind: "plan",
      itemId: id,
      plan: hint.plan || text(input["plan"]),
      modes: [...AFTER_PLAN],
    };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return {
    id,
    kind: "tool",
    itemId: id,
    server: mcp?.[1] ?? null,
    tool: mcp?.[2] ?? tool,
    input: JSON.stringify(input, null, 2),
    title: hint.title ?? null,
    reason,
    rules,
  };
}

/** A tool's input as the owner changed it. What is not a JSON object leaves it as it was. */
function editedInput(
  tool: string,
  input: Record<string, unknown>,
  edited: string | undefined,
): Record<string, unknown> {
  if (edited === undefined) return input;
  if (tool === "Bash") return edited.trim() ? { ...input, command: edited } : input;
  if (EDIT_TOOLS.has(tool)) return input;
  try {
    const parsed: unknown = JSON.parse(edited);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : input;
  } catch {
    return input;
  }
}

/**
 * The owner's answer as Claude Code takes it. A rule the owner keeps holds for this session only:
 * nothing is written to the owner's settings.
 *
 * shortcut: every rule is kept for the session alone, wherever Claude Code suggested keeping it;
 * upgrade when Cycle keeps a Claude configuration of its own to keep one in.
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
  const said = response.message?.trim();
  if (tool === "ExitPlanMode" && response.decision !== "cancel") {
    if (response.decision === "decline") {
      return {
        behavior: "deny",
        message: said
          ? `The owner wants the plan changed: ${said}`
          : "The owner did not approve the plan. Ask what to change.",
      };
    }
    const mode = response.mode && AFTER_PLAN.includes(response.mode) ? response.mode : "default";
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
    };
  }
  switch (response.decision) {
    case "accept": {
      const chosen = new Set(response.rules ?? []);
      const kept = (suggestions ?? []).filter(
        (update, index) => chosen.has(String(index)) && ruleLabel(update) !== null,
      );
      return {
        behavior: "allow",
        updatedInput: editedInput(tool, input, response.edited),
        ...(kept.length
          ? { updatedPermissions: kept.map((update) => ({ ...update, destination: "session" })) }
          : {}),
      };
    }
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
      return {
        behavior: "allow",
        updatedInput: editedInput(tool, input, response.edited),
        updatedPermissions: rules,
      };
    }
    case "decline":
      return {
        behavior: "deny",
        message: said
          ? `The owner declined this: ${said}`
          : "The owner declined this. Do not try it another way: ask what to do instead.",
      };
    case "cancel":
      return { behavior: "deny", message: "The owner stopped the turn.", interrupt: true };
  }
}

// Elicitation

/** What an MCP server asks of the owner, as an approval. */
export function toElicitation(id: string, request: WireElicitation): Approval {
  const url = request.mode === "url" ? (request.url ?? null) : null;
  const schema = url ? undefined : request.requestedSchema;
  return {
    id,
    kind: "elicitation",
    itemId: id,
    server: request.serverName,
    message: request.message,
    url,
    fields: url ? null : formFields(schema),
    schema: schema ? JSON.stringify(schema, null, 2) : null,
  };
}

/** The owner's answer to an MCP server's request. */
export function toElicitationResult(response: ApprovalResponse): WireElicitationResult {
  if ("answers" in response) return { action: "decline" };
  switch (response.decision) {
    case "accept":
    case "acceptForSession":
      return { action: "accept", ...(response.content ? { content: response.content } : {}) };
    case "decline":
      return { action: "decline" };
    case "cancel":
      return { action: "cancel" };
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
