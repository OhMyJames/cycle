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
  /**
   * The columns of the issues that block this one (`blocks` links, direction `inward`), or null when the tracker reply
   * omitted `links` (fails closed). A blocker whose column is unknown is `-1`, which is never Done or Canceled.
   */
  blockerColumnIds: number[] | null;
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
  columns: {
    todo: number;
    inProgress: number;
    inReview: number;
    blocked: number;
    done: number;
    canceled: number;
  };
  autoLabelId: number;
  /** Issue type ids the loop may take (e.g. Feature, Bug). Configured by id, never hardcoded or matched by name. */
  allowedTypeIds: number[];
  /** The tracker's Feature and Bug type ids: which required sections the preflight checks for. */
  featureTypeId: number;
  bugTypeId: number;
  /** A work item with more criteria than this is too big for one session: it is sent back to be split. */
  maxCriteria: number;
  /** Fix rounds after the first Dev turn. */
  maxFixRounds: number;
  /** Required CI check names on the pull request before the work item is considered delivered. */
  ciChecks: string[];
  /** Maximum number of times a red CI run is sent back to Dev before blocking. */
  maxCiRetries: number;
  /** Times the loop merges the base into the branch itself after a conflict found while waiting for CI. Not in the config file. */
  maxConflictRounds: number;
  /** Maximum number of retries when PR review fails, times out, or produces no valid conclusion. */
  maxReviewRetries: number;
  /** Maximum number of times one turn is sent again, in the same session, after the daemon stopped in the middle of it. */
  maxInterruptRetries: number;
  /** Maximum number of fresh QA sessions tried after an unreadable verdict, a missing checklist, a timeout or an abnormal end. */
  maxQaRetries: number;
  /** Maximum number of times a failed (not timed-out) verify command is re-run in place before the failure counts as a fix round. */
  maxVerifyRetries: number;
  /** How often to poll GitHub CI status while waiting for checks to finish. */
  ciPollIntervalMs: number;
  /** Maximum time to wait for a single CI run to finish before blocking. */
  ciTimeoutMs: number;
  /** How often to poll the pull request after auto-merge is enabled, to see it merge. */
  mergePollIntervalMs: number;
  /** Maximum time to wait for an auto-merge-enabled pull request to merge before blocking. */
  mergeTimeoutMs: number;
  /** A turn that runs longer than this (not counting the time it waits for a person) is cancelled. */
  turnTimeoutMs: number;
  /** One verification command. */
  commandTimeoutMs: number;
  devAgent: string;
  qaAgent: string;
  reviewAgent: string;
  /** Read and write nothing in the tracker or the repository: print what would happen. */
  dryRun: boolean;
};

/** Everything that is not per Project. `columns`, labels and type ids come from `resolveProject`, paths from the config file. */
export const defaultConfig = (
  partial: Pick<
    Config,
    | "repoRoot"
    | "stateDir"
    | "columns"
    | "autoLabelId"
    | "allowedTypeIds"
    | "featureTypeId"
    | "bugTypeId"
  >,
): Config => ({
  remote: "origin",
  baseRef: "origin/main",
  baseBranch: "main",
  maxCriteria: 8,
  maxFixRounds: 3,
  ciChecks: ["check", "browser", "integration"],
  maxCiRetries: 2,
  maxConflictRounds: 1,
  maxReviewRetries: 2,
  maxInterruptRetries: 3,
  maxQaRetries: 2,
  maxVerifyRetries: 1,
  ciPollIntervalMs: 30_000,
  ciTimeoutMs: 30 * 60_000,
  mergePollIntervalMs: 30_000,
  mergeTimeoutMs: 10 * 60_000,
  turnTimeoutMs: 30 * 60_000,
  commandTimeoutMs: 20 * 60_000,
  devAgent: "claude",
  qaAgent: "claude",
  reviewAgent: "claude",
  dryRun: false,
  ...partial,
});

export type SessionRole = "dev" | "qa" | "review";

export type TurnResult = {
  /** `end_turn` is the only one that is a finished turn; `cancelled`, `error`, `max_tokens`, `refusal` are not. */
  stopReason: string;
  /** What the agent said during the turn. */
  text: string;
  /** Cancelled because it ran past the limit (not counting the time it waited for a person). */
  timedOut: boolean;
  /** The turn ended because the daemon stopped (`error.code` is `DaemonStopped`), not because the agent failed. */
  interrupted?: boolean;
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
