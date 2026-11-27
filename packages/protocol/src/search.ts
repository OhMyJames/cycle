import { z } from "zod";
import { cycleMethod } from "./method.ts";

/** `_cycle/search` (docs/protocol.md §8 "搜索对话内容"): full-text search of the conversations one daemon keeps. */
export const SEARCH_LIMITS = { query: 200, defaultLimit: 20, maxLimit: 50 } as const;

export const SearchHitSchema = z.object({
  sessionId: z.string(),
  /** The seq of the record in the session's history, the same as `_meta["_cycle.seq"]` on its `session/update`. */
  seq: z.number().int().min(1),
  from: z.enum(["user", "agent"]),
  /** A piece of the text with the words in it. Never empty. */
  snippet: z.string().min(1),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const search = cycleMethod(
  "_cycle/search",
  z.object({
    query: z.string().min(1).max(SEARCH_LIMITS.query),
    limit: z.number().int().min(1).max(SEARCH_LIMITS.maxLimit).optional(),
  }),
  z.object({ hits: z.array(SearchHitSchema), truncated: z.boolean() }),
);
