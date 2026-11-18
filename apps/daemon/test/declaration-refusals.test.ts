import { expect, test } from "bun:test";
import type { AgentCapabilities, ModelInfo, Sessions } from "@cycle/protocol";
import { Harnesses, NotSupported } from "../src/index.ts";
import { FakeHarness } from "./fake-harness.ts";

// What each of an agent's abilities refuses today, and how: these pin the daemon's refusals, one
// test for each way a flag or a missing method says no, so a change of how they are told stays
// one on purpose.

const model = (id: string, harness: string): ModelInfo => ({
  id,
  harness,
  name: id,
  description: "",
  efforts: [],
  defaultEffort: null,
  isDefault: false,
  images: false,
  sandbox: false,
  provider: null,
});

const NOTHING: AgentCapabilities = {
  attachments: ["image"],
  rewindFiles: false,
  commands: false,
  directories: false,
  connector: "read",
  login: false,
  features: false,
  mcpReconnect: false,
  subagents: false,
  tags: false,
  hooks: false,
};

/** A main agent beside one with the flags a case needs and every optional method it may be refused. */
function setup(flags: Partial<AgentCapabilities> = {}) {
  const main = new FakeHarness("main");
  const other = new FakeHarness("other");
  main.models = [model("main-a", "main")];
  other.models = [model("other-a", "other")];
  other.capabilities = { ...NOTHING, ...flags };
  other.rewindFiles = async () => ({
    possible: true,
    error: null,
    files: [],
    insertions: 0,
    deletions: 0,
  });
  other.listCommands = async () => [];
  const optional = other as unknown as Sessions & {
    tagSession: Sessions["tagSession"];
    readContext: Sessions["readContext"];
    listSubagents: () => Promise<[]>;
    reconnectMcpServer: () => Promise<void>;
  };
  optional.tagSession = async () => {};
  optional.listSubagents = async () => [];
  optional.reconnectMcpServer = async () => {};
  const all = new Harnesses(main, [other]);
  return { main, other, optional, all };
}

const hooks = {
  hooks: [],
  run: { fallbackModel: null, maxTurns: null, maxBudgetUsd: null, promptSuggestions: false },
  ownerHooks: true,
  ownerSettings: true,
  revision: 0,
};

test("folders beyond a session's own are refused for an agent without directories, else made", async () => {
  const refused = setup();
  await expect(
    refused.all.createSession({ cwd: "/p", model: "other-a", directories: ["/q"] }),
  ).rejects.toThrow(
    "Reaching folders beyond the session's own is not supported for other in Cycle yet.",
  );
  await expect(
    refused.all.createSession({ cwd: "/p", model: "other-a", directories: ["/q"] }),
  ).rejects.toBeInstanceOf(NotSupported);
  expect((await refused.all.createSession({ cwd: "/p", model: "other-a" })).harness).toBe("other");
  const accepted = setup({ directories: true });
  const made = await accepted.all.createSession({
    cwd: "/p",
    model: "other-a",
    directories: ["/q"],
  });
  expect(made.harness).toBe("other");
});

test("tagging needs the tags flag and the method", async () => {
  const refused = setup();
  const theirs = await refused.all.createSession({ cwd: "/p", model: "other-a" });
  await expect(refused.all.tagSession(theirs.id, "x")).rejects.toThrow(
    "Tagging a session is not supported for other in Cycle yet.",
  );
  const flagged = setup({ tags: true });
  const tagged = await flagged.all.createSession({ cwd: "/p", model: "other-a" });
  await flagged.all.tagSession(tagged.id, "x");
  delete (flagged.optional as { tagSession?: unknown }).tagSession;
  await expect(flagged.all.tagSession(tagged.id, "x")).rejects.toBeInstanceOf(NotSupported);
});

test("putting files back and listing commands need their flag and their method", async () => {
  const refused = setup();
  const theirs = await refused.all.createSession({ cwd: "/p", model: "other-a" });
  await expect(refused.all.rewindFiles(theirs.id, "t1", false)).rejects.toThrow(
    "Putting files back is not supported for other in Cycle yet.",
  );
  await expect(refused.all.listCommands({ sessionId: theirs.id })).rejects.toThrow(
    "Listing commands is not supported for other in Cycle yet.",
  );
  const flagged = setup({ rewindFiles: true, commands: true });
  const ours = await flagged.all.createSession({ cwd: "/p", model: "other-a" });
  expect((await flagged.all.rewindFiles(ours.id, "t1", true)).possible).toBe(true);
  expect(await flagged.all.listCommands({ harness: "other", cwd: "/q" })).toEqual([]);
  delete flagged.other.rewindFiles;
  delete flagged.other.listCommands;
  await expect(flagged.all.rewindFiles(ours.id, "t1", true)).rejects.toBeInstanceOf(NotSupported);
  await expect(flagged.all.listCommands({ sessionId: ours.id })).rejects.toBeInstanceOf(
    NotSupported,
  );
});

test("a context an agent cannot read in parts answers null, not a refusal", async () => {
  const { optional, all } = setup();
  const theirs = await all.createSession({ cwd: "/p", model: "other-a" });
  expect(await all.readContext(theirs.id)).toBeNull();
  optional.readContext = async () => null;
  expect(await all.readContext(theirs.id)).toBeNull();
});

test("stopping a task goes to an agent that has it, else is a plain error, not a refusal", async () => {
  const { other, all } = setup();
  const theirs = await all.createSession({ cwd: "/p", model: "other-a" });
  await all.stopTask(theirs.id, "task-1");
  expect(other.calls).toEqual(["stop other-1 task-1"]);
  (other as { stopTask?: unknown }).stopTask = undefined;
  const error = await all.stopTask(theirs.id, "task-1").then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(NotSupported);
  expect((error as Error).message).toBe("Other has no tasks to stop alone.");
});

test("a connector that only reads lists skills and servers and signs in, and refuses the rest", async () => {
  const { all, other } = setup({ connector: "read" });
  const connector = all.connector("other");
  expect(await connector.listSkills("/p")).toEqual([]);
  expect(await connector.listMcpServers()).toEqual([]);
  expect(await connector.loginMcpServer("docs")).toEqual({ url: "" });
  const refused: [string, Promise<unknown>, string][] = [
    ["putMcpServer", connector.putMcpServer({} as never), "Changing the connector"],
    ["removeMcpServer", connector.removeMcpServer("x"), "Changing the connector"],
    ["enableMcpServer", connector.enableMcpServer("x", true), "Changing the connector"],
    ["enableMcpTool", connector.enableMcpTool("x", "t", true), "Changing the connector"],
    ["listPlugins", connector.listPlugins(), "Listing plugins"],
    ["readPlugin", connector.readPlugin("m", "p"), "Reading a plugin"],
    ["installPlugin", connector.installPlugin("m", "p"), "Changing the connector"],
    ["enablePlugin", connector.enablePlugin("p", true), "Changing the connector"],
    ["addMarketplace", connector.addMarketplace("m"), "Changing the connector"],
    ["readFeatures", connector.readFeatures(), "Reading features"],
    ["setFeatures", connector.setFeatures({ subagents: true }), "Changing the connector"],
    ["enableSkill", connector.enableSkill("s", true), "Changing the connector"],
    ["readHooks", connector.readHooks(), "Reading hooks"],
    ["setHooks", connector.setHooks(hooks), "Changing the connector"],
    [
      "listSubagents",
      connector.listSubagents?.("/p") ?? Promise.resolve(),
      "Listing helper agents",
    ],
    [
      "reconnectMcpServer",
      connector.reconnectMcpServer?.("x") ?? Promise.resolve(),
      "Reconnecting an MCP server",
    ],
  ];
  for (const [key, attempt, what] of refused) {
    await expect(attempt, key).rejects.toThrow(`${what} is not supported for other in Cycle yet.`);
  }
  expect(other.calls).toEqual([]);
});

test("a connector that can be changed does so, within hooks, features, subagents and reconnecting", async () => {
  const { all } = setup({ connector: "edit", hooks: true });
  const connector = all.connector("other");
  await connector.putMcpServer({ name: "docs" } as never);
  await connector.installPlugin("m", "p");
  await connector.enableSkill("s", true);
  expect((await connector.readHooks()).revision).toBe(0);
  await connector.setHooks(hooks);
  expect((await connector.listPlugins()).marketplaces).toEqual([]);
  await expect(connector.readFeatures()).rejects.toThrow("Reading features is not supported");
  await expect(connector.listSubagents?.("/p")).rejects.toThrow("Listing helper agents");
  await expect(connector.reconnectMcpServer?.("x")).rejects.toThrow("Reconnecting an MCP server");
});

test("hooks decide skills' being turned on, whatever the connector may change", async () => {
  const { all } = setup({ connector: "edit", hooks: false });
  const connector = all.connector("other");
  await connector.putMcpServer({ name: "docs" } as never);
  await expect(connector.enableSkill("s", true)).rejects.toThrow(
    "Changing the connector is not supported for other in Cycle yet.",
  );
  await expect(connector.readHooks()).rejects.toThrow("Reading hooks is not supported");
});

test("features, subagents and reconnecting are given by their own flags", async () => {
  const { all } = setup({ features: true, subagents: true, mcpReconnect: true });
  const connector = all.connector("other");
  expect((await connector.readFeatures()).subagents).toBe(true);
  await connector.setFeatures({ subagents: false });
  expect(await connector.listSubagents?.("/p")).toEqual([]);
  await connector.reconnectMcpServer?.("x");
});

test("the main agent's connector is the main agent itself, so its flags refuse nothing", () => {
  const { main, all } = setup();
  main.capabilities = { ...NOTHING };
  expect(all.connector()).toBe(main);
  expect(all.connector("main")).toBe(main);
  expect(all.account()).toBe(main);
});

test("another agent's account is read, and signing in, cancelling and signing out are refused", async () => {
  const { all, other } = setup({ login: true });
  const account = all.account("other");
  expect((await account.readAccount()).harness).toBe("other");
  await expect(account.login()).rejects.toThrow("Signing in is not supported for other in Cycle");
  await expect(account.cancelLogin("x")).rejects.toBeInstanceOf(NotSupported);
  await expect(account.logout()).rejects.toBeInstanceOf(NotSupported);
  expect(other.calls).toEqual([]);
});
