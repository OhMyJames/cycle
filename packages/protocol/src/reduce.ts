import type { Approval, Item, SessionEvent, SessionInfo, TurnStatus } from "./model.ts";

/** Materialized view of a session; the fold of its event stream. */
export interface SessionState {
  info: SessionInfo;
  items: Item[];
  approvals: Approval[];
  activeTurnId: string | null;
  lastTurn: { status: TurnStatus; error?: string } | null;
}

export function initialSessionState(info: SessionInfo): SessionState {
  return { info, items: [], approvals: [], activeTurnId: null, lastTurn: null };
}

function appendDelta(item: Item, delta: string): Item {
  switch (item.kind) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
      return { ...item, text: item.text + delta };
    case "command":
      return { ...item, output: item.output + delta };
    default:
      return item;
  }
}

function upsert(items: Item[], item: Item): Item[] {
  const index = items.findIndex((i) => i.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

/**
 * Pure reducer shared by the daemon (to snapshot sessions for late-joining
 * clients) and the UI (to render live), so both always agree on state.
 */
export function reduceSession(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "turn.started":
      return { ...state, activeTurnId: event.turnId, lastTurn: null };
    case "item.started":
    case "item.completed":
      return { ...state, items: upsert(state.items, event.item) };
    case "item.delta":
      return {
        ...state,
        items: state.items.map((i) => (i.id === event.itemId ? appendDelta(i, event.delta) : i)),
      };
    case "approval.requested":
      return { ...state, approvals: [...state.approvals, event.approval] };
    case "approval.resolved":
      return { ...state, approvals: state.approvals.filter((a) => a.id !== event.approvalId) };
    case "turn.completed":
      return {
        ...state,
        activeTurnId: null,
        approvals: [],
        lastTurn: { status: event.status, error: event.error },
      };
    case "session.error":
      return { ...state, lastTurn: { status: "failed", error: event.message } };
  }
}
