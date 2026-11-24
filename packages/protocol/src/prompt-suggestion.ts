// What the person may say next, guessed by the agent once a turn has ended (docs/protocol.md §8, CYCL-225). A hint for
// the empty input box: it is never sent by itself, and the next turn makes it stale.
import { z } from "zod";

/** The `sessionUpdate` of a suggestion. Sent by the agent after the turn's end; kept and replayed like any other. */
export const PROMPT_SUGGESTION_UPDATE = "_cycle/prompt_suggestion";

/** One suggestion: a line the person could send next. */
export const PromptSuggestionUpdateSchema = z.object({
  sessionUpdate: z.literal(PROMPT_SUGGESTION_UPDATE),
  suggestion: z.string().trim().min(1),
});
export type PromptSuggestionUpdate = z.infer<typeof PromptSuggestionUpdateSchema>;
