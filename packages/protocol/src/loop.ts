import { z } from "zod";

/**
 * The Loop server's one method so far (docs/protocol.md §17). The Loop server is its own process, not the daemon, so
 * its methods are not `_cycle/*`. A response never holds a token, a repository address or a local path.
 */

export const LOOP_PROJECTS_LIST = "projects/list";

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
