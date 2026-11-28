// The forge the loop delivers to: pull requests, CI, merging and PR comments (CYC-477). `github.ts` is the one
// implementation, over `gh`. Results are structured: `ok` or an `error` text, so the caller can tell a network error
// (`isNetworkError`) from any other failure and keep its retry logic. A failure that is not a result is a `PortError`.

export type PortErrorKind = "timeout" | "failed" | "unparsable";

/** What a port throws when it cannot even report a result (for example a command that cannot be started). */
export class PortError extends Error {
  constructor(
    readonly kind: PortErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Where and how long a command runs. The credentials come from the port, not from the caller. */
export type At = { cwd: string; timeoutMs: number };

export type Failed = { ok: false; error: string };

export const DEFAULT_CI_CHECKS = ["check", "browser", "integration"] as const;

export type CiCheckStatus = "passed" | "failed" | "pending";

export type CiCheckItem = {
  name: string;
  status: CiCheckStatus;
  /** Raw state/conclusion from GitHub (e.g. "SUCCESS", "FAILURE", "IN_PROGRESS", "MISSING"). */
  rawState: string;
  detailsUrl: string | null;
};

export type CiStatus = {
  state: CiCheckStatus;
  headSha: string | null;
  checks: CiCheckItem[];
  failed: CiCheckItem[];
  pending: CiCheckItem[];
};

export type ReadCiStatusResult = { ok: true; status: CiStatus } | Failed;

export type PrState = "OPEN" | "CLOSED" | "MERGED";

export type ReadPrStateResult = { ok: true; state: PrState } | Failed;

export type PrMergeStatus = "merged" | "mergeable" | "conflicting" | "closed" | "unknown";

export type ReadPrMergeStatusResult = { ok: true; status: PrMergeStatus } | Failed;

export type ReadAutoMergeResult = { ok: true; enabled: boolean } | Failed;

/** An open pull request as the poller sees it. */
export type OpenPr = {
  number: number;
  headBranch: string;
  headSha: string;
  isDraft: boolean;
  /** The head is in a fork. */
  crossRepository: boolean;
  author: string;
};

export type OpenPrsResult = { ok: true; prs: OpenPr[] } | Failed;

export type PrHeadResult = { ok: true; sha: string; state: PrState } | Failed;

export type AuthorPermissionResult = { ok: true; permission: string } | Failed;

export interface Forge {
  /** The URL of the pull request for a branch. */
  prFor(at: At, branch: string): Promise<{ ok: true; url: string } | Failed>;
  createPr(
    at: At,
    input: { base: string; head: string; title: string; bodyPath: string },
  ): Promise<{ ok: true; url: string } | Failed>;
  /** `pr` is a URL or a branch name. */
  editPr(
    at: At,
    pr: string,
    input: { title: string; bodyPath: string },
  ): Promise<{ ok: true } | Failed>;
  prState(at: At, pr: string): Promise<ReadPrStateResult>;
  prMergeStatus(at: At, pr: string): Promise<ReadPrMergeStatusResult>;
  /** The required checks for the pull request's head; a head other than `headSha` reads as pending. */
  ciStatus(
    at: At,
    pr: string,
    headSha: string | undefined,
    required?: readonly string[],
  ): Promise<ReadCiStatusResult>;
  failedLogs(at: At, failed: readonly CiCheckItem[], maxLogChars?: number): Promise<string>;
  rerunFailed(
    at: At,
    failed: readonly CiCheckItem[],
    budget: { ciRound: number; maxCiRetries: number },
  ): Promise<{ ok: true; runIds: string[] } | Failed>;
  comment(at: At, pr: string, bodyPath: string): Promise<{ ok: true } | Failed>;
  /** Turns auto-merge (squash) on or off. */
  autoMerge(at: At, pr: string, on: boolean): Promise<{ ok: true } | Failed>;
  autoMergeOn(at: At, pr: string): Promise<ReadAutoMergeResult>;
  /** The paths the pull request changes. */
  changedPaths(at: At, pr: string): Promise<{ ok: true; paths: string[] } | Failed>;
  /** The open pull requests of the repository. */
  openPrs(at: At): Promise<OpenPrsResult>;
  /** The author's permission on the repository: admin, maintain, write, triage, read or none. */
  authorPermission(at: At, login: string): Promise<AuthorPermissionResult>;
  /** Squash-merges now (never auto-merge); GitHub refuses when the head is no longer `sha`. */
  mergeAt(at: At, pr: string, sha: string): Promise<{ ok: true } | Failed>;
  /** The pull request's current head commit and state. */
  prHead(at: At, pr: string): Promise<PrHeadResult>;
}
