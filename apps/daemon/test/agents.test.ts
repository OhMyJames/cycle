import { expect, test } from "bun:test";
import type { ModelInfo } from "@cycle/protocol";
import { Harnesses, NotSupported } from "../src/index.ts";
import { FakeHarness } from "./fake-harness.ts";

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

/** A main agent that can change its connector, beside one that can only read and lists commands. */
function setup() {
  const main = new FakeHarness("main");
  const other = new FakeHarness("other");
  main.models = [model("main-a", "main")];
  other.models = [model("other-a", "other")];
  other.capabilities = {
    attachments: ["image", "pdf", "text"],
    rewindFiles: true,
    commands: true,
    directories: true,
    connector: "read",
    login: false,
    features: false,
  };
  const all = new Harnesses(main, [other]);
  return { main, other, all };
}

test("every agent is listed with what it can do, the main one first", () => {
  const { all, other } = setup();
  expect(all.harnesses().map((each) => each.name)).toEqual(["main", "other"]);
  expect(all.harnesses()[1]?.capabilities).toEqual(other.capabilities);
});

test("a connector and an account are each agent's own, the main one's when none is named", async () => {
  const { main, other, all } = setup();
  main.listMcpServers = async () => [
    { name: "main-server" } as Awaited<ReturnType<FakeHarness["listMcpServers"]>>[number],
  ];
  other.listMcpServers = async () => [
    { name: "other-server" } as Awaited<ReturnType<FakeHarness["listMcpServers"]>>[number],
  ];
  expect((await all.connector().listMcpServers()).map((server) => server.name)).toEqual([
    "main-server",
  ]);
  expect((await all.connector("other").listMcpServers()).map((server) => server.name)).toEqual([
    "other-server",
  ]);
  expect((await all.account("other").readAccount()).harness).toBe("other");
  expect((await all.account().readAccount()).harness).toBe("main");
  expect(() => all.connector("nobody")).toThrow("No agent named nobody");
});

test("what another agent cannot do is refused, never done by the main one in its place", async () => {
  const { main, all } = setup();
  const connector = all.connector("other");
  await expect(connector.putMcpServer({} as never)).rejects.toBeInstanceOf(NotSupported);
  await expect(connector.installPlugin("m", "p")).rejects.toThrow(
    "Changing the connector is not supported for other in Cycle yet.",
  );
  await expect(connector.listPlugins()).rejects.toBeInstanceOf(NotSupported);
  await expect(connector.readFeatures()).rejects.toBeInstanceOf(NotSupported);
  await expect(all.account("other").login()).rejects.toThrow("Signing in is not supported");
  await expect(all.account("other").logout()).rejects.toBeInstanceOf(NotSupported);
  expect(main.calls).toEqual([]);
});

test("putting files back and listing commands go to the session's agent, when it can", async () => {
  const { other, all } = setup();
  const theirs = await all.createSession({ cwd: "/p", model: "other-a" });
  const ours = await all.createSession({ cwd: "/p", model: "main-a" });
  let asked: string[] = [];
  other.rewindFiles = async (sessionId, turnId, dryRun) => {
    asked = [sessionId, turnId, String(dryRun)];
    return { possible: true, error: null, files: ["/p/a"], insertions: 1, deletions: 0 };
  };
  other.listCommands = async (sessionId) => [
    { name: `for ${sessionId}`, description: "", argumentHint: "", aliases: [], builtin: false },
  ];
  expect((await all.rewindFiles(theirs.id, "t1", true)).files).toEqual(["/p/a"]);
  expect(asked).toEqual([theirs.id, "t1", "true"]);
  expect(await all.listCommands({ sessionId: theirs.id })).toMatchObject([
    { name: `for ${theirs.id}` },
  ]);
  expect(await all.listCommands({ harness: "other" })).toMatchObject([{ name: "for null" }]);
  await expect(all.rewindFiles(ours.id, "t1", false)).rejects.toBeInstanceOf(NotSupported);
  await expect(all.listCommands({ harness: "main" })).rejects.toBeInstanceOf(NotSupported);
  expect((await all.capabilitiesOf(theirs.id)).connector).toBe("read");
  expect(await all.readContext(ours.id)).toBeNull();
});

test("a session reaches other folders only on an agent that can", async () => {
  const { all } = setup();
  const made = await all.createSession({ cwd: "/p", model: "other-a", directories: ["/q"] });
  expect(made.harness).toBe("other");
  await expect(
    all.createSession({ cwd: "/p", model: "main-a", directories: ["/q"] }),
  ).rejects.toBeInstanceOf(NotSupported);
});
