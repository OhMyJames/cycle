import { expect, test } from "bun:test";
import type { AgentCapabilities } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import { type ClaudeConfig, emptyConfig } from "../src/config.ts";
import { FakeSdk } from "./fake-sdk.ts";

// What Claude Code says it can do, field by field, and which methods it has to do it.

/** A harness with Cycle's configuration in memory, or with none kept. */
function setup(withConfig: boolean) {
  let config: ClaudeConfig = emptyConfig();
  return new ClaudeHarness({
    sdk: new FakeSdk(),
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    schedule: () => () => {},
    ...(withConfig
      ? {
          config: {
            book: {
              read: () => config,
              write: async (next) => {
                config = next;
              },
            },
            dir: "/cycle/claude",
            writeSettings: async () => "/cycle/claude/settings.json",
            cli: { run: async () => ({ code: 0, stdout: "[]", stderr: "" }) },
          },
        }
      : {}),
  });
}

const given: AgentCapabilities = {
  attachments: ["image", "pdf", "text"],
  rewindFiles: true,
  commands: true,
  directories: true,
  connector: "edit",
  login: false,
  features: false,
  hooks: true,
  mcpReconnect: true,
  subagents: true,
  tags: true,
};

test("with Cycle's configuration it changes its connector and hooks", () => {
  expect(setup(true).capabilities).toEqual(given);
});

test("without it, its connector only reads and it has no hooks", () => {
  expect(setup(false).capabilities).toEqual({ ...given, connector: "read", hooks: false });
});

test("every ability it says it has is a method, and it is signed in by its command line", () => {
  const harness = setup(true);
  for (const method of [
    "tagSession",
    "rewindFiles",
    "listCommands",
    "readContext",
    "stopTask",
    "listSubagents",
    "reconnectMcpServer",
  ] as const) {
    expect(typeof harness[method], method).toBe("function");
  }
  expect(harness.capabilities.login).toBe(false);
  expect("login" in harness).toBe(false);
});
