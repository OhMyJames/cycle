// The seams of the loop. Everything that touches the world (the tracker, the daemon, git, the shell, the clock) is
// behind one of these, so the pipeline's decisions can be tested with fakes (`bun test` must not reach out).

export type Priority = "urgent" | "high" | "medium" | "low";

export type Issue = {
  /** The tracker's internal id. */
  id: number;
  /** The number in `CYC-318`. */
  number: number;
  /** `CYC-318`. */
  key: string;
  title: string;
  description: string;
  priority: Priority | null;
  /** ISO time. */
  createdAt: string;
  columnId: number;
  labelIds: number[];
  /** Issue type id in the tracker (e.g. Feature, Bug, Epic), or null if unset. */
  typeId: number | null;
  /** Number of non-archived child issues, or null when the tracker reply omitted subtask info (fails closed). */
  subtaskCount: number | null;
};

/** Where the loop moves a work item. The tracker maps these to the project's columns. */
export type Stage = "todo" | "inProgress" | "inReview" | "blocked";

export interface Tracker {
  /** The work items in the `Todo` column. Choosing among them is `pickNext`'s job, not the tracker's. */
  listTodo(): Promise<Issue[]>;
  get(number: number): Promise<Issue>;
  move(issue: Issue, stage: Stage): Promise<void>;
  comment(issue: Issue, text: string): Promise<void>;
}

export type ExecResult = { code: number; output: string; timedOut: boolean };

export type Exec = (
  argv: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<ExecResult>;

export interface Clock {
  now(): Date;
}

export type Logger = (line: string) => void;

export type Config = {
  /** The repository the loop works on: the main checkout, where `git fetch` runs and worktrees are made. */
  repoRoot: string;
  /** Where run records, criteria, progress notes and the event log live. Never inside a worktree. */
  stateDir: string;
  remote: string;
  /** `origin/main`: what a worktree starts from and what the diff is taken against. */
  baseRef: string;
  /** The branch a pull request targets. */
  baseBranch: string;
  columns: { todo: number; inProgress: number; inReview: number; blocked: number };
  autoLabelId: number;
  /** Issue type ids the loop may take (e.g. Feature, Bug). Configured by id, never hardcoded or matched by name. */
  allowedTypeIds: number[];
  /** A work item with more criteria than this is too big for one session: it is sent back to be split. */
  maxCriteria: number;
  /** Fix rounds after the first Dev turn. */
  maxFixRounds: number;
  /** A turn that runs longer than this (not counting the time it waits for a person) is cancelled. */
  turnTimeoutMs: number;
  /** One verification command. */
  commandTimeoutMs: number;
  devAgent: string;
  qaAgent: string;
  /** Read and write nothing in the tracker or the repository: print what would happen. */
  dryRun: boolean;
};

export const defaultConfig = (partial: Pick<Config, "repoRoot" | "stateDir">): Config => ({
  remote: "origin",
  baseRef: "origin/main",
  baseBranch: "main",
  // infra.CYC (get_project, 2026-11-25).
  columns: { todo: 22, inProgress: 23, inReview: 34, blocked: 35 },
  autoLabelId: 11,
  // Feature (20), Bug (25).
  allowedTypeIds: [20, 25],
  maxCriteria: 8,
  maxFixRounds: 3,
  turnTimeoutMs: 30 * 60_000,
  commandTimeoutMs: 20 * 60_000,
  devAgent: "agy",
  qaAgent: "claude",
  dryRun: false,
  ...partial,
});

/** Parses a comma-separated list of positive integer issue type ids (e.g. `AUTO_LOOP_TYPE_IDS=20,25`). */
export const parseAllowedTypeIds = (raw: string): number[] => {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) throw new Error("AUTO_LOOP_TYPE_IDS must contain at least one type id.");
  return parts.map((part) => {
    const id = Number(part);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error(`invalid type id in AUTO_LOOP_TYPE_IDS: ${part}`);
    return id;
  });
};

export type SessionRole = "dev" | "qa";

export type TurnResult = {
  /** `end_turn` is the only one that is a finished turn; `cancelled`, `error`, `max_tokens`, `refusal` are not. */
  stopReason: string;
  /** What the agent said during the turn. */
  text: string;
  /** Cancelled because it ran past the limit (not counting the time it waited for a person). */
  timedOut: boolean;
};

/** The session cannot be continued (its agent has no record of it, or the daemon no longer has it). */
export class SessionLost extends Error {}

export interface Sessions {
  /**
   * A new session. With `worktree`, the daemon makes the worktree and runs the session in it; without, `cwd` is where
   * it runs. Returns the session and the worktree it is in.
   */
  create(input: {
    role: SessionRole;
    agent: string;
    title: string;
    cwd: string;
    worktree?: { base: string; name: string };
  }): Promise<{ sessionId: string; cwd: string; branch: string | null }>;
  /** One turn: send `prompt`, answer what the agent asks by the role's policy, return when it ends. */
  turn(
    sessionId: string,
    prompt: string,
    context: { role: SessionRole; worktree: string; timeoutMs: number },
  ): Promise<TurnResult>;
}
