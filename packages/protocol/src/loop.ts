import { z } from "zod";

/**
 * The Loop server's methods, `projects/list` and `runs/list` (docs/protocol.md §17). The Loop server is its own
 * process, not the daemon, so its methods are not `_cycle/*`. A response never holds a token, a repository address
 * or a local path.
 */

export const LOOP_PROJECTS_LIST = "projects/list";
export const LOOP_RUNS_LIST = "runs/list";

export const LoopForgeSchema = z.enum(["github", "gitlab"]);
export type LoopForge = z.infer<typeof LoopForgeSchema>;

export const LoopProjectSchema = z.object({
  /** The name to show. */
  name: z.string().min(1),
  /** The itsaplan Project key, such as `CYC`; one per Loop server. */
  projectKey: z.string().min(1),
  repo: z.object({
    /** `owner/name`: no host, no scheme, no credentials. */
    displayName: z.string().min(1),
    forge: LoopForgeSchema,
  }),
});
export type LoopProject = z.infer<typeof LoopProjectSchema>;

export const LoopProjectsListResultSchema = z.object({ projects: z.array(LoopProjectSchema) });
export type LoopProjectsListResult = z.infer<typeof LoopProjectsListResultSchema>;

/**
 * Where a run is, in three words. `active` means the Loop has not finished or blocked it; it does not prove a
 * process is alive.
 */
export const LoopRunStateSchema = z.enum(["active", "blocked", "done"]);
export type LoopRunState = z.infer<typeof LoopRunStateSchema>;

export const LoopRunSchema = z.object({
  /** The work item key, such as `CYC-390`. */
  key: z.string().min(1),
  kind: z.enum(["dev", "research"]),
  state: LoopRunStateSchema,
  /** ISO times from the run record. */
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LoopRun = z.infer<typeof LoopRunSchema>;

export const LoopProjectRunsSchema = z.object({
  projectKey: z.string().min(1),
  runs: z.array(LoopRunSchema),
  /** True when some of the Project's run records could not be read: `runs` may be missing some. */
  unavailable: z.boolean(),
});
export type LoopProjectRuns = z.infer<typeof LoopProjectRunsSchema>;

export const LoopRunsListResultSchema = z.object({ projects: z.array(LoopProjectRunsSchema) });
export type LoopRunsListResult = z.infer<typeof LoopRunsListResultSchema>;
