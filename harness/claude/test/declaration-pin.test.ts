import { expect, test } from "bun:test";
import {
  type AgentCapabilities,
  type AgentDeclaration,
  declarationFromCapabilities,
  declares,
} from "@cycle/protocol";
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

/** The optional methods an agent has where its declaration says it does not, or the other way. */
function disagreements(agent: object, declaration: AgentDeclaration): string[] {
  const declared: Record<string, boolean> = {
    tagSession: declares(declaration, "session.tag"),
    rewindFiles: declares(declaration, "session.rewindFiles"),
    listCommands: declares(declaration, "session.commands"),
    readContext: declares(declaration, "session.context"),
    stopTask: declares(declaration, "task.stop"),
    reconnectMcpServer: declares(declaration, "mcp.reconnect"),
    listSubagents: declaration.extensions.subagents !== undefined,
  };
  return Object.keys(declared).filter(
    (method) => (typeof Reflect.get(agent, method) === "function") !== declared[method],
  );
}

const operations = [
  "session.fork",
  "session.rename",
  "session.archive",
  "session.compact",
  "session.rewind",
  "turn.steer",
  "turn.review",
  "session.tag",
  "session.rewindFiles",
  "session.context",
  "session.commands",
  "task.stop",
  "mcp.reconnect",
  "session.directories",
] as const;

test("with Cycle's configuration it declares every operation and edits all it is given", () => {
  const harness = setup(true);
  expect(harness.declaration).toEqual({
    operations: [...operations],
    inputs: ["image", "pdf", "text"],
    extensions: { mcp: "edit", plugins: "edit", skills: "edit", hooks: "edit", subagents: "read" },
    account: "cli",
  });
  expect(harness.declaration).toEqual(
    declarationFromCapabilities(harness.capabilities, { stopTask: true, readContext: true }),
  );
  expect(disagreements(harness, harness.declaration)).toEqual([]);
});

test("without it, it reads its MCP servers and skills, and has no plugins or hooks", () => {
  const harness = setup(false);
  expect(harness.declaration).toEqual({
    operations: [...operations],
    inputs: ["image", "pdf", "text"],
    extensions: { mcp: "read", skills: "read", subagents: "read" },
    account: "cli",
  });
  expect(harness.declaration).toEqual(
    declarationFromCapabilities(harness.capabilities, { stopTask: true, readContext: true }),
  );
  expect(disagreements(harness, harness.declaration)).toEqual([]);
});
