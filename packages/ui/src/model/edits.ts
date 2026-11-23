// What the agent changed in a session with its file tools, turn by turn (CYCL-95): the Diff tab's "This session" view.
// Read from the calls' own `diff` content, which is all the log keeps of an edit: a change made by a command (sed, a
// formatter) is not here, and the view says so (.agents/notes/2026-11-22-files-and-diff-sources.md).
import type { Conversation, ToolItem } from "./conversation.ts";
import { textOf } from "./conversation.ts";
import { type DiffLine, type ToolFacts, toolFacts } from "./facts.ts";

export type SessionEdit = {
  /** The call that made it: what "Show in conversation" goes back to. */
  toolId: string;
  /** The file, as the agent named it (absolute, for Claude); undefined when it named none. */
  path: string | undefined;
  created: boolean;
  additions: number;
  deletions: number;
  /** Absent when the agent sent only the counts (a very large file). */
  lines?: DiffLine[];
  /** Held for review instead of written. */
  staged: boolean;
};

export type TurnEdits = {
  turn: number;
  /** What the person asked in that turn, as words. */
  prompt: string | undefined;
  edits: SessionEdit[];
  additions: number;
  deletions: number;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The file an edit changed: the path its `diff` names, else the first place the call gave. */
export const editPathOf = (tool: ToolItem): string | undefined => {
  const diff = tool.content.find((block) => block.type === "diff");
  const changes = diff !== undefined && Array.isArray(diff.changes) ? diff.changes : [];
  for (const change of changes)
    if (isObject(change) && typeof change.path === "string" && change.path !== "")
      return change.path;
  const where = tool.locations?.[0]?.path;
  return typeof where === "string" && where !== "" ? where : undefined;
};

/**
 * What each finished call amounts to, kept while the call is: a conversation that grows makes new items only for what
 * changed, so a patch is read once, not again with every chunk that streams in.
 */
const factsOf = new WeakMap<ToolItem, ToolFacts>();
const factsFor = (tool: ToolItem): ToolFacts => {
  const known = factsOf.get(tool);
  if (known !== undefined) return known;
  const facts = toolFacts(tool);
  factsOf.set(tool, facts);
  return facts;
};

/** The edits of a session, by turn, the latest turn first and each turn's edits in the order they were made. */
export const sessionEdits = (conversation: Conversation): TurnEdits[] => {
  const turns = new Map<number, TurnEdits>();
  const prompts = new Map<number, string>();
  for (const item of conversation.items) {
    if (item.kind === "user" && !prompts.has(item.turn)) {
      const words = textOf(item.blocks).trim();
      if (words !== "") prompts.set(item.turn, words);
    }
    if (item.kind !== "tool" || item.status !== "completed") continue;
    const edit = factsFor(item).edit;
    if (edit === undefined) continue;
    const turn = turns.get(item.turn) ?? {
      turn: item.turn,
      prompt: undefined,
      edits: [],
      additions: 0,
      deletions: 0,
    };
    turn.edits.push({
      toolId: item.id,
      path: editPathOf(item),
      created: edit.created,
      additions: edit.additions,
      deletions: edit.deletions,
      ...(edit.lines !== undefined ? { lines: edit.lines } : {}),
      staged: edit.staged,
    });
    turn.additions += edit.additions;
    turn.deletions += edit.deletions;
    turns.set(item.turn, turn);
  }
  return [...turns.values()]
    .map((turn) => ({ ...turn, prompt: prompts.get(turn.turn) }))
    .sort((a, b) => b.turn - a.turn);
};
