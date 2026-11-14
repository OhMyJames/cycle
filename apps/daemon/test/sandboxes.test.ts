import { expect, test } from "bun:test";
import type { SandboxEnvironment, SandboxEnvironmentDraft } from "@cycle/protocol";
import {
  JsonStore,
  SandboxEnvironments,
  type SandboxesFile,
  newSandboxesFile,
  sandboxBook,
} from "../src/index.ts";
import { manualSchedule } from "./fake-harness.ts";

async function setup() {
  let written = "";
  const timers = manualSchedule();
  const store = await JsonStore.open<SandboxesFile>(
    {
      read: async () => null,
      write: async (text) => {
        written = text;
      },
    },
    newSandboxesFile(),
    timers.schedule,
  );
  const changes: SandboxEnvironment[][] = [];
  const environments = new SandboxEnvironments(store, (list) => changes.push(list));
  return { environments, store, changes, book: sandboxBook(store), written: () => written };
}

const node: SandboxEnvironmentDraft = {
  name: " Node projects ",
  cpus: 4,
  memoryGb: 8,
  hosts: ["API.example.com", " *.example.org ", "api.example.com", ""],
  variables: { NPM_TOKEN: "s3cret", CI: "1" },
  setup: "npm ci\r\n",
};

test("a new home has one environment with nothing chosen, which cannot be the one removed", async () => {
  const { environments } = await setup();
  expect(environments.list()).toEqual([
    {
      id: "standard",
      name: "Standard",
      cpus: null,
      memoryGb: null,
      hosts: [],
      variables: [],
      setup: "",
    },
  ]);
  expect(() => environments.remove("standard")).toThrow("Keep one environment");
});

test("an environment is kept whole, and the page is given its variables by name alone", async () => {
  const { environments, store, changes, book } = await setup();
  const saved = environments.save(node);
  expect(saved).toEqual({
    id: "node-projects",
    name: "Node projects",
    cpus: 4,
    memoryGb: 8,
    hosts: ["api.example.com", "*.example.org"],
    variables: ["CI", "NPM_TOKEN"],
    setup: "npm ci\n",
  });
  expect(JSON.stringify(changes)).not.toContain("s3cret");
  await store.flush();
  // What makes the sandbox has the values.
  expect(book.environment("node-projects")?.variables).toEqual({ NPM_TOKEN: "s3cret", CI: "1" });
  expect(book.environment("gone")).toBeNull();
});

test("a variable sent without a value keeps the one stored, and one left out is gone", async () => {
  const { environments, book } = await setup();
  const { id } = environments.save(node);
  environments.save({ ...node, id, name: "Node", variables: { NPM_TOKEN: null, NEW: "x" } });
  // The id names its sandboxes, so a new name does not change it.
  expect(environments.list().map((one) => [one.id, one.name])).toContainEqual([id, "Node"]);
  expect(book.environment(id)?.variables).toEqual({ NPM_TOKEN: "s3cret", NEW: "x" });
  expect(() => environments.save({ ...node, id, variables: { NEVER_SET: null } })).toThrow(
    "NEVER_SET needs a value.",
  );
});

test("what cannot be an argument or a size is refused", async () => {
  const { environments } = await setup();
  const refuse = (change: Partial<SandboxEnvironmentDraft>, why: string) =>
    expect(() => environments.save({ ...node, ...change })).toThrow(why);
  refuse({ name: " " }, "Give the environment a name.");
  refuse({ name: "standard" }, "Another environment has that name.");
  refuse({ cpus: 0 }, "CPUs is a whole number from 1 to 64.");
  refuse({ memoryGb: 1.5 }, "Memory is a whole number");
  // A host goes to sbx as an argument: it cannot pass for a flag, or hold a space.
  refuse({ hosts: ["--sandbox"] }, "is not a host");
  refuse({ hosts: ["a b.com"] }, "is not a host");
  refuse({ variables: { "BAD-NAME": "x" } }, "is not a variable's name");
  refuse({ variables: { A: "two\nlines" } }, "one line");
  refuse({ id: "gone" }, "That environment is gone.");
  expect(environments.list()).toHaveLength(1);
});

test("what was made of each sandbox is kept with the environments", async () => {
  const { store, book, written } = await setup();
  book.setMade("cycle-app-1", { environment: "standard", version: "v1", hosts: [] });
  expect(book.made("cycle-app-1")?.version).toBe("v1");
  expect(Object.keys(book.allMade())).toEqual(["cycle-app-1"]);
  await store.flush();
  expect(JSON.parse(written()).made["cycle-app-1"].environment).toBe("standard");
  book.setMade("cycle-app-1", null);
  expect(book.made("cycle-app-1")).toBeNull();
});
