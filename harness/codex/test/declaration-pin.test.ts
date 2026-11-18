import { expect, test } from "bun:test";
import { CodexHarness } from "../src/index.ts";

// What codex says it can do, field by field, and which methods it leaves out. Making the harness
// starts no process: codex starts with its first request.

test("codex changes its connector and signs in through Cycle, and does little else beyond the core", () => {
  expect(new CodexHarness().capabilities).toEqual({
    attachments: ["image"],
    rewindFiles: false,
    commands: false,
    directories: false,
    connector: "edit",
    login: true,
    features: true,
    hooks: false,
    mcpReconnect: false,
    subagents: false,
    tags: false,
  });
});

test("it has none of the methods an agent may leave out", () => {
  const harness = new CodexHarness();
  for (const method of [
    "tagSession",
    "rewindFiles",
    "listCommands",
    "readContext",
    "stopTask",
    "listSubagents",
    "reconnectMcpServer",
  ] as const) {
    expect(harness[method as keyof typeof harness], method).toBeUndefined();
  }
});
