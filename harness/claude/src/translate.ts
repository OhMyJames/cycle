import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { contentOf, rawOutputOf, resultOf, TOOL_RESULT_META } from "./results.ts";

/** What a Claude turn ended with, as ACP's idle `state_update` names it. */
export type StopReason =
  | { stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" }
  | { stopReason: "error"; error: { code: number; message: string } };

export type ToolKind = "read" | "edit" | "search" | "execute" | "fetch" | "think" | "other";

export const toolKind = (name: string): ToolKind => {
  switch (name) {
    case "Read":
      return "read";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Grep":
    case "Glob":
    case "WebSearch":
      return "search";
    case "Bash":
      return "execute";
    case "WebFetch":
      return "fetch";
    // Changing the plan: the plan says it (docs/conversation-content.md), a client need not draw a row per call.
    // Reading it (TaskGet, TaskList) changes nothing the plan shows, so it stays a call of its own.
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    // The SDK looking up which tools it has (seen with a real model): its own business, not the work.
    case "ToolSearch":
      return "think";
    default:
      return "other";
  }
};

/**
 * A tool's title for people, where its name is not one: an MCP tool's `mcp__<server>__<tool>` is "server · tool".
 * Claude's naming is known here, so no client has to parse it.
 */
export const titleOf = (name: string, servers: readonly string[] = []): { title?: string } => {
  if (!name.startsWith("mcp__")) return {};
  // A server's name may itself hold "__": the servers this session was given are matched first, longest first, as
  // Claude writes them (anything but letters, digits, "_" and "-" becomes "_").
  const known = servers
    .map((server) => ({ server, as: server.replace(/[^a-zA-Z0-9_-]/g, "_") }))
    .sort((a, b) => b.as.length - a.as.length)
    .find(({ as }) => name.startsWith(`mcp__${as}__`) && name.length > `mcp__${as}__`.length);
  if (known !== undefined) {
    return { title: `${known.server} · ${name.slice(`mcp__${known.as}__`.length)}` };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp !== null ? { title: `${mcp[1]} · ${mcp[2]}` } : {};
};

type Block = { type?: string; [key: string]: unknown };

const asText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("");
  }
  return content === undefined ? "" : JSON.stringify(content);
};

/**
 * Turns the Agent SDK's messages for one turn into ACP `session/update` payloads. It holds what it
 * has to remember between messages and nothing else, so it can be tested without a process.
 *
 * Text and thinking arrive twice: as stream events while the model writes, and whole in the
 * `assistant` message after. The stream events are sent; the whole message is sent only for a
 * message that was never streamed.
 */
export class TurnTranslator {
  #messageId: string | undefined;
  /** Tokens in context after the latest main-thread model call: what the next call will start from. */
  #contextTokens: number | undefined;
  #blockTypes = new Map<number, string>();
  readonly #streamed = new Set<string>();
  /** Task calls waiting for their results: a created task's id is only in the result. */
  readonly #calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** Which tool each call is, for reading its result. */
  readonly #names = new Map<string, string>();
  /** Tool calls that were shown starting and have had no result yet, in the order they started. */
  readonly #open = new Set<string>();

  constructor(
    readonly plan: PlanState = new PlanState(),
    /** The MCP servers this session was given, by the names they were given under: for tools' titles. */
    readonly servers: readonly string[] = [],
    /**
     * A sub-agent's conversation, not the main thread's (CYCL-134): it reads only sub-agents' messages, and only whole
     * ones, since their stream is not forwarded; their usage is their own context's, not the session's.
     */
    readonly child: boolean = false,
  ) {}

  feed(message: SDKMessage): SessionUpdate[] {
    // A sub-agent's own talk and tool calls are not the main thread's: shown as the turn's they would read as the main
    // agent's, and a background one's results arrive after the turn, so its calls would never end. A translator of its
    // own reads them (`Transcripts`), and the session carries them as the sub-agent's (docs/protocol.md §9).
    const fromChild = Boolean(
      (message as { parent_tool_use_id?: string | null }).parent_tool_use_id,
    );
    if (fromChild !== this.child) return [];
    switch (message.type) {
      case "stream_event":
        if (this.child) return [];
        return this.#stream(message.event as unknown as { type: string; [key: string]: unknown });
      case "assistant":
        if (!this.child) this.#noteUsage(message);
        return this.#assistant(message.message as unknown as { id: string; content: Block[] });
      case "user":
        return this.#toolResults(
          message.message as unknown as { content: unknown },
          (message as { tool_use_result?: unknown }).tool_use_result,
        );
      default:
        return [];
    }
  }

  #stream(event: { type: string; [key: string]: unknown }): SessionUpdate[] {
    if (event.type === "message_start") {
      const id = (event.message as { id?: string } | undefined)?.id;
      this.#messageId = id;
      if (id !== undefined) this.#streamed.add(id);
      this.#blockTypes.clear();
      return [];
    }
    const index = typeof event.index === "number" ? event.index : -1;
    if (event.type === "content_block_start") {
      const block = event.content_block as Block;
      this.#blockTypes.set(index, String(block.type));
      if (block.type === "tool_use") {
        const name = String(block.name);
        this.#open.add(String(block.id));
        this.#names.set(String(block.id), name);
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: String(block.id),
            name,
            kind: toolKind(name),
            ...titleOf(name, this.servers),
            status: "pending",
          } as SessionUpdate,
        ];
      }
      return [];
    }
    if (event.type === "content_block_delta" && this.#messageId !== undefined) {
      const delta = event.delta as Block;
      if (delta.type === "text_delta") {
        return [chunk("agent_message_chunk", this.#messageId, String(delta.text))];
      }
      if (delta.type === "thinking_delta") {
        return [chunk("agent_thought_chunk", this.#messageId, String(delta.thinking))];
      }
    }
    return [];
  }

  #assistant(message: { id: string; content: Block[] }): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const streamed = this.#streamed.has(message.id);
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const name = String(block.name);
        this.#open.add(String(block.id));
        this.#names.set(String(block.id), name);
        const input = (block.input ?? {}) as Record<string, unknown>;
        const where = locationOf(name, input);
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: String(block.id),
          name,
          kind: toolKind(name),
          ...titleOf(name, this.servers),
          status: "in_progress",
          rawInput: block.input,
          ...(where !== undefined ? { locations: [where] } : {}),
        } as SessionUpdate);
        if (name === "TodoWrite" && Array.isArray(input.todos)) {
          this.plan.replace(input.todos as { content?: unknown; status?: unknown }[]);
          updates.push(this.plan.toUpdate());
        } else if (name === "TaskCreate" || name === "TaskUpdate") {
          this.#calls.set(String(block.id), { name, input });
        }
      } else if (this.child && block.type === "text") {
        // The CLI sends a message block by block, each under the message's id (SDK: `SDKAssistantMessage`): for a
        // sub-agent, whose stream is not read, each block is a piece of that message, not the whole of it.
        updates.push(chunk("agent_message_chunk", message.id, String(block.text)));
      } else if (this.child && block.type === "thinking" && String(block.thinking ?? "") !== "") {
        updates.push(chunk("agent_thought_chunk", message.id, String(block.thinking)));
      } else if (!streamed && block.type === "text") {
        updates.push({
          sessionUpdate: "agent_message",
          messageId: message.id,
          content: [{ type: "text", text: String(block.text) }],
        } as SessionUpdate);
      } else if (!streamed && block.type === "thinking" && String(block.thinking ?? "") !== "") {
        // Its words, when they were asked for; an omitted thought (no words) stays out.
        updates.push({
          sessionUpdate: "agent_thought",
          messageId: message.id,
          content: [{ type: "text", text: String(block.thinking) }],
        } as SessionUpdate);
      }
    }
    return updates;
  }

  /** A finished TaskCreate or TaskUpdate changes the plan; a failed one does not. */
  #planned(
    callId: string,
    failed: boolean,
    structured: unknown,
    text: string,
  ): SessionUpdate | undefined {
    const call = this.#calls.get(callId);
    if (call === undefined) return undefined;
    this.#calls.delete(callId);
    if (failed) return undefined;
    const result = (structured ?? {}) as {
      task?: { id?: unknown; subject?: unknown };
      success?: boolean;
    };
    if (call.name === "TaskCreate") {
      const id = result.task?.id !== undefined ? String(result.task.id) : /#(\w+)/.exec(text)?.[1];
      if (id === undefined) return undefined;
      this.plan.create(id, String(result.task?.subject ?? call.input.subject ?? ""));
    } else {
      if (result.success === false || call.input.taskId === undefined) return undefined;
      this.plan.update(String(call.input.taskId), call.input);
    }
    return this.plan.toUpdate();
  }

  /** The main thread's only: a sub-agent's calls have a context of their own, and `feed` drops them. */
  #noteUsage(message: SDKMessage): void {
    const usage = (message as { message?: { usage?: Record<string, unknown> } }).message?.usage;
    if (usage === undefined) return;
    const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
    this.#contextTokens =
      n("input_tokens") +
      n("cache_read_input_tokens") +
      n("cache_creation_input_tokens") +
      n("output_tokens");
  }

  /** A compaction made the context smaller: the turn's usage starts from what it left (`post_tokens`). */
  compacted(tokens: number): void {
    this.#contextTokens = tokens;
  }

  /** The `usage_update` that ends a turn: context used, the window it is in, and the session's cost so far. */
  usageOf(result: SDKMessage): SessionUpdate | undefined {
    if (result.type !== "result" || this.#contextTokens === undefined) return undefined;
    const models = Object.values(
      (result as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {},
    );
    const size = Math.max(0, ...models.map((m) => m.contextWindow ?? 0));
    if (size === 0) return undefined;
    const cost = (result as { total_cost_usd?: number }).total_cost_usd;
    return {
      sessionUpdate: "usage_update",
      used: this.#contextTokens,
      size,
      ...(typeof cost === "number" ? { cost: { amount: cost, currency: "USD" } } : {}),
    } as SessionUpdate;
  }

  /**
   * The turn is over: a tool call shown starting that never got its result (the turn was stopped,
   * or the process went) ends here as `cancelled`, so no client shows it running for ever.
   */
  unfinished(): SessionUpdate[] {
    const updates = [...this.#open].map(
      (id) =>
        ({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "cancelled",
        }) as SessionUpdate,
    );
    for (const id of this.#open) this.#names.delete(id);
    this.#open.clear();
    return updates;
  }

  #toolResults(message: { content: unknown }, structured: unknown): SessionUpdate[] {
    if (!Array.isArray(message.content)) return [];
    const blocks = (message.content as Block[]).filter((block) => block.type === "tool_result");
    const updates: SessionUpdate[] = [];
    for (const block of blocks) {
      const id = String(block.tool_use_id);
      const failed = block.is_error === true;
      this.#open.delete(id);
      const name = this.#names.get(id);
      this.#names.delete(id);
      const planned = this.#planned(id, failed, structured, asText(block.content));
      if (planned !== undefined) updates.push(planned);
      // The structured result is the message's, not a block's: with more than one result in it, whose it is is not known.
      // Whether a failed call keeps its text is each tool's own reader's to say (`resultOf`).
      const read =
        blocks.length === 1 && name !== undefined
          ? resultOf(name, structured, block.content, failed)
          : undefined;
      const raw = rawOutputOf(block.content);
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: failed ? "failed" : "completed",
        content: read?.content ?? contentOf(block.content),
        ...(raw !== undefined ? { rawOutput: raw } : {}),
        ...(read?.locations !== undefined ? { locations: read.locations } : {}),
        ...(read?.meta !== undefined ? { _meta: { [TOOL_RESULT_META]: read.meta } } : {}),
      } as SessionUpdate);
    }
    return updates;
  }
}

/** Where a file tool works, as soon as it is called: its path, and the line a read starts at. */
const locationOf = (
  name: string,
  input: Record<string, unknown>,
): { path: string; line?: number } | undefined => {
  const path =
    name === "Read" || name === "Edit" || name === "Write"
      ? input.file_path
      : name === "NotebookEdit"
        ? input.notebook_path
        : undefined;
  if (typeof path !== "string" || path === "") return undefined;
  const offset = input.offset;
  return name === "Read" && typeof offset === "number" && offset >= 1
    ? { path, line: Math.floor(offset) }
    : { path };
};

type TaskStatus = "pending" | "in_progress" | "completed";
const statusOf = (value: unknown): TaskStatus =>
  value === "in_progress" || value === "completed" ? value : "pending";

/**
 * Claude's plan: its task list. It lives as long as the session, not the turn, because a task made in
 * one turn is updated in another. ACP wants the whole list every time, so every change sends all of it.
 * (After the adapter restarts, tasks made before are not known; an update of one still shows it.)
 */
export class PlanState {
  readonly #tasks = new Map<string, { subject: string; status: TaskStatus }>();

  /** TodoWrite: the whole list, replacing what there was. */
  replace(todos: { content?: unknown; status?: unknown }[]): void {
    this.#tasks.clear();
    for (const [index, todo] of todos.entries()) {
      this.#tasks.set(String(index), {
        subject: String(todo.content ?? ""),
        status: statusOf(todo.status),
      });
    }
  }

  create(id: string, subject: string): void {
    this.#tasks.set(id, { subject, status: "pending" });
  }

  update(id: string, change: { subject?: unknown; status?: unknown }): void {
    if (change.status === "deleted") {
      this.#tasks.delete(id);
      return;
    }
    const task = this.#tasks.get(id) ?? { subject: `Task #${id}`, status: "pending" as TaskStatus };
    if (typeof change.subject === "string") task.subject = change.subject;
    if (change.status !== undefined) task.status = statusOf(change.status);
    this.#tasks.set(id, task);
  }

  toUpdate(): SessionUpdate {
    return {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "tasks",
        entries: [...this.#tasks.values()].map((task) => ({
          content: task.subject,
          priority: "medium",
          status: task.status,
        })),
      },
    } as SessionUpdate;
  }
}

const chunk = (
  kind: "agent_message_chunk" | "agent_thought_chunk",
  messageId: string,
  text: string,
): SessionUpdate =>
  ({ sessionUpdate: kind, messageId, content: { type: "text", text } }) as SessionUpdate;

/** How a Claude `result` message ends the turn. `cancelled` is the adapter's to say, not the SDK's. */
export const stopReasonOf = (result: SDKMessage): StopReason => {
  if (result.type !== "result") {
    return {
      stopReason: "error",
      error: { code: -32603, message: "The turn ended without a result" },
    };
  }
  if (result.subtype === "success") {
    const reason = (result as { stop_reason?: string | null }).stop_reason;
    if (reason === "max_tokens") return { stopReason: "max_tokens" };
    if (reason === "refusal") return { stopReason: "refusal" };
    return { stopReason: "end_turn" };
  }
  if (result.subtype === "error_max_turns") return { stopReason: "max_turn_requests" };
  return {
    stopReason: "error",
    error: { code: -32603, message: `The turn failed: ${result.subtype}` },
  };
};
