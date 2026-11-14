import { expect, test } from "bun:test";
import type { SandboxEnvironment } from "@cycle/protocol";
import { sandboxDraft, sandboxFormFor, sandboxSummary } from "../src/lib/sandbox-form.ts";

const node: SandboxEnvironment = {
  id: "node",
  name: "Node",
  cpus: 4,
  memoryGb: 8,
  hosts: ["api.example.com", "*.example.org"],
  variables: ["NPM_TOKEN"],
  setup: "npm ci",
};

function variable(name: string, value: string) {
  return [{ name, value, stored: false }];
}

test("an environment's form sends a stored variable by name, with no value the page never had", () => {
  const form = sandboxFormFor(node);
  expect(form.variables).toEqual([{ name: "NPM_TOKEN", value: "", stored: true }]);
  expect(sandboxDraft(form)).toEqual({
    id: "node",
    name: "Node",
    cpus: 4,
    memoryGb: 8,
    hosts: ["api.example.com", "*.example.org"],
    variables: { NPM_TOKEN: null },
    setup: "npm ci",
  });
  form.variables.push(
    { name: "CI", value: "1", stored: false },
    { name: "", value: "", stored: false },
  );
  form.hosts = "a.example.com, b.example.com\n\nc.example.com";
  form.cpus = "";
  expect(sandboxDraft(form)).toMatchObject({
    cpus: null,
    hosts: ["a.example.com", "b.example.com", "c.example.com"],
    variables: { NPM_TOKEN: null, CI: "1" },
  });
});

test("a new environment's form says what is wrong before it is sent", () => {
  const form = sandboxFormFor(null);
  expect(sandboxDraft(form)).toBe("Give the environment a name.");
  form.name = "Go";
  expect(sandboxDraft(form)).toMatchObject({ name: "Go", cpus: null, memoryGb: null });
  expect(sandboxDraft({ ...form, cpus: "two" })).toBe("CPUs is a whole number.");
  expect(sandboxDraft({ ...form, memoryGb: "1.5" })).toBe("Memory is a whole number of GB.");
  expect(sandboxDraft({ ...form, variables: variable("A-B", "x") })).toContain("not a variable");
  expect(sandboxDraft({ ...form, variables: variable("A", "") })).toBe("A needs a value.");
  expect(sandboxDraft({ ...form, variables: [...variable("A", "1"), ...variable("A", "2")] })).toBe(
    "A is there twice.",
  );
});

test("an environment's row says what it sets", () => {
  expect(sandboxSummary(node)).toBe("4 CPUs · 8 GB · 2 hosts · 1 variable · setup script");
  expect(
    sandboxSummary({ ...node, cpus: 1, memoryGb: null, hosts: [], variables: [], setup: "" }),
  ).toBe("1 CPU");
  expect(
    sandboxSummary({ ...node, cpus: null, memoryGb: null, hosts: [], variables: [], setup: "" }),
  ).toContain("Docker's own choices");
});
