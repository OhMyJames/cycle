// A daemon's own updates (docs/protocol.md §3 "daemon 自更新的状态", CYC-538): whether it updates itself from the release
// channel, and the version it has ready to switch to once nothing is working.
import { z } from "zod";
import { cycleMethod } from "./method.ts";

export const DaemonUpdateStateSchema = z.object({
  /** This daemon's version. */
  version: z.string(),
  /** "on": it looks for new versions and switches when idle. "off": from source, inside an app bundle, or turned off. */
  updates: z.enum(["on", "off"]),
  /** Downloaded and checked, waiting for the daemon to be idle. */
  pending: z
    .object({
      version: z.string(),
      /** "waiting": looking for a quiet moment. "draining": no new turns start; new prompts queue (CYC-547). */
      state: z.enum(["waiting", "draining"]).optional(),
      /** When it entered `state`, ISO 8601 UTC. */
      since: z.string().optional(),
      /** While draining: when the daemon will switch whatever is still running. */
      forceAt: z.string().optional(),
    })
    .optional(),
});
export type DaemonUpdateState = z.infer<typeof DaemonUpdateStateSchema>;

export const daemonUpdateRead = cycleMethod(
  "_cycle/daemon/update/read",
  z.object({}),
  DaemonUpdateStateSchema,
);
