// The workspace the loop works in: git, worktrees and dependency install (CYC-477). `git.ts` is the one
// implementation. Results are structured (`ok`, or an `error` that is the command's own output, so a network error
// can be told by `isNetworkError`); the loop's retry logic stays in the loop.

import type { At, Failed } from "./forge.ts";

/** A command's result for the places that need the exit code and the output as they are. */
export type Out = { code: number; output: string; timedOut: boolean };

export type Done = { ok: true } | Failed;

export type ConflictMarkers =
  | { kind: "clean" }
  | { kind: "found"; files: string[] }
  | { kind: "error"; output: string };

export type NodeModulesDirs =
  | { ok: true; dirs: string[] }
  | { ok: false; reason: "status_failed" | "dirty" | "list_failed" };

export type Removal = "removed" | "dirty" | "failed";

/** What `at.cwd` is: the worktree, unless a method says it is the main checkout. */
export interface Workspace {
  /** `git fetch <remote>` in `at.cwd`, one at a time per repository. */
  fetchMain(at: At): Promise<Out>;
  /** Pushes HEAD to `refs/heads/<branch>` on the remote. */
  push(at: At, branch: string): Promise<Out>;
  head(at: At): Promise<{ ok: true; sha: string } | Failed>;
  /** `<base>...HEAD`: the whole diff. */
  diff(at: At, base: string): Promise<string>;
  changedFiles(at: At, base: string): Promise<string[]>;
  /** `<base>..HEAD`, one line per commit. */
  log(at: At, base: string): Promise<string>;
  /** Subjects of the commits on the branch, oldest first, merges left out. */
  commitSubjects(at: At, base: string): Promise<string>;
  /** The commit and the changed files: two snapshots equal means nothing was written in between. */
  snapshot(at: At): Promise<string>;
  /** `git status --porcelain`. */
  status(at: At): Promise<{ ok: true; porcelain: string } | Failed>;
  /** Commits what is uncommitted, if anything is. */
  checkpoint(at: At, message: string): Promise<void>;
  mergeInProgress(at: At): Promise<boolean>;
  /** Merges the base into the branch without an editor. */
  mergeMain(at: At, base: string): Promise<Done>;
  abortMerge(at: At): Promise<Done>;
  resetHard(at: At, sha: string): Promise<Done>;
  /** Whether `ref` is in HEAD's history. */
  isAncestor(at: At, ref: string): Promise<boolean>;
  unmergedFiles(at: At): Promise<string[]>;
  /** Titles of the commits on the base, not in the branch before the merge, that touch the files. */
  theirCommits(at: At, preMergeSha: string, base: string, files: string[]): Promise<string[]>;
  conflictMarkers(at: At, files: string[]): Promise<ConflictMarkers>;
  stage(at: At, files: string[]): Promise<void>;
  commitMerge(at: At): Promise<Done>;
  /** Best effort: the files a merge of the base into HEAD would conflict on. */
  conflictProbe(at: At, base: string): Promise<string[]>;
  install(at: At, runKey?: string): Promise<Done>;
  /** The git-ignored `node_modules` of a clean worktree. */
  nodeModulesDirs(at: At): Promise<NodeModulesDirs>;
  /** Deletes those directories. */
  releaseNodeModules(at: At, dirs: string[]): Promise<Done>;
  /** Free space of the volume holding `at.cwd`, in 1 KiB blocks; undefined when it cannot be read. */
  freeKb(at: At): Promise<number | undefined>;
  /** Removes a worktree and its branches, without --force. `at.cwd` is the main checkout. */
  remove(at: At, worktree: string, branches: string[]): Promise<Removal>;
  /** Whether the git environment is clean. Fixed to ok for now. */
  configClean(at: At): Promise<Done>;
}
