import { expect, test } from "bun:test";
import type { ModelInfo } from "@cycle/protocol";
import { Harnesses } from "../src/index.ts";
import { FakeHarness } from "./fake-harness.ts";

const model = (id: string, harness: string, isDefault = false): ModelInfo => ({
  id,
  harness,
  name: id,
  description: "",
  efforts: [{ id: "low", description: "" }],
  defaultEffort: "low",
  isDefault,
  images: true,
  sandbox: false,
  provider: null,
});

function join() {
  const main = new FakeHarness();
  const other = new FakeHarness("claude");
  main.models = [model("a", "fake", true)];
  other.models = [model("sonnet", "claude", true)];
  const log: string[] = [];
  return { main, other, log, joined: new Harnesses(main, [other], (line) => log.push(line)) };
}

test("each agent's options are its own, the main agent first, with its own default model", async () => {
  const { joined } = join();
  await joined.start();
  const agents = await joined.options();
  expect(agents.map((entry) => entry.agent)).toEqual(["fake", "claude"]);
  for (const { agent, options } of agents) {
    expect(options.map((option) => option.id)).toEqual(["model", "mode"]);
    const modes = options[1]?.values.map((value) => value.id);
    expect(modes).toEqual(["readOnly", "auto", "plan", "fullAccess"]);
    // Where `listModels` leaves the default of a new session to the main agent, an option says its own.
    const first = options[0]?.values[0];
    expect(first).toMatchObject({ id: agent === "fake" ? "a" : "sonnet", default: true });
    expect(first?.under[0]?.values).toMatchObject([{ id: "low", default: true }]);
  }
  expect(
    (await joined.listModels()).filter((each) => each.isDefault).map((each) => each.id),
  ).toEqual(["a"]);
});

test("an agent that cannot say its options is left out and logged, and the main agent's failure is the caller's", async () => {
  const { main, other, joined, log } = join();
  await joined.start();
  other.options = async () => {
    throw new Error("no models");
  };
  expect((await joined.options()).map((entry) => entry.agent)).toEqual(["fake"]);
  expect(log).toContain("claude could not list its options: no models");
  main.options = async () => {
    throw new Error("codex is down");
  };
  expect(joined.options()).rejects.toThrow("codex is down");
});
