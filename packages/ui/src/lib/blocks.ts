import type { Item, Turn } from "@cycle/protocol";
import { type ActivityItem, activityStatus, isActivity } from "./activity.ts";

/**
 * How one turn is laid out, as a column of blocks. A pure function of the turn, so every rule here
 * can be tested without a page. The rules are old-cycle's:
 *
 * - What the user and the agent say, compactions, proposed plans, other agents, code reviews and what
 *   a hook added are blocks of their own. They cut a turn into stretches.
 * - The work of one stretch shares one card, where the first of it was. A stretch with only one piece
 *   of work shows it with no card around it.
 * - In a turn that stopped or failed, the failures of its last stretch are pulled out under the card,
 *   because they may be why it stopped. Elsewhere the agent dealt with them, and they stay in the card.
 * - A review's findings that the agent then says as its reply show once, as the reply.
 * - Thinking shows only when the owner asks for it, and never cuts a stretch.
 * - A turn that stopped or failed says so at its end.
 */
type Of<K extends Item["kind"]> = Extract<Item, { kind: K }>;

type Laid =
  | { kind: "user"; item: Of<"userMessage">; steeredAfter?: number }
  | { kind: "text"; item: Of<"agentMessage">; final: boolean }
  | { kind: "thought"; item: Of<"reasoning"> }
  | { kind: "plan"; item: Of<"plan"> }
  | { kind: "compaction"; item: Of<"compaction"> }
  | { kind: "agent"; item: Of<"agentCall"> }
  | { kind: "review"; item: Of<"review"> }
  | { kind: "note"; item: Of<"hook" | "agentActivity"> }
  | { kind: "activity"; items: readonly ActivityItem[] }
  | { kind: "single"; item: ActivityItem }
  | { kind: "failed"; item: ActivityItem }
  | { kind: "turnEnd"; status: "interrupted" | "failed"; error: string | null };

export type Block = Laid & {
  /** Stable while the block lasts: a stretch's is the same with one piece of work or many. */
  key: string;
  /** Space above it, in px. */
  gap: number;
};

export interface BlockOptions {
  showThinking: boolean;
}

/** Space above a block. A block with actions under it needs room for them, which float below it. */
export const GAP = { turn: 40, narrative: 16, card: 8, afterActions: 32 } as const;

type Keyed = Laid & { key: string };

const isStopped = (status: Turn["status"]): status is "interrupted" | "failed" =>
  status === "interrupted" || status === "failed";

function layOut(turn: Turn, options: BlockOptions): Keyed[] {
  const out: Keyed[] = [];
  const finalText =
    turn.status === "running"
      ? undefined
      : turn.items.findLast((item) => item.kind === "agentMessage" && item.text.trim() !== "")?.id;
  let segment: ActivityItem[] = [];
  /** Thoughts after a stretch's first piece of work, which go under its card rather than above it. */
  let later: Keyed[] = [];
  let opener = "start";
  let workSoFar = 0;
  let seenUser = false;
  const replies = new Set(
    turn.items.flatMap((item) => (item.kind === "agentMessage" ? [item.text.trim()] : [])),
  );

  const flush = (last: boolean): void => {
    if (segment.length === 0) return;
    const pulled =
      isStopped(turn.status) && last
        ? segment.filter((item) => activityStatus(item) === "failed")
        : [];
    const kept = segment.filter((item) => !pulled.includes(item));
    // One key whether it holds one piece of work or more, so a row keeps its state when a second joins.
    const key = `${turn.id}/after/${opener}`;
    const [only] = kept;
    if (kept.length === 1 && only) out.push({ kind: "single", key, item: only });
    else if (kept.length > 1) out.push({ kind: "activity", key, items: kept });
    out.push(...later);
    later = [];
    for (const item of pulled) out.push({ kind: "failed", key: item.id, item });
    segment = [];
  };
  const cut = (block: Laid, id: string): void => {
    flush(false);
    out.push({ ...block, key: id });
    opener = id;
  };

  for (const item of turn.items) {
    switch (item.kind) {
      case "userMessage":
        if (item.text.trim() === "" && item.images.length === 0) break;
        cut({ kind: "user", item, ...(seenUser ? { steeredAfter: workSoFar } : {}) }, item.id);
        seenUser = true;
        break;
      case "agentMessage":
        if (item.text.trim() === "") break;
        cut({ kind: "text", item, final: item.id === finalText }, item.id);
        break;
      case "reasoning":
        if (options.showThinking && item.text.trim() !== "") {
          const block: Keyed = { kind: "thought", key: item.id, item };
          if (segment.length === 0) out.push(block);
          else later.push(block);
        }
        break;
      case "plan":
        if (item.text.trim() !== "") cut({ kind: "plan", item }, item.id);
        break;
      case "compaction":
        cut({ kind: "compaction", item }, item.id);
        break;
      case "agentCall":
        workSoFar += 1;
        cut({ kind: "agent", item }, item.id);
        break;
      case "review":
        if (item.phase === "exited" && replies.has(item.text.trim())) break;
        cut({ kind: "review", item }, item.id);
        break;
      case "hook":
      case "agentActivity":
        cut({ kind: "note", item }, item.id);
        break;
      case "other":
        break;
      default:
        if (isActivity(item)) {
          workSoFar += 1;
          segment.push(item);
        }
    }
  }
  flush(true);
  // A turn that shows nothing still says why it failed.
  if (isStopped(turn.status) && (out.length > 0 || turn.error !== null)) {
    out.push({ kind: "turnEnd", key: `${turn.id}/end`, status: turn.status, error: turn.error });
  }
  return out;
}

const hasActions = (block: Laid | undefined): boolean =>
  block?.kind === "user" || (block?.kind === "text" && block.final);

const isWork = (block: Laid): boolean =>
  block.kind === "activity" || block.kind === "single" || block.kind === "failed";

function withGaps(blocks: readonly Keyed[]): Block[] {
  return blocks.map((block, index): Block => {
    const before = blocks[index - 1];
    if (!before) return { ...block, gap: 0 };
    const base = block.kind === "failed" && isWork(before) ? GAP.card : GAP.narrative;
    return { ...block, gap: hasActions(before) ? Math.max(base, GAP.afterActions) : base };
  });
}

/** Space below a turn's last block for what follows it, such as the conversation's tail. */
export function gapBelow(blocks: readonly Block[]): number {
  return hasActions(blocks.at(-1)) ? GAP.afterActions : GAP.narrative;
}

/**
 * What was laid out for each turn, by its object. The shared reducer keeps the identity of every
 * turn a streamed chunk does not touch, so a chunk lays out only its own turn.
 */
const cache = new WeakMap<Turn, { showThinking: boolean; blocks: Block[] }>();

export function blocksOf(turn: Turn, options: BlockOptions): Block[] {
  const kept = cache.get(turn);
  if (kept && kept.showThinking === options.showThinking) return kept.blocks;
  const blocks = withGaps(layOut(turn, options));
  cache.set(turn, { showThinking: options.showThinking, blocks });
  return blocks;
}
