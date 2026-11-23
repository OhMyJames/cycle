// How a conversation is laid out: its items, cut into turns, as a column of blocks.
//
// A pure function of the conversation, so every rule here is tested without a page. The rules are taken from the earlier
// Cycle (old-cycle's `acp/blocks.ts`), minus what it needed because that daemon kept no log: here the log keeps how each
// turn ended, so a turn is read from the data (see `InTurn` in conversation.ts) and not guessed from the text.
//
// - What the user and the agent say, a plan and a notice are blocks of their own. They cut a turn into stretches.
// - The tool calls of one stretch share one block (the view draws a card for two or more, a bare row for one).
// - A call that starts a sub-agent is a block of its own, like a message: it cuts the stretch. So is a code review the
//   agent reported (CYCL-138).
// - In a turn that did not end normally, the failures of its last stretch are pulled out under it, because they may
//   be why it stopped. Elsewhere the agent dealt with them, and they stay in the card.
// - A thought is a block of its own, where its stretch's card is: it never cuts a stretch. Shown only in detailed mode
//   (`shownBlocks`).
// - A turn that did not end normally says how, last.
// - A turn begins a new group: the view puts more space before it than between blocks.
// - A turn that ended normally is read by its answer: the work before its last reply folds into one block
//   (`foldedBlocks`), opened on request. A turn that ended any other way stays open: how it got there is what to read.
import { type CommandLabel, commandLabel } from "./command-label.ts";
import type {
  AgentItem,
  CompactionItem,
  Conversation,
  Item,
  NoticeItem,
  PlanItem,
  StopReason,
  ThoughtItem,
  ToolItem,
  UserItem,
} from "./conversation.ts";
import { textOf } from "./conversation.ts";
import { isPendingReview, type Review, reviewOf } from "./review.ts";

export type Activity = "run" | "read" | "edit" | "search" | "list" | "fetch" | "other";

const BY_NAME: Record<string, Activity> = {
  Bash: "run",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "search",
};

const BY_KIND: Record<string, Activity> = {
  execute: "run",
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  search: "search",
  fetch: "fetch",
};

/** The command a call ran, when its input has one. */
export const commandOf = (tool: ToolItem): string | undefined => {
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command !== "" ? command : undefined;
};

/** What a tool call does, by its name (Claude's own) and else by the kind ACP gives it. */
const kindOf = (tool: ToolItem): Activity =>
  BY_NAME[tool.name ?? ""] ?? BY_KIND[tool.toolKind ?? ""] ?? "other";

/**
 * What a command call plainly does, from its command (`rg` searches, `cat` reads, `ls` lists), when it can be told.
 * Only for a call that runs a command (another tool's `command` field may be anything), and one the agent gave no
 * description of.
 */
export const commandLabelOf = (tool: ToolItem): CommandLabel | undefined => {
  if (kindOf(tool) !== "run") return undefined;
  // The agent said what it is for: the row says that, and the call stays a command, in its count and its mark too.
  const description = (tool.rawInput as Record<string, unknown> | undefined)?.description;
  if (typeof description === "string" && description.trim() !== "") return undefined;
  const command = commandOf(tool);
  return command === undefined ? undefined : commandLabel(command);
};

/**
 * What a call did; a command that only searches, reads or lists is counted as that, so a stretch of them says
 * "searched" or "read", not "ran".
 */
export const activityOf = (tool: ToolItem): Activity => commandLabelOf(tool)?.kind ?? kindOf(tool);

/** How much of each activity (calls, or a command's files or searches), in the order each first appeared. For a card's summary. */
export const activityCounts = (
  tools: readonly ToolItem[],
): { activity: Activity; count: number }[] => {
  const counts = new Map<Activity, number>();
  for (const tool of tools) {
    // A command that read three files read three, as three reads would have.
    const label = commandLabelOf(tool);
    const activity = label?.kind ?? kindOf(tool);
    const count = label?.count ?? 1;
    counts.set(activity, (counts.get(activity) ?? 0) + count);
  }
  return [...counts].map(([activity, count]) => ({ activity, count }));
};

/** Claude's tools that start a sub-agent: "Agent", and "Task" as it was called before. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** A call that started a sub-agent: its name says so from its start, or the sub-agent's own updates did. */
export const isSubagentCall = (tool: ToolItem): boolean =>
  tool.subagent !== undefined || SUBAGENT_TOOLS.has(tool.name ?? "");

const FINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** A tool call that has not ended. */
export const isLive = (tool: ToolItem): boolean => !FINAL.has(tool.status ?? "pending");

export type LaidBlock = { key: string; turn: number; startsTurn: boolean } & (
  | { kind: "user"; item: UserItem }
  | { kind: "agent"; item: AgentItem }
  | { kind: "thought"; item: ThoughtItem }
  | { kind: "plan"; item: PlanItem }
  | { kind: "notice"; item: NoticeItem }
  | { kind: "compaction"; item: CompactionItem }
  | { kind: "work"; tools: readonly ToolItem[] }
  /** A call that started a sub-agent (Claude's Agent tool): its own card. */
  | { kind: "subagent"; tool: ToolItem }
  /** A code review the agent reported (ReportFindings, or the code-review skill): its findings, on a card of their own. */
  | { kind: "review"; tool: ToolItem; review: Review }
  /** A failure pulled out from under the card of a turn that stopped. */
  | { kind: "failed"; tool: ToolItem }
  /** How a turn that did not end normally ended. */
  | { kind: "end"; stop: StopReason }
  /**
   * The work of a turn that ended normally, before its last reply: one line, opened on request. `ms` is how long it
   * worked before it answered, when both ends are known.
   */
  | { kind: "fold"; blocks: readonly LaidBlock[]; ms?: number }
);

/** What a block's kind is, apart from the fields every block has. */
type Body = LaidBlock extends infer B
  ? B extends LaidBlock
    ? Omit<B, "key" | "turn" | "startsTurn">
    : never
  : never;

const laidTurn = (
  turn: number,
  items: readonly Item[],
  stop: StopReason | undefined,
): LaidBlock[] => {
  const out: LaidBlock[] = [];
  const add = (key: string, body: Body): LaidBlock => {
    const block = { key, turn, startsTurn: false, ...body } as LaidBlock;
    out.push(block);
    return block;
  };
  let stretch: { key: string; tools: ToolItem[] } | undefined;
  for (const item of items) {
    switch (item.kind) {
      case "tool": {
        // The agent changing its plan (ACP's `think`: TodoWrite, TaskCreate, TaskUpdate): the plan says it, not a row per
        // call, from its start (so nothing shows and then goes). One that failed is shown; none cuts a stretch.
        // A sub-agent is work of its own, with its own answer: a card of its own, which cuts the stretch. Before the plan's
        // calls, so one an agent marks `think` is not left out with them.
        // A code review is what the agent found, not a step of its work: a card of its own, like what it says.
        const review = reviewOf(item);
        // One on its way whose input is not yet a review shows nothing, rather than a row that then turns into the card.
        if (isPendingReview(item)) break;
        if (review !== undefined) {
          stretch = undefined;
          add(`review:${item.id}`, { kind: "review", tool: item, review });
          break;
        }
        if (isSubagentCall(item)) {
          stretch = undefined;
          add(`subagent:${item.id}`, { kind: "subagent", tool: item });
          break;
        }
        if (item.toolKind === "think" && item.status !== "failed") break;
        if (stretch === undefined) {
          stretch = { key: `work:${item.id}`, tools: [] };
          add(stretch.key, { kind: "work", tools: stretch.tools });
        }
        stretch.tools.push(item);
        break;
      }
      case "thought":
        // Never cuts a stretch: a thought between two tool calls leaves them in one card.
        add(`thought:${item.id}`, { kind: "thought", item });
        break;
      case "notice":
        // The agent trying its request again is a state of the step line while it lasts, not a row; nor does it cut a stretch.
        if (item.retry !== undefined) break;
        stretch = undefined;
        add(`notice:${item.id}`, { kind: "notice", item });
        break;
      default:
        stretch = undefined;
        add(`${item.kind}:${item.id}`, { kind: item.kind, item } as Body);
    }
  }
  const stopped = stop !== undefined && stop.stopReason !== "end_turn";
  if (stopped) {
    // The last stretch, if nothing was said after it: what failed in it may be why the turn stopped.
    const last = out.findLast((block) => block.kind !== "thought");
    if (last?.kind === "work") {
      const failed = last.tools.filter((tool) => tool.status === "failed");
      if (failed.length > 0) {
        const at = out.indexOf(last);
        const rest = last.tools.filter((tool) => tool.status !== "failed");
        const pulled = failed.map(
          (tool): LaidBlock => ({
            key: `failed:${tool.id}`,
            turn,
            startsTurn: false,
            kind: "failed",
            tool,
          }),
        );
        const replaced: LaidBlock[] =
          rest.length > 0
            ? [{ ...last, key: last.key, tools: rest } as LaidBlock, ...pulled]
            : pulled;
        out.splice(at, 1, ...replaced);
      }
    }
    add(`end:${turn}`, { kind: "end", stop });
  }
  const first = out[0];
  if (first !== undefined) first.startsTurn = true;
  return out;
};

/** What laying out a turn depended on: if all of it is the same, so is the result, object for object. */
export type BlockCache = Map<
  number,
  {
    items: readonly Item[];
    stop: StopReason | undefined;
    blocks: LaidBlock[];
  }
>;

const same = (a: readonly Item[], b: readonly Item[]): boolean =>
  a.length === b.length && a.every((item, at) => item === b[at]);

/**
 * The blocks of a conversation, in order. With a `cache`, a turn that has not changed gives back the very blocks it gave
 * before, so a view that remembers its blocks by identity redraws only the turn that is going.
 */
export const blocksOf = (c: Conversation, cache?: BlockCache): LaidBlock[] => {
  const byTurn = new Map<number, Item[]>();
  for (const item of c.items) {
    const items = byTurn.get(item.turn);
    if (items === undefined) byTurn.set(item.turn, [item]);
    else items.push(item);
  }
  const result: LaidBlock[] = [];
  // Up to the turn that is going (its number is how many have ended). A turn that ended with nothing in it still says how.
  for (let turn = 0; turn <= c.stops.length; turn += 1) {
    const items = byTurn.get(turn) ?? [];
    const stop = c.stops[turn];
    if (items.length === 0 && stop === undefined) continue;
    const cached = cache?.get(turn);
    let blocks: LaidBlock[];
    if (cached !== undefined && cached.stop === stop && same(cached.items, items)) {
      blocks = cached.blocks;
    } else {
      blocks = laidTurn(turn, items, stop);
      cache?.set(turn, { items, stop, blocks });
    }
    result.push(...blocks);
  }
  return result;
};

/**
 * The blocks a session shows in its display mode: normal leaves the agent's thoughts out, detailed keeps those that have
 * words (one with none, not yet or not at all, has nothing to show). A turn that began with a thought left out begins at
 * its next block, so the space between turns stays. Blocks that are kept are the same objects, except one that now begins
 * its turn.
 */
export const shownBlocks = (
  blocks: readonly LaidBlock[],
  mode: "normal" | "detailed",
): LaidBlock[] => {
  const out: LaidBlock[] = [];
  let starts = false;
  for (const block of blocks) {
    const hidden =
      block.kind === "thought" && (mode === "normal" || textOf(block.item.blocks).trim() === "");
    if (hidden) {
      starts ||= block.startsTurn;
      continue;
    }
    if (starts && block.startsTurn) starts = false;
    out.push(starts && !block.startsTurn ? { ...block, startsTurn: true } : block);
    starts = false;
  }
  return out;
};

/** When a block began, when its item says: a stretch of work by its first call. */
const startOf = (block: LaidBlock): number | undefined =>
  "item" in block
    ? block.item.at
    : "tools" in block
      ? block.tools[0]?.at
      : "tool" in block
        ? block.tool.at
        : undefined;

const folded = (turn: readonly LaidBlock[]): LaidBlock[] => {
  const reply = turn.findLastIndex(
    (block) => block.kind === "agent" && textOf(block.item.blocks).trim() !== "",
  );
  if (reply === -1) return [...turn];
  const out: LaidBlock[] = [];
  let run: LaidBlock[] = [];
  let folds = 0;
  const close = (next: LaidBlock | undefined) => {
    const first = run[0];
    if (first === undefined) return;
    const from = out.at(-1);
    const began = from !== undefined ? startOf(from) : undefined;
    const answered = next !== undefined ? startOf(next) : undefined;
    // Under a second says nothing ("0 sec"): the line then says only that it worked.
    const ms =
      began !== undefined && answered !== undefined && answered - began >= 1000
        ? answered - began
        : undefined;
    out.push({
      // By its turn and place in it, not by its first block: that is a thought in detailed mode and not in normal, and a
      // fold must stay the same block (open, and the anchor of the reader's place) when the mode changes.
      key: `fold:${first.turn}:${folds++}`,
      turn: first.turn,
      startsTurn: first.startsTurn,
      kind: "fold",
      blocks: run.map((block) => (block.startsTurn ? { ...block, startsTurn: false } : block)),
      ...(ms !== undefined ? { ms } : {}),
    });
    run = [];
  };
  turn.forEach((block, at) => {
    // What the person said stays, a message put into the turn while it went included; and so does all after the reply.
    // So does a sub-agent still at work (sent to the background): its card is the one sign that something still runs.
    const running = block.kind === "subagent" && block.tool.subagent?.state === "running";
    if (at >= reply || block.kind === "user" || running) {
      close(block);
      out.push(block);
    } else run.push(block);
  });
  return out;
};

/** What folding a turn depended on: the same shown blocks and the same end give back the same blocks. */
export type FoldCache = Map<
  number,
  { from: readonly LaidBlock[]; stop: StopReason | undefined; blocks: LaidBlock[] }
>;

/**
 * The shown blocks with each turn that ended normally (`end_turn`) read by its answer: the runs of blocks before its last
 * reply that has words become one `fold` block each (what the person said is never folded, so a message put into the
 * turn while it went splits the work in two). A turn still going, one that ended any other way, and one with no reply
 * are left as they are. With a `cache`, a turn that has not changed gives back the very blocks it gave before.
 */
export const foldedBlocks = (
  blocks: readonly LaidBlock[],
  stops: readonly StopReason[],
  cache?: FoldCache,
): LaidBlock[] => {
  const out: LaidBlock[] = [];
  let at = 0;
  while (at < blocks.length) {
    const turn = blocks[at]?.turn ?? 0;
    let end = at;
    while (end < blocks.length && blocks[end]?.turn === turn) end += 1;
    const from = blocks.slice(at, end);
    at = end;
    const stop = stops[turn];
    if (stop?.stopReason !== "end_turn") {
      out.push(...from);
      continue;
    }
    const cached = cache?.get(turn);
    if (
      cached !== undefined &&
      cached.stop === stop &&
      cached.from.length === from.length &&
      cached.from.every((block, i) => block === from[i])
    ) {
      out.push(...cached.blocks);
      continue;
    }
    const laid = folded(from);
    cache?.set(turn, { from, stop, blocks: laid });
    out.push(...laid);
  }
  return out;
};

/** What the agent is doing now, for the line at the end of a turn that is going. */
export type Step =
  | { kind: "approval" }
  | { kind: "tool"; tool: ToolItem }
  | { kind: "thinking" }
  | { kind: "working" }
  /** The agent's model request failed and it is trying again by itself: nothing for the person to do. */
  | { kind: "retrying"; attempt?: number; maxRetries?: number };

/**
 * Nothing when the turn is over, or when the agent's own text is on its way: it is its own feedback. A thought on its way
 * says "Thinking…" here, whether its words are shown (detailed mode) or not: they are an aside, not a sign of life, and a
 * thought that has stopped arriving is still the agent at work until what comes next.
 */
export const stepOf = (c: Conversation): Step | undefined => {
  if (c.status === "idle") return undefined;
  if (c.status === "requires_action") return { kind: "approval" };
  const last = c.items.at(-1);
  if (last === undefined || last.turn !== c.turns) return { kind: "working" };
  switch (last.kind) {
    case "tool":
      return isLive(last) ? { kind: "tool", tool: last } : { kind: "working" };
    case "thought":
      return { kind: "thinking" };
    case "agent":
      return undefined;
    case "notice":
      return last.retry !== undefined ? { kind: "retrying", ...last.retry } : { kind: "working" };
    default:
      return { kind: "working" };
  }
};

/** How many blocks a long conversation shows at first, and how many more each time the person nears its top. */
export const PAGE = 60;

/**
 * Where the shown blocks begin. A long conversation shows only its end, and earlier blocks as the person scrolls toward
 * the top; the first block shown is named by its key (`anchor`), so new blocks at the end do not push the top off. With
 * no anchor, or one that is gone, the last `page` blocks.
 */
export const windowStart = (
  blocks: readonly LaidBlock[],
  anchor: string | undefined,
  page = PAGE,
): number => {
  if (anchor !== undefined) {
    const at = blocks.findIndex((block) => block.key === anchor);
    if (at >= 0) return at;
  }
  return Math.max(0, blocks.length - page);
};

/**
 * The key to anchor on once `page` more blocks are shown above `start`. A thought is not chosen (it is laid after the
 * card it sits in, so it is not where its stretch begins): the next block that is not one.
 */
export const earlierAnchor = (
  blocks: readonly LaidBlock[],
  start: number,
  page = PAGE,
): string | undefined =>
  blocks.slice(Math.max(0, start - page)).find((block) => block.kind !== "thought")?.key;
