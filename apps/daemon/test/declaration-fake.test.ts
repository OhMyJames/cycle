import { expect, test } from "bun:test";
import { type AgentDeclaration, declarationFromCapabilities, declares } from "@cycle/protocol";
import { Harnesses } from "../src/index.ts";
import { FakeHarness } from "./fake-harness.ts";

// The fake is an agent too: what it declares and the optional methods it has must agree, as each
// real harness's do, so a test that gives it one and not the other fails here and not by chance.

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

test("the fake declares what its methods give, and what its flags say in operations", () => {
  const fake = new FakeHarness();
  expect(disagreements(fake, fake.declaration)).toEqual([]);
  expect(fake.declaration).toEqual(
    declarationFromCapabilities(fake.capabilities, { stopTask: true, readContext: false }),
  );
});

test("a method given and not declared, or declared and not given, is found", () => {
  const given = new FakeHarness();
  given.rewindFiles = async () => ({
    possible: true,
    error: null,
    files: [],
    insertions: 0,
    deletions: 0,
  });
  expect(disagreements(given, given.declaration)).toEqual(["rewindFiles"]);
  const declared = new FakeHarness();
  declared.declaration = {
    ...declared.declaration,
    operations: [...declared.declaration.operations, "session.commands"],
  };
  expect(disagreements(declared, declared.declaration)).toEqual(["listCommands"]);
});

test("the agents carry each one's declaration beside its flags, and a session's is its agent's", async () => {
  const main = new FakeHarness("main");
  const other = new FakeHarness("other");
  other.declaration = { ...other.declaration, account: "cli" };
  other.models = [
    {
      id: "other-a",
      harness: "other",
      name: "other-a",
      description: "",
      efforts: [],
      defaultEffort: null,
      isDefault: false,
      images: false,
      sandbox: false,
      provider: null,
    },
  ];
  const all = new Harnesses(main, [other]);
  expect(all.harnesses()).toEqual([
    { name: "main", capabilities: main.capabilities, declaration: main.declaration },
    { name: "other", capabilities: other.capabilities, declaration: other.declaration },
  ]);
  const session = await all.createSession({ cwd: "/p", model: "other-a" });
  expect(await all.declarationOf(session.id)).toBe(other.declaration);
});
