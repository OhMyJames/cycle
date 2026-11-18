import { expect, test } from "bun:test";
import { type AgentDeclaration, declarationFromCapabilities, declares } from "@cycle/protocol";
import { CodexHarness } from "../src/index.ts";

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

test("what it declares is the old flags in operations, and each method is there exactly when declared", () => {
  const harness = new CodexHarness();
  expect(harness.declaration).toEqual({
    operations: [
      "session.fork",
      "session.rename",
      "session.archive",
      "session.compact",
      "session.rewind",
      "turn.steer",
      "turn.review",
      "settings.features",
    ],
    inputs: ["image"],
    extensions: { mcp: "edit", plugins: "edit", skills: "read" },
    account: "cycle",
  });
  expect(harness.declaration).toEqual(
    declarationFromCapabilities(harness.capabilities, { stopTask: false, readContext: false }),
  );
  expect(disagreements(harness, harness.declaration)).toEqual([]);
});
