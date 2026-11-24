// What the agents keep in the homes the daemon gives them, and clearing the part that can be fetched again
// (docs/protocol.md §16 "本地存储"). Sizes and clearing are the daemon's machine's: a client shows them per location.
import { z } from "zod";
import { cycleMethod } from "./method.ts";

export const StorageItemSchema = z.object({
  /** Which one: a package cache (`bun-cache`, `npm-cache`, `npx-cache`, `library-caches`, `uv-cache`) or a history (`projects`, `sessions`). */
  id: z.string().min(1).max(64),
  /**
   * `cache`: fetched again when it is needed, so clearing it only costs a download. `history`: what a session's resume
   * reads. It is shown, never cleared.
   */
  kind: z.enum(["cache", "history"]),
  bytes: z.number().int().nonnegative(),
});
export type StorageItem = z.infer<typeof StorageItemSchema>;

export const StorageAgentSchema = z.object({
  agent: z.string().min(1).max(64),
  name: z.string().max(128),
  /**
   * False when the agent's home is not inside the daemon's data directory (the owner pointed it at a folder of their
   * own): nothing of it is measured or cleared, and `items` is empty.
   */
  managed: z.boolean(),
  items: z.array(StorageItemSchema).max(32),
});
export type StorageAgent = z.infer<typeof StorageAgentSchema>;

export const storageRead = cycleMethod(
  "_cycle/storage/read",
  z.object({}),
  z.object({ agents: z.array(StorageAgentSchema).max(32) }),
);

/** Why nothing was cleared. `busy`: a turn of that agent is running. `unmanaged`: its home is outside the data directory. `failed`: a cache could not be removed and nothing was. */
export const StorageCleanProblemSchema = z.enum(["busy", "unmanaged", "unknown_agent", "failed"]);
export type StorageCleanProblem = z.infer<typeof StorageCleanProblemSchema>;

export const storageClean = cycleMethod(
  "_cycle/storage/clean",
  z.object({ agent: z.string().min(1).max(64) }),
  z.union([
    z.object({ cleaned: z.literal(true), freedBytes: z.number().int().nonnegative() }),
    z.object({
      cleaned: z.literal(false),
      problem: StorageCleanProblemSchema,
      message: z.string().max(500),
    }),
  ]),
);
