/**
 * The slice of the `codex app-server` v2 protocol this harness consumes.
 * Hand-written and deliberately loose: unknown fields and item types must
 * not break us. Regenerate the full bindings for reference with
 * `codex app-server generate-ts --out <dir>`.
 */

export type CodexItem =
  | { type: "userMessage"; id: string; content: { type: string; text?: string }[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: "inProgress" | "completed" | "failed" | "declined";
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: { path: string; kind: { type: "add" | "delete" | "update" }; diff: string }[];
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | { type: string; id: string };

export interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string } | null;
}

export interface ThreadStartResponse {
  thread: { id: string; createdAt: number };
  model: string;
  cwd: string;
}

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: CodexItem;
}

export interface DeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TurnNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface ErrorNotification {
  threadId: string;
  turnId: string;
  willRetry: boolean;
  error: { message: string };
}

export interface ApprovalRequestParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}
