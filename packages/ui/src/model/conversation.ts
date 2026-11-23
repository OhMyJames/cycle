// The model of a conversation: what a stream of ACP v2 `session/update`s adds up to.
//
// Pure TypeScript with no React and no DOM, because the Electron main process holds a conversation
// per session too (a renderer that reloads must get it back whole) and main is not a browser.
//
// ACP v2's rules for updates (see the SDK's v2 header): an omitted field stays as it was, `null`
// clears it, any other value replaces it, and chunks append. Entities are patched by their id.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

/** A piece of content. Only `text` and `image` are drawn; anything else is kept and shown plainly. */
export type Block = { type: string; [key: string]: unknown };

export type ToolStatus =
  | "pending"
  | "in_progress"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Every item says which turn it began in: the number of turns that had ended before it. A turn is what ACP v2 leaves
 * out (it has only `running` and `idle`), but the daemon's log keeps how each one ended, so it can be told from the
 * data, in a live stream and in a replay alike, with nothing inferred from the text.
 */
type InTurn = {
  turn: number;
  /**
   * When it began: the daemon's time on its first record (`cycle/ts`, milliseconds since the epoch). Absent when not
   * known (an older daemon): never the time it arrived, never 0.
   */
  at?: number;
};

/** A message streams in chunks: `lastAt` is the time on the last one, absent when not known (docs/protocol.md §5). */
type Streamed = InTurn & { blocks: Block[]; lastAt?: number };

export type UserItem = Streamed & { kind: "user"; id: string };
export type AgentItem = Streamed & { kind: "agent"; id: string };
export type ThoughtItem = Streamed & { kind: "thought"; id: string };
export type ToolItem = InTurn & {
  kind: "tool";
  id: string;
  name?: string;
  /** A title for people, when the agent gave one (an MCP tool's "server · tool"). */
  title?: string;
  toolKind?: string;
  status?: string;
  content: Block[];
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: { path: string; line?: number | null }[];
  /**
   * `_meta["cycle/toolResult"]` of the call's result: what it amounts to in numbers (docs/protocol.md §9). The daemon
   * keeps it only when it matches the protocol's schema; the model still reads it field by field (`toolFacts`).
   */
  result?: unknown;
  /** The sub-agent this call started (the Agent tool), as its `subagent_update`s have told it (decision 0014). */
  subagent?: Subagent;
  /**
   * The agent said it was going, or done: it ran, or began to. A call that only ever waited (for a permission) has not;
   * the end of a turn marks both cancelled, so this is what tells them apart (CYCL-48).
   */
  started?: boolean;
};

/**
 * A sub-agent, as far as the session is told: announced, its progress, its end, and what it said and called on the way
 * (`_cycle/child_update`, docs/protocol.md §9, CYCL-134).
 */
export type Subagent = {
  /** Its id (`subagent_update`'s `sessionId`): what its conversation's updates name it by. Absent in older news. */
  id?: string;
  /** Its agent said it can be stopped alone (ACP v2 `capabilities.cancel`, CYCL-143). */
  stoppable?: boolean;
  /**
   * What it said and called, as a conversation of its own: one turn, its items in order. Absent until it says
   * something, and in a history from before a daemon told it.
   */
  conversation?: Conversation;
  state: "running" | "done" | "failed" | "stopped" | "unknown" | "dismissed";
  background: boolean;
  /** What it is doing now, in a line the SDK wrote (only with progress summaries on). */
  summary?: string;
  /** The tool it used last ("Read"). */
  lastTool?: string;
  usage?: { tokens: number; toolUses: number; durationMs: number };
};
export type PlanEntry = { content: string; priority: string; status: string };
/** One part of what the context window holds, as the agent counts it (`_meta["cycle/context"]`, docs/protocol.md §8). */
export type ContextPart = {
  /** Which part (`messages`, `system_tools`, …): what a client names it by; absent when the agent did not say. */
  id?: string;
  /** The agent's own name for it, for a part this client does not know. */
  name: string;
  tokens: number;
  /** `used` is in the window; `free` is what is left; `buffer` is kept for compaction; `deferred` is not loaded. */
  kind: "used" | "free" | "buffer" | "deferred";
};

export type Usage = {
  /** Tokens in context after the last model call (cache reads and writes included). */
  used: number;
  /** The window the usage is measured against: the agent's, or the model's when the agent did not say. */
  size: number;
  /** What the window holds, by part, when the agent said; only for this usage, never carried over to the next. */
  parts?: ContextPart[];
  /** Where the agent compacts by itself, in tokens. */
  autoCompactAt?: number;
  /** What the session has cost so far. */
  cost?: { amount: number; currency: string };
  /**
   * A compaction completed after this was measured, and no newer usage came (docs/protocol.md §8): it is from before,
   * and says nothing of now.
   */
  beforeCompaction?: true;
};

/** How the context stands, for the composer's ring and its details: the usage, and the compactions told so far. */
export type ContextState = {
  usage: Usage | undefined;
  /** Compactions that completed in this conversation. */
  compactions: number;
  /** A compaction is running now. */
  compacting: boolean;
};

export type PlanItem = InTurn & { kind: "plan"; id: string; entries: PlanEntry[] };
export type NoticeItem = InTurn & {
  kind: "notice";
  id: string;
  severity: string;
  title: string;
  /**
   * The agent is trying its model request again by itself (`_meta["cycle/retry"]`, docs/protocol.md §8): a state while it
   * is the last thing in the turn, never a row.
   */
  retry?: { attempt?: number; maxRetries?: number };
};
/** The agent making room in its context: going, done, or not done. One line where it began. */
export type CompactionItem = InTurn & {
  kind: "compaction";
  id: string;
  status: "in_progress" | "completed" | "failed" | "cancelled";
};

export type Item =
  | UserItem
  | AgentItem
  | ThoughtItem
  | ToolItem
  | PlanItem
  | NoticeItem
  | CompactionItem;

export type Status = "idle" | "running" | "requires_action";

export type StopReason = {
  stopReason: string;
  error?: { code?: number; message?: string } | null | undefined;
};

/** A prompt waiting for the agent, as the daemon holds it (docs/protocol.md §8). `queueId` is the daemon's. */
export type QueuedPrompt = { queueId: string; prompt: Block[] };

/** Prompts the daemon handed back, to be put in the input box. `serial` changes each time, so one is acted on once. */
export type Returned = {
  serial: number;
  returnId?: string;
  prompts: QueuedPrompt[];
  reason?: string;
};

/** A command the agent offers, typed as `/name` at the start of a message. */
export type Command = { name: string; description: string; hint?: string };

/** One choice in a live ACP `config_option_update` (e.g. a model from Claude's `initializationResult().models`). */
export type DynamicConfigChoice = {
  value: string;
  name: string;
  description?: string;
  recommended?: boolean;
  danger?: boolean;
  /** On a model: the effort levels it takes (`_meta["cycle/efforts"]`, docs/protocol.md §10); `[]` none, absent not known. */
  efforts?: string[];
};

/** Live configuration options pushed by the agent for a session, overlaying its static `configSchema`. */
export type DynamicConfigOption = {
  configId: string;
  name: string;
  currentValue?: string;
  options: DynamicConfigChoice[];
};

// The two updates of docs/protocol.md §9 (CYCL-87), read here by hand: the model imports nothing of the daemon's.
const TASK_UPDATE = "_cycle/task_update";
const GOAL_UPDATE = "_cycle/goal_update";
/** What is set to wake the session later (docs/protocol.md §9, CYCL-146). */
const SCHEDULE_UPDATE = "_cycle/schedule_update";
/** A sub-agent's conversation, carried in its parent session (docs/protocol.md §9, CYCL-134). */
const CHILD_UPDATE = "_cycle/child_update";
const TASK_KINDS = ["shell", "monitor", "workflow", "mcp", "other"] as const;
const TASK_STATES = ["running", "completed", "failed", "stopped", "unknown"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskState = (typeof TASK_STATES)[number];

/** The goal the user set the session (Claude Code's /goal). */
export type Goal = {
  condition: string;
  /** How many times it was checked and found not met. */
  iterations: number;
  /** When it was set, in milliseconds. */
  setAt: number;
  lastReason?: string;
};

const oneOf = <T extends string>(words: readonly T[], value: unknown): T | undefined =>
  words.find((w) => w === value);
const textOr = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const goalOf = (value: unknown): Goal | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.condition !== "string") return undefined;
  const lastReason = textOr(v.lastReason);
  return {
    condition: v.condition,
    iterations: typeof v.iterations === "number" && v.iterations >= 0 ? v.iterations : 0,
    setAt: typeof v.setAt === "number" ? v.setAt : 0,
    ...(lastReason !== undefined ? { lastReason } : {}),
  };
};

/** A task the agent runs in the background that is not a sub-agent (docs/protocol.md §9): a command, a watcher. */
export type BackgroundTask = {
  id: string;
  kind: TaskKind;
  title: string | undefined;
  /** The tool call that started it, to go back to in the conversation. */
  toolCallId: string | undefined;
  state: TaskState;
};

/** Something set to wake the session later: a cron (CronCreate, /loop) or a wakeup (ScheduleWakeup). */
export type ScheduledJob = {
  id: string;
  kind: "cron" | "wakeup";
  /** A five-field cron expression, in the agent's machine's local time. */
  schedule: string;
  humanSchedule: string | undefined;
  recurring: boolean;
  /** Saved in the project, outliving the session: what is known is what was last heard. */
  durable: boolean;
  prompt: string;
  /** When it is expected to fire next, worked out by the agent: a guess, not a promise. */
  nextFireAt: number | undefined;
  toolCallId: string | undefined;
};

/** The list as last told, and whether the agent's process was gone. */
export type Schedules = {
  jobs: ScheduledJob[];
  /**
   * The agent's process is gone and something not durable is set: it fires only if the session is used again first.
   * The agent says so only when something would be missed.
   */
  dormant: boolean;
};

const jobOf = (value: unknown): ScheduledJob | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const kind = oneOf(["cron", "wakeup"] as const, v.kind);
  if (typeof v.id !== "string" || typeof v.schedule !== "string" || kind === undefined)
    return undefined;
  return {
    id: v.id,
    kind,
    schedule: v.schedule,
    humanSchedule: textOr(v.humanSchedule),
    recurring: v.recurring === true,
    durable: v.durable === true,
    prompt: typeof v.prompt === "string" ? v.prompt : "",
    nextFireAt: typeof v.nextFireAt === "number" ? v.nextFireAt : undefined,
    toolCallId: textOr(v.toolCallId),
  };
};

export type Conversation = {
  items: Item[];
  status: Status;
  /** Turns that have ended: an idle that says why. A bare idle is a snapshot and is not one. */
  turns: number;
  /** How each ended turn ended: `stops[n]` is turn n's. The turn still going has none. */
  stops: StopReason[];
  /** True from the start of a replay until `replay_complete`. */
  replaying: boolean;
  usage: Usage | undefined;
  /** The prompts sent while the agent works, oldest first: the last snapshot the daemon wrote. */
  queue: QueuedPrompt[];
  /** What the daemon last handed back. Only set when it arrives live: a replay never sets it. */
  returned: Returned | undefined;
  commands: Command[];
  /** Live config options pushed by the agent (models, per-model effort levels, modes), if any. */
  configOptions: DynamicConfigOption[];
  /** Updates of a kind this version does not draw. */
  ignored: number;
  /** Sub-agents announced before the call that started them was seen, by that call's id. */
  waiting: Record<string, Subagent>;
  /** The background tasks that are not sub-agents, in the order they were first told. */
  tasks: BackgroundTask[];
  /** The goal the user set; `null` when there is none, `undefined` when the agent never said (it may not tell). */
  goal: Goal | null | undefined;
  /** What is set to wake the session; `undefined` when the agent never said (it may not tell). */
  schedules: Schedules | undefined;
};

export const emptyConversation = (): Conversation => ({
  items: [],
  status: "idle",
  turns: 0,
  stops: [],
  replaying: false,
  usage: undefined,
  queue: [],
  returned: undefined,
  commands: [],
  configOptions: [],
  ignored: 0,
  waiting: {},
  tasks: [],
  goal: undefined,
  schedules: undefined,
});

const PART_KINDS: readonly string[] = ["used", "free", "buffer", "deferred"];
const tokensOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The parts in a `usage_update`'s `_meta["cycle/context"]`, keeping only what reads as one. */
const contextOfMeta = (
  value: unknown,
): { parts?: ContextPart[]; autoCompactAt?: number } | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const parts = Array.isArray(v.parts)
    ? v.parts.flatMap((p): ContextPart[] => {
        if (typeof p !== "object" || p === null) return [];
        const { id, name, tokens, kind } = p as Record<string, unknown>;
        const n = tokensOf(tokens);
        // An empty part is no part (docs/protocol.md §8).
        if (typeof name !== "string" || !n || !PART_KINDS.includes(kind as string)) return [];
        return [
          {
            ...(typeof id === "string" ? { id } : {}),
            name,
            tokens: n,
            kind: kind as ContextPart["kind"],
          },
        ];
      })
    : undefined;
  const autoCompactAt = tokensOf(v.autoCompactAt);
  return {
    ...(parts !== undefined && parts.length > 0 ? { parts } : {}),
    ...(autoCompactAt !== undefined ? { autoCompactAt } : {}),
  };
};

export const contextOf = (c: Conversation): ContextState => {
  let compactions = 0;
  let compacting = false;
  for (const item of c.items) {
    if (item.kind !== "compaction") continue;
    if (item.status === "completed") compactions += 1;
    // Only while something is running: one never told as over (its process went with the daemon) is not "now".
    else if (item.status === "in_progress" && c.status !== "idle") compacting = true;
  }
  return { usage: c.usage, compactions, compacting };
};

const queuedPrompts = (value: unknown): QueuedPrompt[] =>
  Array.isArray(value)
    ? value.flatMap((entry): QueuedPrompt[] => {
        const e = entry as { queueId?: unknown; prompt?: unknown } | null;
        return typeof e?.queueId === "string" && Array.isArray(e.prompt)
          ? [{ queueId: e.queueId, prompt: e.prompt as Block[] }]
          : [];
      })
    : [];

/**
 * A model choice's effort levels, from its `_meta["cycle/efforts"]` (docs/protocol.md §10): a list of words, `[]` for
 * none; anything else is not known.
 */
export const effortLevelsOf = (meta: Record<string, unknown> | undefined): string[] | undefined => {
  const value = meta?.["cycle/efforts"];
  return Array.isArray(value) && value.every((e) => typeof e === "string")
    ? [...(value as string[])]
    : undefined;
};

const effortsEntry = (meta: Record<string, unknown> | undefined): { efforts?: string[] } => {
  const efforts = effortLevelsOf(meta);
  return efforts !== undefined ? { efforts } : {};
};

const configOptionsOf = (value: unknown): DynamicConfigOption[] => {
  if (!Array.isArray(value)) return [];
  const out: DynamicConfigOption[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as {
      configId?: unknown;
      name?: unknown;
      currentValue?: unknown;
      options?: unknown;
    };
    if (typeof e.configId !== "string" || !Array.isArray(e.options)) continue;
    const options: DynamicConfigChoice[] = [];
    for (const raw of e.options) {
      if (typeof raw !== "object" || raw === null) continue;
      const o = raw as {
        value?: unknown;
        name?: unknown;
        description?: unknown;
        _meta?: Record<string, unknown>;
      };
      if (typeof o.value !== "string" || o.value === "") continue;
      options.push({
        value: o.value,
        name: typeof o.name === "string" && o.name !== "" ? o.name : o.value,
        ...(typeof o.description === "string" && o.description !== ""
          ? { description: o.description }
          : {}),
        ...(o._meta?.["cycle/recommended"] === true ? { recommended: true } : {}),
        ...(o._meta?.["cycle/danger"] === true ? { danger: true } : {}),
        ...effortsEntry(o._meta),
      });
    }
    if (options.length === 0) continue;
    out.push({
      configId: e.configId,
      name: typeof e.name === "string" && e.name !== "" ? e.name : e.configId,
      ...(typeof e.currentValue === "string" ? { currentValue: e.currentValue } : {}),
      options,
    });
  }
  return out;
};

const commandsOf = (value: unknown): Command[] =>
  Array.isArray(value)
    ? value.flatMap((entry): Command[] => {
        const e = entry as {
          type?: unknown;
          name?: unknown;
          description?: unknown;
          input?: { type?: unknown; hint?: unknown } | null;
        } | null;
        // Only commands: an entry of another type is something this version does not offer.
        if (e === null || (e.type !== undefined && e.type !== "command")) return [];
        if (typeof e.name !== "string" || e.name === "") return [];
        const hint =
          e.input?.type === "text" && typeof e.input.hint === "string" ? e.input.hint : "";
        return [
          {
            name: e.name,
            description: typeof e.description === "string" ? e.description : "",
            ...(hint === "" ? {} : { hint }),
          },
        ];
      })
    : [];

const FINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

type Fields = Record<string, unknown>;

/** The ACP patch rule for one field: undefined keeps the old value, null clears, else replaces. */
const patch = <T>(old: T | undefined, next: unknown): T | undefined => {
  if (next === undefined) return old;
  if (next === null) return undefined;
  return next as T;
};

const keyOf = (item: Item): string => `${item.kind}:${item.id}`;

const upsert = (items: Item[], next: Item): Item[] => {
  const key = keyOf(next);
  const at = items.findIndex((item) => keyOf(item) === key);
  if (at === -1) return [...items, next];
  const copy = items.slice();
  copy[at] = next;
  return copy;
};

const find = <K extends Item["kind"]>(items: Item[], kind: K, id: string) =>
  items.find((item) => item.kind === kind && item.id === id) as
    | Extract<Item, { kind: K }>
    | undefined;

const asBlocks = (content: unknown): Block[] =>
  Array.isArray(content) ? (content as Block[]) : [];

/** Appends a block, joining text onto the text before it so a stream is one run of text. */
const appendBlock = (blocks: Block[], block: Block): Block[] => {
  const last = blocks.at(-1);
  if (block.type === "text" && last?.type === "text") {
    return [...blocks.slice(0, -1), { ...last, text: String(last.text) + String(block.text) }];
  }
  return [...blocks, block];
};

/** A time as the model keeps it: milliseconds since the epoch, or undefined for anything that is not one. */
const timeOf = (at: number | undefined): number | undefined =>
  at !== undefined && Number.isFinite(at) && at > 0 ? at : undefined;

/** When an item began: kept from what it was; a new one began now, if the update says when now is. */
const began = (old: InTurn | undefined, at: number | undefined): { at?: number } => {
  const when = old === undefined ? at : old.at;
  return when !== undefined ? { at: when } : {};
};

const messageUpdate = (
  c: Conversation,
  kind: "user" | "agent" | "thought",
  update: Fields,
  chunk: boolean,
  at: number | undefined,
): Conversation => {
  const id = String(update.messageId);
  const old = find(c.items, kind, id);
  let blocks = old?.blocks ?? [];
  if (chunk) {
    if (update.content !== undefined && update.content !== null) {
      blocks = appendBlock(blocks, update.content as Block);
    }
  } else if (update.content === null) {
    blocks = [];
  } else if (update.content !== undefined) {
    blocks = asBlocks(update.content);
  }
  // An update with no time leaves the last one known rather than say it is unknown again.
  const lastAt = at ?? old?.lastAt;
  return {
    ...c,
    items: upsert(c.items, {
      kind,
      id,
      blocks,
      turn: old?.turn ?? c.turns,
      ...began(old, at),
      ...(lastAt !== undefined ? { lastAt } : {}),
    }),
  };
};

const toolUpdate = (c: Conversation, update: Fields, at: number | undefined): Conversation => {
  const id = String(update.toolCallId);
  const old = find(c.items, "tool", id);
  const next: ToolItem = {
    kind: "tool",
    id,
    turn: old?.turn ?? c.turns,
    ...began(old, at),
    content: old?.content ?? [],
  };
  const name = patch(old?.name, update.name);
  const title = patch(old?.title, update.title);
  const toolKind = patch(old?.toolKind, update.kind);
  const status = patch(old?.status, update.status);
  const content =
    update.content === undefined ? old?.content : update.content === null ? [] : update.content;
  const rawInput = update.rawInput === undefined ? old?.rawInput : update.rawInput;
  const rawOutput = update.rawOutput === undefined ? old?.rawOutput : update.rawOutput;
  const locations = patch(old?.locations, update.locations);
  // The counts belong to the content they came with: new content without them clears them.
  const said = (update._meta as Record<string, unknown> | null | undefined)?.["cycle/toolResult"];
  const result = said !== undefined ? said : update.content !== undefined ? undefined : old?.result;
  if (name !== undefined) next.name = name;
  if (title !== undefined) next.title = title;
  if (toolKind !== undefined) next.toolKind = toolKind;
  if (status !== undefined) next.status = status;
  // Once it has been anything but pending, it ran (or began to): kept when the end of the turn marks it cancelled.
  if (old?.started === true || (typeof update.status === "string" && update.status !== "pending"))
    next.started = true;
  next.content = asBlocks(content);
  if (rawInput !== undefined) next.rawInput = rawInput;
  if (rawOutput !== undefined) next.rawOutput = rawOutput;
  if (locations !== undefined) next.locations = locations;
  if (result !== undefined) next.result = result;
  if (old?.subagent !== undefined) next.subagent = old.subagent;
  const waiting = c.waiting[id];
  if (old === undefined && waiting !== undefined) {
    next.subagent = waiting;
    const { [id]: _taken, ...rest } = c.waiting;
    return { ...c, items: upsert(c.items, next), waiting: rest };
  }
  return { ...c, items: upsert(c.items, next) };
};

/**
 * A sub-agent's news, onto the call that started it (`_meta["cycle/subagent"].toolCallId`). Each update says only what
 * changed: a field it leaves out stays as it was. News of a call not seen yet waits for it.
 */
/** How many sub-agents' news may wait for their calls at once. */
const MAX_WAITING = 16;

/**
 * `c` with the conversation of the sub-agent `childId` changed by `change`, wherever its call is: in `c`, waiting for its
 * call, or in another sub-agent's conversation (one started by a sub-agent). Undefined when no such sub-agent is known.
 */
const withChild = (
  c: Conversation,
  childId: string,
  change: (conversation: Conversation) => Conversation,
  depth = 0,
): Conversation | undefined => {
  // Sub-agents start sub-agents only a few deep; a history that says otherwise is not followed for ever.
  if (depth > MAX_DEPTH) return undefined;
  for (const item of c.items) {
    if (item.kind !== "tool" || item.subagent === undefined) continue;
    const sub = item.subagent;
    if (sub.id === childId) {
      const conversation = change(sub.conversation ?? emptyConversation());
      return { ...c, items: upsert(c.items, { ...item, subagent: { ...sub, conversation } }) };
    }
    if (sub.conversation === undefined) continue;
    const inner = withChild(sub.conversation, childId, change, depth + 1);
    if (inner !== undefined)
      return {
        ...c,
        items: upsert(c.items, { ...item, subagent: { ...sub, conversation: inner } }),
      };
  }
  for (const [callId, sub] of Object.entries(c.waiting)) {
    if (sub.id !== childId) continue;
    const conversation = change(sub.conversation ?? emptyConversation());
    return { ...c, waiting: { ...c.waiting, [callId]: { ...sub, conversation } } };
  }
  return undefined;
};
const MAX_DEPTH = 8;

/**
 * The Agent call that started the sub-agent `childId`, wherever it is (in a sub-agent's conversation, for one a
 * sub-agent started). Undefined when it is not known here: a permission it asks for still says that a sub-agent asks.
 */
export const subagentCallOf = (
  c: Conversation,
  childId: string,
  depth = 0,
): ToolItem | undefined => {
  if (depth > MAX_DEPTH) return undefined;
  for (const item of c.items) {
    if (item.kind !== "tool" || item.subagent === undefined) continue;
    if (item.subagent.id === childId) return item;
    const inner = item.subagent.conversation;
    const found = inner !== undefined ? subagentCallOf(inner, childId, depth + 1) : undefined;
    if (found !== undefined) return found;
  }
  return undefined;
};

/** What a sub-agent's conversation may hold (docs/protocol.md §9): anything else in one is not drawn. */
const CHILD_KINDS: ReadonlySet<string> = new Set([
  "agent_message",
  "agent_message_chunk",
  "agent_thought",
  "agent_thought_chunk",
  "tool_call_update",
  "tool_call_content_chunk",
]);

/** One update of a sub-agent's conversation, onto that sub-agent. */
const childUpdate = (
  c: Conversation,
  update: Fields,
  record: { at?: number | undefined } | undefined,
): Conversation => {
  const inner = update.update as Fields | null | undefined;
  if (
    typeof update.childId !== "string" ||
    typeof inner !== "object" ||
    inner === null ||
    typeof inner.sessionUpdate !== "string" ||
    !CHILD_KINDS.has(inner.sessionUpdate)
  )
    return { ...c, ignored: c.ignored + 1 };
  const next = withChild(c, update.childId, (conversation) =>
    applyUpdate(conversation, inner as unknown as SessionUpdate, record),
  );
  return next ?? { ...c, ignored: c.ignored + 1 };
};

/**
 * A sub-agent that is over has nothing of its own still going: a call it left (a history cut short) did not finish, and
 * a sub-agent it started and never heard the end of stopped with it.
 */
const ended = (conversation: Conversation | undefined, depth = 0): Conversation | undefined => {
  if (conversation === undefined || depth > MAX_DEPTH) return conversation;
  return {
    ...conversation,
    items: conversation.items.map((item) => {
      if (item.kind !== "tool") return item;
      const open = item.status !== undefined && !FINAL.has(item.status);
      const sub = item.subagent;
      const running = sub !== undefined && sub.state === "running";
      if (!open && !running) return item;
      const conversation = running ? ended(sub.conversation, depth + 1) : undefined;
      return {
        ...item,
        ...(open ? { status: "cancelled" } : {}),
        ...(running
          ? {
              subagent: {
                ...sub,
                state: "stopped" as const,
                ...(conversation !== undefined ? { conversation } : {}),
              },
            }
          : {}),
      };
    }),
  };
};

const subagentUpdate = (c: Conversation, update: Fields, nested = false): Conversation => {
  const meta = (update._meta as Record<string, unknown> | null | undefined)?.["cycle/subagent"] as
    | Record<string, unknown>
    | undefined;
  const callId = typeof meta?.toolCallId === "string" ? meta.toolCallId : undefined;
  if (callId === undefined || meta === undefined) return { ...c, ignored: c.ignored + 1 };
  // A sub-agent started by a sub-agent: its call is in that sub-agent's conversation.
  if (typeof meta.parentId === "string" && !nested) {
    const next = withChild(c, meta.parentId, (inner) => subagentUpdate(inner, update, true));
    return next ?? { ...c, ignored: c.ignored + 1 };
  }
  const tool = find(c.items, "tool", callId);
  const was = tool?.subagent ??
    c.waiting[callId] ?? { state: "running" as const, background: false };
  const next: Subagent = { ...was };
  if (typeof update.sessionId === "string") next.id = update.sessionId;
  // ACP v2 patch rules: left out keeps what was said; `null`, or a `cancel` of null, takes it back.
  if (update.capabilities !== undefined) {
    const cancel = (update.capabilities as { cancel?: unknown } | null)?.cancel;
    if (cancel !== undefined && cancel !== null) next.stoppable = true;
    else if (update.capabilities === null || cancel === null) delete next.stoppable;
  }
  const state = update.state as { state?: unknown; stopReason?: unknown } | null | undefined;
  if (state?.state === "running") next.state = "running";
  else if (state?.state === "idle") {
    next.state =
      state.stopReason === "end_turn"
        ? "done"
        : state.stopReason === "error"
          ? "failed"
          : "stopped";
  }
  if (meta.status === "unknown" || meta.status === "dismissed") next.state = meta.status;
  if (typeof meta.background === "boolean") next.background = meta.background;
  if (typeof meta.summary === "string") next.summary = meta.summary;
  if (typeof meta.lastTool === "string") next.lastTool = meta.lastTool;
  const usage = meta.usage as Record<string, unknown> | null | undefined;
  if (typeof usage === "object" && usage !== null) {
    // Each count that is given replaces the one before; one left out stays.
    const was = next.usage ?? { tokens: 0, toolUses: 0, durationMs: 0 };
    const n = (key: "tokens" | "toolUses" | "durationMs") =>
      typeof usage[key] === "number" ? (usage[key] as number) : was[key];
    next.usage = { tokens: n("tokens"), toolUses: n("toolUses"), durationMs: n("durationMs") };
  }
  // Over, not only out of sight: one whose end is unknown may still be at work.
  if (next.state !== "running" && next.state !== "unknown" && next.conversation !== undefined) {
    const over = ended(next.conversation);
    if (over !== undefined) next.conversation = over;
  }
  if (tool === undefined) {
    // Its call is not known yet (the news came first): kept, and put on the call when it comes. Only a few are kept:
    // news whose call never comes must not grow the conversation for good.
    const { [callId]: _was, ...rest } = c.waiting;
    const kept = Object.entries(rest).slice(-(MAX_WAITING - 1));
    return { ...c, waiting: { ...Object.fromEntries(kept), [callId]: next } };
  }
  return { ...c, items: upsert(c.items, { ...tool, subagent: next }) };
};

const stateUpdate = (c: Conversation, update: Fields): Conversation => {
  const state = update.state;
  if (state !== "running" && state !== "idle" && state !== "requires_action")
    return { ...c, ignored: c.ignored + 1 };
  if (state !== "idle") return { ...c, status: state };
  const reason = update.stopReason;
  // An idle with no stopReason is a snapshot of the state, not the end of a turn: apply it, count nothing.
  if (typeof reason !== "string") return { ...c, status: "idle" };
  // Work that was still going when the turn ended will not finish, however the turn ended: the agent
  // says so for a call it left (it ends it as cancelled), and a record made before it did is read the same.
  const items = c.items.map((item) =>
    item.kind === "tool" && item.status !== undefined && !FINAL.has(item.status)
      ? { ...item, status: "cancelled" }
      : item,
  );
  const stop: StopReason = { stopReason: reason };
  if (update.error !== undefined) stop.error = update.error as StopReason["error"];
  return { ...c, items, status: "idle", turns: c.turns + 1, stops: [...c.stops, stop] };
};

/**
 * Applies one `session/update`. `record.at` is when the daemon logged it (`_meta["cycle/ts"]`, milliseconds since the
 * epoch), undefined when not known. It is an object, not a bare number, so `updates.reduce(applyUpdate)` cannot take
 * an array index for a time. Returns a new conversation; the old one is not changed.
 */
export const applyUpdate = (
  c: Conversation,
  update: SessionUpdate,
  record?: { at?: number | undefined },
): Conversation => {
  const u = update as unknown as Fields;
  const when = timeOf(record?.at);
  switch (u.sessionUpdate) {
    case "user_message":
      return messageUpdate(c, "user", u, false, when);
    case "user_message_chunk":
      return messageUpdate(c, "user", u, true, when);
    case "agent_message":
      return messageUpdate(c, "agent", u, false, when);
    case "agent_message_chunk":
      return messageUpdate(c, "agent", u, true, when);
    case "agent_thought":
      return messageUpdate(c, "thought", u, false, when);
    case "agent_thought_chunk":
      return messageUpdate(c, "thought", u, true, when);
    case "tool_call_update":
      return toolUpdate(c, u, when);
    case "tool_call_content_chunk": {
      const old = find(c.items, "tool", String(u.toolCallId));
      const content = appendBlock(old?.content ?? [], (u.content ?? {}) as Block);
      return toolUpdate(c, { toolCallId: u.toolCallId, content }, when);
    }
    case "state_update":
      return stateUpdate(c, u);
    case "plan_update": {
      const plan = u.plan as { type?: string; planId?: string; entries?: PlanEntry[] } | undefined;
      if (plan?.type !== "items" || plan.planId === undefined)
        return { ...c, ignored: c.ignored + 1 };
      const old = find(c.items, "plan", plan.planId);
      return {
        ...c,
        items: upsert(c.items, {
          kind: "plan",
          id: plan.planId,
          turn: old?.turn ?? c.turns,
          ...began(old, when),
          entries: plan.entries ?? [],
        }),
      };
    }
    case "notice": {
      const id = `notice-${c.items.length}`;
      const meta = u._meta as Record<string, unknown> | null | undefined;
      const said = meta?.["cycle/retry"] as Record<string, unknown> | null | undefined;
      const count = (value: unknown) =>
        typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
      let retry: NoticeItem["retry"];
      if (typeof said === "object" && said !== null) {
        const attempt = count(said.attempt);
        const maxRetries = count(said.maxRetries);
        retry = {
          ...(attempt !== undefined ? { attempt } : {}),
          ...(maxRetries !== undefined ? { maxRetries } : {}),
        };
      }
      return {
        ...c,
        items: [
          ...c.items,
          {
            kind: "notice",
            id,
            turn: c.turns,
            ...began(undefined, when),
            severity: String(u.severity),
            title: String(u.title),
            ...(retry !== undefined ? { retry } : {}),
          },
        ],
      };
    }
    case "usage_update": {
      // The cost: omitted keeps the last one, null clears it, a value replaces it.
      const given = u.cost as { amount: number; currency: string } | null | undefined;
      const cost = given === undefined ? c.usage?.cost : (given ?? undefined);
      const context = contextOfMeta(
        (u._meta as Record<string, unknown> | null | undefined)?.["cycle/context"],
      );
      // Where it compacts stays with the window it was told for: the usage told after a compaction does not repeat it.
      // Only when it says nothing of the window: a count without it says auto-compaction is off.
      const autoCompactAt =
        context !== undefined
          ? context.autoCompactAt
          : c.usage?.size === Number(u.size)
            ? c.usage?.autoCompactAt
            : undefined;
      return {
        ...c,
        usage: {
          used: Number(u.used),
          size: Number(u.size),
          ...(cost !== undefined ? { cost } : {}),
          ...(context?.parts !== undefined ? { parts: context.parts } : {}),
          ...(autoCompactAt !== undefined ? { autoCompactAt } : {}),
        },
      };
    }
    case "replay_complete":
      return { ...c, replaying: false };
    case TASK_UPDATE: {
      const state = oneOf(TASK_STATES, u.state);
      if (typeof u.taskId !== "string" || state === undefined)
        return { ...c, ignored: c.ignored + 1 };
      const at = c.tasks.findIndex((t) => t.id === u.taskId);
      const old = c.tasks[at];
      // The first news of a task names its kind; a task first heard of without one (a cut history) is "other".
      const task: BackgroundTask = {
        id: u.taskId,
        kind: oneOf(TASK_KINDS, u.kind) ?? old?.kind ?? "other",
        title: textOr(u.title) ?? old?.title,
        toolCallId: textOr(u.toolCallId) ?? old?.toolCallId,
        state,
      };
      return {
        ...c,
        tasks: at === -1 ? [...c.tasks, task] : c.tasks.with(at, task),
      };
    }
    case SCHEDULE_UPDATE: {
      if (!Array.isArray(u.jobs)) return { ...c, ignored: c.ignored + 1 };
      const jobs = u.jobs.flatMap((j) => {
        const job = jobOf(j);
        return job !== undefined ? [job] : [];
      });
      return { ...c, schedules: { jobs, dormant: u.dormant === true } };
    }
    case GOAL_UPDATE: {
      if (u.goal === null) return { ...c, goal: null };
      const goal = goalOf(u.goal);
      return goal !== undefined ? { ...c, goal } : { ...c, ignored: c.ignored + 1 };
    }
    case "_cycle/queue_update": {
      const returned = queuedPrompts(u.returned);
      return {
        ...c,
        queue: typeof u.returnId === "string" ? c.queue : queuedPrompts(u.entries),
        // Handed back is an event: heard live, it goes to the input box once; in a replay it is history.
        ...(returned.length > 0 && !c.replaying
          ? {
              returned: {
                serial: (c.returned?.serial ?? 0) + 1,
                prompts: returned,
                ...(typeof u.returnId === "string" ? { returnId: u.returnId } : {}),
                ...(typeof u.reason === "string" ? { reason: u.reason } : {}),
              },
            }
          : {}),
      };
    }
    case "subagent_update":
      return subagentUpdate(c, u);
    case CHILD_UPDATE:
      return childUpdate(c, u, record);
    case "compaction_update": {
      const id = typeof u.compactionId === "string" ? u.compactionId : undefined;
      const status = u.status;
      if (id === undefined) return { ...c, ignored: c.ignored + 1 };
      const known =
        status === "in_progress" ||
        status === "completed" ||
        status === "failed" ||
        status === "cancelled";
      const old = find(c.items, "compaction", id);
      // An update with a status this version does not know keeps the one before.
      const next = known ? status : (old?.status ?? "in_progress");
      const compacted = next === "completed" && old?.status !== "completed";
      return {
        ...c,
        ...(compacted && c.usage !== undefined
          ? { usage: { ...c.usage, beforeCompaction: true as const } }
          : {}),
        items: upsert(c.items, {
          kind: "compaction",
          id,
          turn: old?.turn ?? c.turns,
          ...began(old, when),
          status: next,
        }),
      };
    }
    case "compaction_summary_chunk":
      // The summary is the agent's note to itself; the line says that it happened.
      return c;
    case "available_commands_update":
      return { ...c, commands: commandsOf(u.availableCommands) };
    case "config_option_update": {
      const next = configOptionsOf(u.configOptions);
      return next.length > 0 ? { ...c, configOptions: next } : c;
    }
    case "session_info_update":
      // Known, and not drawn in the conversation.
      return c;
    default:
      return { ...c, ignored: c.ignored + 1 };
  }
};

/** The conversation after `updates`, applied in order. */
export const reduce = (
  updates: SessionUpdate[],
  from: Conversation = emptyConversation(),
): Conversation => updates.reduce((c, u) => applyUpdate(c, u), from);

/** What the composer may do: a turn is over and nothing waits for the user. */
export const canPrompt = (c: Conversation): boolean => c.status === "idle";

/** The text of a message's blocks, for copying and for tests. */
export const textOf = (blocks: Block[]): string =>
  blocks.map((b) => (b.type === "text" ? String(b.text) : "")).join("");
