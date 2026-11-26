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
});
export type LoopProjectRuns = z.infer<typeof LoopProjectRunsSchema>;

export const LoopRunsListResultSchema = z.object({ projects: z.array(LoopProjectRunsSchema) });
export type LoopRunsListResult = z.infer<typeof LoopRunsListResultSchema>;

export const LOOP_EVENTS_LIST = "events/list";

/**
 * One thing that happened in a Project's loop (docs/protocol.md §17). `seq` is the event's line number in
 * `events.jsonl`, starting at 1. Only these four fields are sent: the rest of a line may hold paths or addresses.
 */
export const LoopEventSchema = z.object({
  seq: z.number().int().min(1),
  ts: z.string().min(1),
  /** The work item key, or `plan-<round>` for a planning round. */
  run: z.string().min(1),
  kind: z.string().min(1),
});
export type LoopEvent = z.infer<typeof LoopEventSchema>;

export const LoopEventsListParamsSchema = z.object({
  projectKey: z.string().min(1),
  /** The last `seq` the client has; only larger ones come back. 0 (the default) means from the start. */
  afterSeq: z.number().int().min(0).default(0),
  /** At most this many events (default 500, at most 1000). */
  limit: z.number().int().min(1).max(1000).default(500),
});
export type LoopEventsListParams = z.input<typeof LoopEventsListParamsSchema>;

export const LoopEventsListResultSchema = z.object({
  projectKey: z.string().min(1),
  events: z.array(LoopEventSchema),
  /** The `seq` to send next time: the last event returned, or `afterSeq` when none was. */
  lastSeq: z.number().int().min(0),
  /** More events are already there; ask again at once with `lastSeq`. */
  hasMore: z.boolean(),
});
export type LoopEventsListResult = z.infer<typeof LoopEventsListResultSchema>;
