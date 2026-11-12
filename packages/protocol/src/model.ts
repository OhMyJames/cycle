/**
 * Harness-agnostic domain model. Everything above `harness/*` (daemon, UI,
 * desktop) speaks only these types — never a specific agent's wire format.
 */

export type ItemStatus = "running" | "completed" | "failed" | "declined";

export type Item =
  | { id: string; kind: "userMessage"; text: string }
  | { id: string; kind: "agentMessage"; text: string }
  | { id: string; kind: "reasoning"; text: string }
  | {
      id: string;
      kind: "command";
      command: string;
      cwd: string;
      output: string;
      exitCode: number | null;
      status: ItemStatus;
    }
  | {
      id: string;
      kind: "fileChange";
      changes: { path: string; change: "add" | "delete" | "update"; diff: string }[];
      status: ItemStatus;
    }
  /** A harness item the protocol has no first-class shape for yet. */
  | { id: string; kind: "other"; type: string };

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface Approval {
  id: string;
  kind: "command" | "fileChange";
  itemId: string;
  command?: string;
  cwd?: string;
  reason?: string;
}

export type TurnStatus = "completed" | "interrupted" | "failed";

export interface SessionInfo {
  id: string;
  harness: string;
  cwd: string;
  model: string;
  createdAt: number;
}

export type SessionEvent =
  | { type: "turn.started"; sessionId: string; turnId: string }
  | { type: "item.started"; sessionId: string; turnId: string; item: Item }
  /** Appends text to an item: message/reasoning text, or command output. */
  | { type: "item.delta"; sessionId: string; turnId: string; itemId: string; delta: string }
  | { type: "item.completed"; sessionId: string; turnId: string; item: Item }
  | { type: "approval.requested"; sessionId: string; turnId: string; approval: Approval }
  | { type: "approval.resolved"; sessionId: string; approvalId: string }
  | {
      type: "turn.completed";
      sessionId: string;
      turnId: string;
      status: TurnStatus;
      error?: string;
    }
  | { type: "session.error"; sessionId: string; message: string };
