// A session's worktree (docs/protocol.md §6 "Worktree"): where its work is done, apart from the main checkout.
import { z } from "zod";

/** In `session/new` `_meta["cycle/worktree"]`: make a worktree and run the session in it. */
export const WorktreeRequestSchema = z.object({
  /** A local branch (or the remote's default, `origin/<name>`) to start from; the remote's default when absent. No fetch. */
  base: z.string().min(1).max(256).optional(),
  /** Up to 64 characters of letters, digits, ".", "_" and "-", in parts separated by "/"; made up when absent. */
  name: z.string().min(1).max(64).optional(),
});
export type WorktreeRequest = z.infer<typeof WorktreeRequestSchema>;

/** In a `session/list` row `_meta["cycle/worktree"]`: the worktree the session is in now. */
export const WorktreeSummarySchema = z.object({
  /** The main checkout it belongs to: the workspace the session is listed under. */
  root: z.string(),
  path: z.string(),
  branch: z.string().optional(),
  /** True when Cycle made it (its setup ran, its cleanup runs before it is removed). */
  managed: z.boolean(),
  /** What setup said when it failed, for the person to read; absent when it did not run or went well. */
  setupFailed: z.string().optional(),
});
export type WorktreeSummary = z.infer<typeof WorktreeSummarySchema>;

/** Why a worktree request or removal was refused (`data.reason` of the `-32602` error). */
export const WORKTREE_REASONS = [
  "not_a_repository",
  "invalid_name",
  "invalid_base",
  "not_a_worktree",
  "unsaved_changes",
] as const;
export type WorktreeReason = (typeof WORKTREE_REASONS)[number];
