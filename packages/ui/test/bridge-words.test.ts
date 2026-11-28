import { expect, test } from "bun:test";
import { agentOf, KNOWN_AGENTS } from "@cycle/analytics/events";
import { agentWord } from "../src/agent-word.ts";

test("renderer telemetry matches the dictionary for known and arbitrary agent ids", () => {
  for (const id of [...KNOWN_AGENTS, "", "private agent", "constructor", "__proto__"]) {
    expect(agentWord(id)).toBe(agentOf(id));
  }
});
