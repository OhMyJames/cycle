import type { LoopBoardColumn, LoopTicket } from "../api.ts";

/** Priority names in the order they rank; a ticket with none (or an unknown one) ranks last. */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
export const priorityRank = (p: string | null): number => PRIORITY_RANK[p ?? ""] ?? 4;

const byPriority = (list: readonly LoopTicket[]): LoopTicket[] =>
  [...list].sort((x, y) => priorityRank(x.priority) - priorityRank(y.priority));

const STATE_ORDER: Record<string, number> = {
  started: 0,
  unstarted: 1,
  backlog: 2,
  completed: 4,
  canceled: 5,
};
// A state this board does not know sits with the open columns, after Backlog.
const stateOrder = (stateType: string): number => STATE_ORDER[stateType] ?? 3;

/** Columns left to right: started, unstarted, backlog, completed, canceled; the server's order within each. */
export const orderColumns = (columns: readonly LoopBoardColumn[]): LoopBoardColumn[] =>
  columns
    .map((column, index) => ({ column, index }))
    .sort(
      (a, b) =>
        stateOrder(a.column.stateType) - stateOrder(b.column.stateType) || a.index - b.index,
    )
    .map((x) => x.column);

/**
 * The ids of the columns that start folded: completed and canceled, and every unstarted column after the first
 * (by position, like `columnRoleOf`; names are each project's own).
 */
export const foldedByDefault = (columns: readonly LoopBoardColumn[]): ReadonlySet<number> => {
  const folded = new Set<number>();
  let unstarted = 0;
  for (const c of columns) {
    if (c.stateType === "completed" || c.stateType === "canceled") folded.add(c.id);
    else if (c.stateType === "unstarted" && unstarted++ > 0) folded.add(c.id);
  }
  return folded;
};

export type Progress = { done: number; total: number };

/**
 * `parent identifier -> done/total` over every column of the board: a child in a completed column is done, one in a
 * canceled column is not counted. Parents with nothing left to count are left out.
 */
export const parentProgress = (
  columns: readonly LoopBoardColumn[],
): ReadonlyMap<string, Progress> => {
  const map = new Map<string, Progress>();
  for (const c of columns) {
    if (c.stateType === "canceled") continue;
    for (const tk of c.tickets) {
      const parent = tk.parent?.identifier;
      if (parent === undefined) continue;
      const p = map.get(parent) ?? { done: 0, total: 0 };
      p.total += 1;
      if (c.stateType === "completed") p.done += 1;
      map.set(parent, p);
    }
  }
  return map;
};

/** The head of a group: an Epic that is itself in Backlog (`ticket`), or a parent that is elsewhere on the board. */
export type GroupHead = {
  identifier: string;
  title: string;
  /** The card, when the head is in Backlog; absent for a parent that is in another column. */
  ticket?: LoopTicket;
};

export type BacklogRow =
  | { kind: "card"; ticket: LoopTicket }
  | {
      kind: "group";
      /** The head's identifier. */
      key: string;
      head: GroupHead;
      /** The parent is not a card in Backlog. */
      elsewhere: boolean;
      children: LoopTicket[];
      progress: Progress | undefined;
    };

/**
 * The rows of the Backlog column, every ticket in exactly one place:
 * awaiting-approval cards first (never in a group), then Epic groups, then groups of children whose parent is
 * not in Backlog, then everything else. Priority orders groups (by head) and the cards inside them, stably.
 * A Backlog card is a group head when any ticket on the board names it as parent, whatever its type is called.
 */
export const backlogRows = (
  backlog: readonly LoopTicket[],
  allColumns: readonly LoopBoardColumn[],
): BacklogRow[] => {
  const progress = parentProgress(allColumns);
  const parents = new Set<string>();
  for (const c of allColumns) {
    for (const tk of c.tickets) if (tk.parent) parents.add(tk.parent.identifier);
  }
  const waiting = backlog.filter((t) => t.pending !== undefined);
  const rest = backlog.filter((t) => t.pending === undefined);
  const heads = byPriority(rest.filter((t) => parents.has(t.identifier)));
  const headIds = new Set(heads.map((t) => t.identifier));

  const epicChildren = new Map<string, LoopTicket[]>(heads.map((h) => [h.identifier, []]));
  const elsewhere = new Map<string, { head: GroupHead; children: LoopTicket[] }>();
  const loose: LoopTicket[] = [];
  for (const tk of byPriority(rest)) {
    if (headIds.has(tk.identifier)) continue; // a head stays a head, even when it has a parent itself
    const parent = tk.parent;
    if (parent && headIds.has(parent.identifier)) {
      epicChildren.get(parent.identifier)?.push(tk);
    } else if (parent) {
      const g = elsewhere.get(parent.identifier) ?? {
        head: { identifier: parent.identifier, title: parent.title },
        children: [],
      };
      g.children.push(tk);
      elsewhere.set(parent.identifier, g);
    } else {
      loose.push(tk);
    }
  }

  return [
    ...byPriority(waiting).map((ticket): BacklogRow => ({ kind: "card", ticket })),
    ...heads.map(
      (h): BacklogRow => ({
        kind: "group",
        key: h.identifier,
        head: { identifier: h.identifier, title: h.title, ticket: h },
        elsewhere: false,
        children: epicChildren.get(h.identifier) ?? [],
        progress: progress.get(h.identifier),
      }),
    ),
    ...[...elsewhere.values()].map(
      (g): BacklogRow => ({
        kind: "group",
        key: g.head.identifier,
        head: g.head,
        elsewhere: true,
        children: g.children,
        progress: progress.get(g.head.identifier),
      }),
    ),
    ...loose.map((ticket): BacklogRow => ({ kind: "card", ticket })),
  ];
};

/**
 * Keeps the rows a filter lets through. A group stays when its head or any child matches; a matching head keeps
 * all its children, otherwise only the matching ones stay. A head that is not in Backlog never matches itself.
 */
export const filterRows = (
  rows: readonly BacklogRow[],
  matches: (ticket: LoopTicket) => boolean,
): BacklogRow[] => {
  const out: BacklogRow[] = [];
  for (const row of rows) {
    if (row.kind === "card") {
      if (matches(row.ticket)) out.push(row);
      continue;
    }
    const headMatches = row.head.ticket !== undefined && matches(row.head.ticket);
    const children = headMatches ? row.children : row.children.filter(matches);
    if (headMatches || children.length > 0) out.push({ ...row, children });
  }
  return out;
};

/** The first `limit` rows and how many are left; a group is one row however many children it holds. */
export const pageRows = (
  rows: readonly BacklogRow[],
  limit: number,
): { shown: BacklogRow[]; hidden: number } => ({
  shown: rows.slice(0, limit),
  hidden: Math.max(0, rows.length - limit),
});
