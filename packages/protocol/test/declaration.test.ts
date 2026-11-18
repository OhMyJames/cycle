import { expect, test } from "bun:test";
import {
  type AgentCapabilities,
  type AgentDeclaration,
  OPERATIONS,
  declarationFromCapabilities,
  declares,
  gives,
} from "../src/index.ts";

const ALWAYS = [
  "session.fork",
  "session.rename",
  "session.archive",
  "session.compact",
  "session.rewind",
  "turn.steer",
  "turn.review",
] as const;

const codex: AgentCapabilities = {
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
};

const claude: AgentCapabilities = {
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

test("the operations are closed: no id twice, each an entity, a dot and a verb", () => {
  expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length);
  for (const id of OPERATIONS) expect(id).toMatch(/^[a-z]+\.[A-Za-z]+$/);
});

test("an operation is declared when its id is listed", () => {
  const declaration: AgentDeclaration = {
    operations: ["session.tag"],
    inputs: ["image"],
    extensions: {},
    account: "none",
  };
  expect(declares(declaration, "session.tag")).toBe(true);
  expect(declares(declaration, "session.fork")).toBe(false);
});

test("an edit grant gives read, a read grant does not give edit, and a kind left out gives neither", () => {
  const declaration: AgentDeclaration = {
    operations: [],
    inputs: [],
    extensions: { mcp: "edit", skills: "read" },
    account: "cli",
  };
  expect(gives(declaration, "mcp")).toBe(true);
  expect(gives(declaration, "mcp", "edit")).toBe(true);
  expect(gives(declaration, "skills")).toBe(true);
  expect(gives(declaration, "skills", "edit")).toBe(false);
  expect(gives(declaration, "plugins")).toBe(false);
  expect(gives(declaration, "plugins", "edit")).toBe(false);
});

test("codex's flags make the declaration it has always had", () => {
  expect(declarationFromCapabilities(codex, { stopTask: false, readContext: false })).toEqual({
    operations: [...ALWAYS, "settings.features"],
    inputs: ["image"],
    extensions: { mcp: "edit", plugins: "edit", skills: "read" },
    account: "cycle",
  });
});

test("Claude Code's flags, with a configuration kept, and the two methods that had none", () => {
  expect(declarationFromCapabilities(claude, { stopTask: true, readContext: true })).toEqual({
    operations: [
      ...ALWAYS,
      "session.tag",
      "session.rewindFiles",
      "session.context",
      "session.commands",
      "task.stop",
      "mcp.reconnect",
      "session.directories",
    ],
    inputs: ["image", "pdf", "text"],
    extensions: { mcp: "edit", plugins: "edit", skills: "edit", hooks: "edit", subagents: "read" },
    account: "cli",
  });
});

test("Claude Code's flags with none kept read its MCP servers and skills, and have no plugins or hooks", () => {
  const declaration = declarationFromCapabilities(
    { ...claude, connector: "read", hooks: false },
    { stopTask: true, readContext: true },
  );
  expect(declaration.extensions).toEqual({ mcp: "read", skills: "read", subagents: "read" });
  expect(declares(declaration, "session.tag")).toBe(true);
});
