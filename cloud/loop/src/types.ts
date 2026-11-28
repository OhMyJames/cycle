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
  /** The tracker's development links (PRs, MRs) as it sent them, for reading addresses out of; unset when absent. */
  development?: unknown;
  /** The parent's number and title, when the tracker said them (the planning node shows them; CYC-322). */
  parent?: { number: number; key: string; title: string };
  /** Links to other issues, when the tracker said them: `outward` is this issue blocking or relating to the other. */
  links?: { kind: string; direction: string; key: string; title: string }[];
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
  | "researchQa"
  /** The planning node shaping a Backlog work item (CYC-322); optional options, like research's. */
  | "plan"
  | "planQa";

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

/** A document linked to a work item (`list_issue_documents`), without its content. */
export type IssueDocument = {
  id: number;
  title: string;
  version: number;
  /** 已锁定: the convention for 已采纳 (CYC-328). */
  locked: boolean;
  archived: boolean;
};

/**
 * What the planning node (CYC-322) may do in the tracker, and nothing more: no column moves, no `auto`, no label but
 * its own two. Built from a `Tracker` by `planningTracker`, which binds the label ids, the Backlog column and the type
 * ids, so the planner has no id to pass.
 */
export interface PlanningTracker {
  get(number: number): Promise<Issue>;
  listBacklog(): Promise<Issue[]>;
  listTodo(): Promise<Issue[]>;
  listInProgress(): Promise<Issue[]>;
  listBacklogRows(): Promise<BacklogRow[]>;
  listComments(issue: Pick<Issue, "id" | "key">): Promise<IssueComment[]>;
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
  /** The 「完整流程」 label (CYC-328): a work item with it needs its Intent / Spec / Design / Plan documents. Null: the project has none. */
  fullFlowLabelId: number | null;
  /** Where a document's page lives, `<site>/<team>/<project>/docs`; a pull request links `<docsBase>/<documentId>`. Null: the project key has no team prefix, so no link can be made (CYC-454). */
  docsBase: string | null;
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
  /**
   * Pull requests a person opened (CYC-540), or null when the Project has not turned the review of them on (the
   * default). `maxReviewsPerPr` is how many commits of one pull request are reviewed before the loop stops.
   */
  prReview: { maxReviewsPerPr: number } | null;
  /** `owner/name` of the repository the pull requests are on; null when it is not known. */
  repoSlug: string | null;
};

export type PlanningConfig = {
  /** `fullProcess` is null when the project has no such label. */
  labels: { pending: number; awaitingAnswer: number; skip: number; fullProcess: number | null };
  backlogColumn: number;
  epicTypeId: number;
  templates: { feature: string; bug: string };
  /** No new round while this many work items wait for approval. */
  maxPending: number;
  /** Minutes between two rounds. */
  intervalMinutes: number;
  /** Most issues one work item is split into. */
  maxSplit: number;
  /** Minutes between two looks at the Backlog for a change, for the whole Project; `DEFAULT_CHECK_MINUTES` when left out. */
  checkMinutes?: number;
  /** Most work items one round asks a person about; `DEFAULT_MAX_ASK` when left out. The rest wait for a later round. */
  maxAsk?: number;
};

export const DEFAULT_CHECK_MINUTES = 5;
export const DEFAULT_MAX_ASK = 3;
/** Most questions on one work item: more means it is not ready to be asked about, only to be thought about. */
export const MAX_QUESTIONS = 2;

/**
 * A Backlog work item as one `list_issues` call returns it, without its body (CYC-322). `updatedAt` moves when the
 * title, body, labels, priority or column change; a new comment does not move it.
 */
export type BacklogRow = {
  id: number;
  key: string;
  number: number;
  title: string;
  typeId: number | null;
  labelIds: number[];
  columnId: number;
  updatedAt: string;
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
  maxCriteria: 12,
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
  fullFlowLabelId: null,
  docsBase: null,
  research: null,
  planning: null,
  prReview: null,
  repoSlug: null,
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
  | "shape_qa"
  | "graph_planner";

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
    /** Run key (`CYC-517`) or plan id (`plan-...`) for `_meta["cycle/origin"]` (CYC-534). */
    run?: string;
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
  /** Cancels an in-flight turn for `sessionId` when supported (CYC-484). */
  cancel?(sessionId: string): Promise<boolean>;
  /**
   * Whether the daemon has a new version of itself waiting to switch to once idle (docs/protocol.md §3, CYC-538). The
   * loop then takes no new work item, so the daemon gets to idle. False for a daemon that cannot say.
   */
  updatePending?(): Promise<boolean>;
}
