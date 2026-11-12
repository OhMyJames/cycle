import type { ApprovalDecision, SessionEvent, SessionInfo } from "./model.ts";

export interface CreateSessionOptions {
  cwd?: string;
  model?: string;
}

/**
 * The contract every agent backend (`harness/*`) implements. The daemon only
 * depends on this interface, so adding another agent means adding another
 * `harness/<name>` package and nothing else.
 */
export interface Harness {
  readonly name: string;
  start(): Promise<void>;
  createSession(options?: CreateSessionOptions): Promise<SessionInfo>;
  /** Starts a turn. Progress arrives through `onEvent`. */
  sendMessage(sessionId: string, text: string): Promise<{ turnId: string }>;
  interrupt(sessionId: string): Promise<void>;
  respondApproval(approvalId: string, decision: ApprovalDecision): void;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  dispose(): Promise<void>;
}
