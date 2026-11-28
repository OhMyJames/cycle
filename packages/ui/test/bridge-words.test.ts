import { expect, test } from "bun:test";
import { agentOf, KNOWN_AGENTS } from "@cycle/analytics/events";
import { AgentAuthFailureReasonSchema } from "@cycle/protocol";
import { agentWord } from "../src/agent-word.ts";
import { AGENT_AUTH_PROBLEM_REASONS } from "../src/api.ts";

test("the desktop bridge recognizes every protocol authentication failure reason", () => {
  for (const reason of AgentAuthFailureReasonSchema.options) {
    expect(AGENT_AUTH_PROBLEM_REASONS).toContain(reason);
  }
});

test("renderer telemetry matches the dictionary for known and arbitrary agent ids", () => {
  for (const id of [...KNOWN_AGENTS, "", "private agent", "constructor", "__proto__"]) {
    expect(agentWord(id)).toBe(agentOf(id));
  }
});
