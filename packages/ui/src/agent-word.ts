// The renderer can use only types from the analytics dictionary. Exhaustiveness ties these
// local words to that dictionary without bundling its runtime schemas in the page.
import type { AgentWord } from "@cycle/analytics/events";

const known: { [Id in Exclude<AgentWord, "other">]: true } = {
  claude: true,
  codex: true,
  agy: true,
  pi: true,
};

export const agentWord = (id: string): AgentWord =>
  Object.hasOwn(known, id) ? (id as keyof typeof known) : "other";
