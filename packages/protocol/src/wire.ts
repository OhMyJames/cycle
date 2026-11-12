import type { ApprovalDecision, SessionEvent, SessionInfo } from "./model.ts";
import type { SessionState } from "./reduce.ts";

/**
 * Client <-> daemon wire protocol: JSON text frames over one WebSocket.
 * Requests are correlated by `id`; events are pushed unsolicited.
 */
export interface Methods {
  "daemon.info": { params: Record<string, never>; result: { version: string; harness: string } };
  "session.create": { params: { cwd?: string; model?: string }; result: SessionInfo };
  "session.list": { params: Record<string, never>; result: SessionInfo[] };
  /** Snapshot for (re)joining a session. Events after it apply on top. */
  "session.get": { params: { sessionId: string }; result: SessionState };
  "session.send": { params: { sessionId: string; text: string }; result: { turnId: string } };
  "session.interrupt": { params: { sessionId: string }; result: Record<string, never> };
  "approval.respond": {
    params: { approvalId: string; decision: ApprovalDecision };
    result: Record<string, never>;
  };
}

export type MethodName = keyof Methods;

export type ClientMessage = {
  [M in MethodName]: { id: number; method: M; params: Methods[M]["params"] };
}[MethodName];

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { event: SessionEvent };

export const DEFAULT_DAEMON_PORT = 4747;
export const WS_PATH = "/ws";
