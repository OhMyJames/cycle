import { expect, test } from "bun:test";
import { environmentLabel } from "../src/lib/environment.ts";

const environments = [
  { id: "standard", name: "Standard" },
  { id: "node", name: "Node projects" },
];

test("a session in an environment of the owner's names it, not its id", () => {
  expect(environmentLabel(environments, "node")).toBe("Node projects");
});

test("a session whose environment was removed says so", () => {
  expect(environmentLabel(environments, "gone")).toBe("Removed environment");
  expect(environmentLabel([], "standard")).toBe("Removed environment");
});

test("a session on this machine has nothing to say", () => {
  expect(environmentLabel(environments, null)).toBeNull();
});
