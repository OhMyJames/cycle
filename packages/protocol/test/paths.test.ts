import { expect, test } from "bun:test";
import { toMachinePath } from "../src/index.ts";

const folder = { cwd: "/Users/me/app", sandboxCwd: "/home/agent/workspace/app" };

test("a path a sandbox named is opened here at the same file", () => {
  expect(toMachinePath("/home/agent/workspace/app/src/a.ts", folder)).toBe(
    "/Users/me/app/src/a.ts",
  );
  // The folder itself, and a name that only looks like it.
  expect(toMachinePath("/home/agent/workspace/app", folder)).toBe("/Users/me/app");
  expect(toMachinePath("/home/agent/workspace/application/x", folder)).toBe(
    "/home/agent/workspace/application/x",
  );
});

test("a path of this machine, or of no sandbox, is left as it is", () => {
  expect(toMachinePath("/Users/me/app/src/a.ts", folder)).toBe("/Users/me/app/src/a.ts");
  expect(toMachinePath("src/a.ts", folder)).toBe("src/a.ts");
  expect(toMachinePath("/home/agent/workspace/app/src/a.ts", { ...folder, sandboxCwd: null })).toBe(
    "/home/agent/workspace/app/src/a.ts",
  );
  expect(
    toMachinePath("/home/agent/workspace/app/src/a.ts", {
      cwd: "",
      sandboxCwd: "/home/agent/workspace/app",
    }),
  ).toBe("/home/agent/workspace/app/src/a.ts");
});
