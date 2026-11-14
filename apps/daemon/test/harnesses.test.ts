import { expect, test } from "bun:test";
import type { HarnessEvent, ModelInfo } from "@cycle/protocol";
import { Harnesses } from "../src/index.ts";
import { FakeHarness } from "./fake-harness.ts";

const model = (id: string, harness: string, isDefault = false): ModelInfo => ({
  id,
  harness,
  name: id,
  description: "",
  efforts: [],
  defaultEffort: null,
  isDefault,
  images: false,
  sandbox: false,
  provider: null,
});

function setup() {
  const main = new FakeHarness("main");
  const other = new FakeHarness("other");
  main.models = [model("main-a", "main", true)];
  other.models = [model("other-a", "other", true)];
  const log: string[] = [];
  const all = new Harnesses(main, [other], (line) => log.push(line));
  return { main, other, all, log };
}

test("a session starts on the agent its model belongs to, and the main one without a model", async () => {
  const { all } = setup();
  expect((await all.createSession({ cwd: "/p", model: "other-a" })).harness).toBe("other");
  expect((await all.createSession({ cwd: "/p", model: "main-a" })).harness).toBe("main");
  expect((await all.createSession({ cwd: "/p" })).harness).toBe("main");
  expect((await all.createSession({ cwd: "/p", model: "nobody's" })).harness).toBe("main");
});

test("only the main agent's default model is the default", async () => {
  const { all } = setup();
  const models = await all.listModels();
  expect(models.map((entry) => [entry.id, entry.isDefault])).toEqual([
    ["main-a", true],
    ["other-a", false],
  ]);
});

test("what is asked of a session goes to the agent that keeps it", async () => {
  const { main, other, all } = setup();
  const session = await all.createSession({ cwd: "/p", model: "other-a" });
  await all.send(session.id, { text: "hello", images: [] }, {});
  await all.renameSession(session.id, "A name");
  expect(other.sent).toEqual([{ sessionId: session.id, text: "hello" }]);
  expect(other.calls).toEqual([`rename ${session.id} A name`]);
  expect(main.sent).toEqual([]);
  const fork = await all.forkSession(session.id, null);
  await all.send(fork.id, { text: "again", images: [] }, {});
  expect(other.sent.at(-1)).toEqual({ sessionId: fork.id, text: "again" });
});

test("a stored session nobody listed yet is looked for before it is used", async () => {
  const { main, other, all } = setup();
  other.stored = [other.session("kept-by-other")];
  await all.loadSession("kept-by-other", {});
  expect(other.calls).toEqual(["load kept-by-other"]);
  await all.loadSession("unheard-of", {});
  expect(main.calls).toEqual(["load unheard-of"]);
});

test("the sessions of every agent are listed, and an agent that cannot list is left out", async () => {
  const { main, other, all, log } = setup();
  main.stored = [main.session("m1")];
  other.stored = [other.session("o1")];
  expect((await all.listSessions({ archived: false })).map((entry) => entry.id)).toEqual([
    "m1",
    "o1",
  ]);
  other.listSessions = async () => {
    throw new Error("no sign-in");
  };
  expect((await all.listSessions({ archived: false })).map((entry) => entry.id)).toEqual(["m1"]);
  expect(log).toEqual(["other could not list its sessions: no sign-in"]);
});

test("an agent that cannot start is left out, and the main one must", async () => {
  const { other, all, log } = setup();
  other.start = async () => {
    throw new Error("not installed");
  };
  await all.start();
  expect((await all.listModels()).map((entry) => entry.id)).toEqual(["main-a"]);
  expect(log).toEqual(["other is left out: not installed"]);

  const failing = setup();
  failing.main.start = async () => {
    throw new Error("no codex");
  };
  expect(failing.all.start()).rejects.toThrow("no codex");
});

test("an answer to an approval goes to the agent that asked", async () => {
  const { main, other, all } = setup();
  const seen: HarnessEvent[] = [];
  all.onEvent((event) => seen.push(event));
  other.emit({
    type: "approval.requested",
    sessionId: "o1",
    turnId: "t1",
    approval: { id: "a1", kind: "fileChange", itemId: "i1", reason: null },
  });
  expect(seen).toHaveLength(1);
  all.respondApproval("a1", { decision: "accept" });
  expect(other.calls).toEqual(["approve a1"]);
  expect(main.calls).toEqual([]);
});

test("files, commands and the connector are the main agent's", async () => {
  const { main, other, all } = setup();
  await all.exec(["git", "-C", "/p", "--no-pager", "status"], { cwd: "/p" });
  expect(main.calls).toEqual(["git status"]);
  expect(other.calls).toEqual([]);
});
