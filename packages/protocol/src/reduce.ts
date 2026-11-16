import {
  type Approval,
  type BackgroundTask,
  type Item,
  type ItemStatus,
  type Plan,
  type QueuedMessage,
  type SessionEvent,
  type SessionInfo,
  type Turn,
  type TurnOrigin,
  type Usage,
  taskLive,
} from "./model.ts";

/** Materialized view of a session's conversation: the fold of its event stream. */
export interface SessionState {
  info: SessionInfo;
  turns: Turn[];
  approvals: Approval[];
  plan: Plan | null;
  usage: Usage | null;
  queue: QueuedMessage[];
  /** Tasks running in the background now, whichever turn began them. */
  tasks: BackgroundTask[];
  notices: { level: "info" | "warning" | "error"; message: string }[];
  /** Number of the last frame folded in. */
  seq: number;
  /**
   * Names the run of frames `seq` counts in. A daemon that loads the session
   * again starts a new run from zero, so a number from an earlier run says
   * nothing about this one.
   */
  epoch: string;
}

export function initialSessionState(info: SessionInfo, epoch = ""): SessionState {
  return {
    info,
    turns: [],
    approvals: [],
    plan: null,
    usage: null,
    queue: [],
    tasks: [],
    notices: [],
    seq: 0,
    epoch,
  };
}

export function activeTurn(state: SessionState): Turn | null {
  const last = state.turns.at(-1);
  return last?.status === "running" ? last : null;
}

function appendDelta(item: Item, delta: string): Item {
  switch (item.kind) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
    case "plan":
      return { ...item, text: item.text + delta };
    case "command":
      return { ...item, output: item.output + delta };
    default:
      return item;
  }
}

function newTurn(id: string, startedAt: number | null, origin?: TurnOrigin): Turn {
  return {
    id,
    ...(origin && origin.kind !== "owner" ? { origin } : {}),
    status: "running",
    error: null,
    startedAt,
    durationMs: null,
    items: [],
    diff: null,
  };
}

/**
 * Ends what is still running among `items`: what `ended` chooses. A task outlives its turn, and
 * what it does is its own to end, so both are left as they are.
 */
export function endRunning(
  items: Item[],
  status: ItemStatus,
  ended: (item: Item) => boolean,
): Item[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.kind === "task" || !("status" in item) || item.status !== "running" || !ended(item)) {
      return item;
    }
    changed = true;
    return { ...item, status };
  });
  return changed ? next : items;
}

/** Puts an item in, and when it is a task that ended, ends what it left running. */
function putItem(items: Item[], item: Item): Item[] {
  const next = upsertItem(items, item);
  if (item.kind !== "task" || taskLive(item.status)) return next;
  return endRunning(next, item.status === "completed" ? "completed" : "failed", (each) => {
    return each.parentId === item.id;
  });
}

/**
 * Replaces one turn, found from the end because events nearly always concern
 * the latest. Every other turn keeps its identity, so a view of it need not
 * redraw. A turn that was never announced is created: histories can begin
 * mid-conversation.
 */
function withTurn(turns: Turn[], turnId: string, change: (turn: Turn) => Turn): Turn[] {
  let index = turns.length - 1;
  while (index >= 0 && turns[index]?.id !== turnId) index--;
  const next = turns.slice();
  if (index === -1) next.push(change(newTurn(turnId, null)));
  else next[index] = change(turns[index] as Turn);
  return next;
}

function upsertItem(items: Item[], item: Item): Item[] {
  let index = items.length - 1;
  while (index >= 0 && items[index]?.id !== item.id) index--;
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

function deltaItem(items: Item[], itemId: string, delta: string): Item[] {
  let index = items.length - 1;
  while (index >= 0 && items[index]?.id !== itemId) index--;
  const item = items[index];
  if (!item) return items;
  const next = items.slice();
  next[index] = appendDelta(item, delta);
  return next;
}

/**
 * Pure reducer shared by the daemon (to snapshot sessions for clients that
 * join late) and the UI (to draw live), so both always agree on state.
 * It does not touch `seq` or `info`: their owners do.
 */
export function reduceSession(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "turn.started": {
      if (state.turns.some((turn) => turn.id === event.turnId)) {
        return {
          ...state,
          turns: withTurn(state.turns, event.turnId, (turn) => ({ ...turn, status: "running" })),
        };
      }
      return {
        ...state,
        plan: null,
        turns: [...state.turns, newTurn(event.turnId, event.startedAt, event.origin)],
      };
    }
    case "item.started":
    case "item.completed":
      return {
        ...state,
        turns: withTurn(state.turns, event.turnId, (turn) => ({
          ...turn,
          items: putItem(turn.items, event.item),
        })),
      };
    case "item.delta":
      return {
        ...state,
        turns: withTurn(state.turns, event.turnId, (turn) => ({
          ...turn,
          items: deltaItem(turn.items, event.itemId, event.delta),
        })),
      };
    case "plan.updated":
      return { ...state, plan: event.plan };
    case "diff.updated":
      return {
        ...state,
        turns: withTurn(state.turns, event.turnId, (turn) => ({ ...turn, diff: event.diff })),
      };
    case "usage.updated":
      return { ...state, usage: event.usage };
    case "approval.requested":
      return {
        ...state,
        approvals: [
          ...state.approvals.filter((approval) => approval.id !== event.approval.id),
          event.approval,
        ],
      };
    case "approval.resolved":
      return {
        ...state,
        approvals: state.approvals.filter((approval) => approval.id !== event.approvalId),
      };
    case "queue.updated":
      return { ...state, queue: event.queue };
    case "turn.completed":
      return {
        ...state,
        approvals: [],
        turns: withTurn(state.turns, event.turnId, (turn) => ({
          ...turn,
          status: event.status,
          error: event.error,
          durationMs: event.durationMs,
          // An item still running when its turn ends will never finish, but for a task's.
          items: endRunning(
            turn.items,
            event.status === "completed" ? "completed" : "failed",
            (item) => item.parentId === undefined,
          ),
        })),
      };
    case "tasks.updated":
      return { ...state, tasks: event.tasks };
    case "turns.rewound": {
      const index = state.turns.findIndex((turn) => turn.id === event.turnId);
      if (index === -1) return state;
      // What the context held included the turns now gone: it is known again after the next one.
      return { ...state, turns: state.turns.slice(0, index), plan: null, usage: null };
    }
    case "notice":
      return {
        ...state,
        notices: [...state.notices.slice(-19), { level: event.level, message: event.message }],
      };
  }
}

/**
 * Merges a run of events into fewer: consecutive deltas to one item become
 * one delta. Folding the result gives the same state as folding the input.
 */
export function coalesceEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if (
      event.type === "item.delta" &&
      last?.type === "item.delta" &&
      last.itemId === event.itemId &&
      last.sessionId === event.sessionId
    ) {
      out[out.length - 1] = { ...last, delta: last.delta + event.delta };
    } else {
      out.push(event);
    }
  }
  return out;
}
