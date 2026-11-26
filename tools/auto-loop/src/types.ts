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
  /** The parent issue's internal id, or null for a top-level issue. */
  parentId: number | null;
};

/** Where the loop moves a work item. The tracker maps these to the project's columns. */
export type Stage = "todo" | "inProgress" | "inReview" | "blocked" | "done";

export type LoopPhase =
  | "dev"
  | "verify"
  | "qa"
  | "ci"
  | "review"
  | "merge"
  | "research"
  | "researchQa";

/** A document in the project's tree (`list_documents`), without its content. */
export type DocumentEntry = { id: number; title: string; parentId: number | null };

/** An issue the loop creates. No labels: a person decides those. */
export type NewIssue = {
  typeId: number;
  title: string;
  description: string;
  columnId: number;
  /** The parent issue's internal id, or null for a top-level issue. */
  parentId: number | null;
  /** Left out by research, which leaves it to a person; the planner (CYC-322) sets one on the issues it splits off. */
  priority?: Priority;
};

/** A comment on an issue (`list_issue_activity`). */
export type IssueComment = {
  id: number;
  /** The comment it answers, or null for one at the top of a thread. */
  replyToId: number | null;
  authorId: string;
  authorName: string;
  body: string;
  /** ISO time. */
  createdAt: string;
};

export interface Tracker {
  /** The work items in the `Todo` column. Choosing among them is `pickNext`'s job, not the tracker's. */
  listTodo(): Promise<Issue[]>;
  get(number: number): Promise<Issue>;
  move(issue: Issue, stage: Stage): Promise<void>;
  comment(issue: Issue, text: string): Promise<void>;
  /**
   * Mirrors the loop's phase (and the time it began) onto the work item's custom fields; `null` clears both. A mirror
   * only: the run record is the truth. A tracker with no such fields does nothing.
   */
  setLoopPhase(issue: Issue, phase: LoopPhase | null, at: Date): Promise<void>;
  /** The project's active documents, without content. */
  listDocuments(): Promise<DocumentEntry[]>;
  /** A Markdown document under the document `parentId`. */
  createDocument(parentId: number, title: string, content: string): Promise<{ id: number }>;
  linkDocument(issue: Issue, docId: number): Promise<void>;
  /** Replaces the whole description. */
  setDescription(issue: Issue, description: string): Promise<void>;
  /** Returns the new issue's internal id and its number. */
  createIssue(input: NewIssue): Promise<{ id: number; number: number }>;
  /** A link from `from` to the issue whose internal id is `toId`. `blocks`: `from` blocks the other. */
  linkIssues(from: Issue, toId: number, kind: "relates" | "blocks"): Promise<void>;
  /** The work items in the Backlog column, read in full (CYC-322). */
  listBacklog(): Promise<Issue[]>;
  /** Every comment on the issue, replies included, oldest first. */
  listComments(issue: Issue): Promise<IssueComment[]>;
  setTitle(issue: Issue, title: string): Promise<void>;
  setType(issue: Issue, typeId: number): Promise<void>;
  setPriority(issue: Issue, priority: Priority | null): Promise<void>;
  /** Adds or removes one label and keeps the others as the tracker has them now, not as `issue` had them. */
  addLabel(issue: Issue, labelId: number): Promise<void>;
  removeLabel(issue: Issue, labelId: number): Promise<void>;
}

/**
 * What the planning node (CYC-322) may do in the tracker, and nothing more: no column moves, no `auto`, no label but
 * its own two. Built from a `Tracker` by `planningTracker`, which binds the label ids, the Backlog column and the type
 * ids, so the planner has no id to pass.
 */
export interface PlanningTracker {
  get(number: number): Promise<Issue>;
  listBacklog(): Promise<Issue[]>;
  listTodo(): Promise<Issue[]>;
  listComments(issue: Issue): Promise<IssueComment[]>;
  comment(issue: Issue, text: string): Promise<void>;
  setTitle(issue: Issue, title: string): Promise<void>;
  setDescription(issue: Issue, description: string): Promise<void>;
  /** The only type the planner sets on an existing issue: a work item split into children becomes their Epic. */
  makeEpic(issue: Issue): Promise<void>;
  setPriority(issue: Issue, priority: Priority): Promise<void>;
  /** A new Feature or Bug in the Backlog column. */
  createIssue(input: PlannedIssue): Promise<{ id: number; number: number }>;
  /** `from` blocks the issue whose internal id is `toId`. */
  linkBlocks(from: Issue, toId: number): Promise<void>;
  markPending(issue: Issue): Promise<void>;
  unmarkPending(issue: Issue): Promise<void>;
  markAwaitingAnswer(issue: Issue): Promise<void>;
  unmarkAwaitingAnswer(issue: Issue): Promise<void>;
}

/** An issue the planner splits off. Always in Backlog; its type is one of the two a work item can be. */
export type PlannedIssue = {
  kind: "Feature" | "Bug";
  title: string;
  description: string;
  /** The parent issue's internal id, or null for a top-level issue. */
  parentId: number | null;
  priority: Priority;
};

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
  /** Delete the worktree's `node_modules` while waiting for CI or the merge, and install again before Dev (CYC-450). Default off. */
  releaseNodeModules: boolean;
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
  /** A Blocked run waiting this many days gets one `blocked_stale` event; its worktree is kept. 0 turns it off (CYC-449). */
  blockedReminderDays: number;
  /** Times a GitHub command is run again after a network error, before the loop waits instead (CYC-444). */
  maxNetworkRetries: number;
  /** Waits before each of those retries; the last entry is reused if there are fewer entries than retries. */
  networkRetryDelaysMs: number[];
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
  /** Model and effort per role; not set means the agent's default. */
  devModel?: string;
  qaModel?: string;
  reviewModel?: string;
  devEffort?: string;
  qaEffort?: string;
  reviewEffort?: string;
  /** Read and write nothing in the tracker or the repository: print what would happen. */
  dryRun: boolean;
  /**
   * Research work items (CYC-447), or null when the Project has not turned them on. `backlogColumn` and `folderId`
   * are where follow-up drafts and the report go; `readRoots` is what the read-only sessions may read besides their
   * worktree.
   */
  research: {
    typeId: number;
    backlogColumn: number;
    folderId: number;
    readRoots: string[];
    maxFollowups: number;
  } | null;
  /**
   * The planning node (CYC-322), or null when the Project has not turned it on. Label, column and type ids are
   * resolved from the tracker at start; `templates` are the Feature and Bug issue templates' bodies, for the prompt.
   */
  planning: PlanningConfig | null;
};

export type PlanningConfig = {
  labels: { pending: number; awaitingAnswer: number; skip: number };
  backlogColumn: number;
  epicTypeId: number;
  templates: { feature: string; bug: string };
  /** No new round while this many work items wait for approval. */
  maxPending: number;
  /** Minutes between two rounds. */
  intervalMinutes: number;
  /** Most issues one work item is split into. */
  maxSplit: number;
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
  releaseNodeModules: false,
  maxCiRetries: 2,
  maxConflictRounds: 1,
  maxReviewRetries: 2,
  maxInterruptRetries: 3,
  maxQaRetries: 2,
  maxVerifyRetries: 1,
  blockedReminderDays: 7,
  maxNetworkRetries: 3,
  networkRetryDelaysMs: [10_000, 30_000, 60_000],
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
  research: null,
  planning: null,
  ...partial,
});

/** `triage`, `shape` and `shape_qa` are the planning node's sessions (CYC-322): read-only, like research. */
export type SessionRole =
  | "dev"
  | "qa"
  | "review"
  | "research"
  | "research_qa"
  | "triage"
  | "shape"
  | "shape_qa";

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
    model?: string;
    effort?: string;
    title: string;
    cwd: string;
    worktree?: { base: string; name: string };
  }): Promise<{ sessionId: string; cwd: string; branch: string | null }>;
  /**
   * One turn: send `prompt`, answer what the agent asks by the role's policy, return when it ends. `readRoots` are the
   * directories besides the worktree that a research role may read.
   */
  turn(
    sessionId: string,
    prompt: string,
    context: {
      run: string;
      role: SessionRole;
      worktree: string;
      timeoutMs: number;
      readRoots?: string[];
    },
  ): Promise<TurnResult>;
}
