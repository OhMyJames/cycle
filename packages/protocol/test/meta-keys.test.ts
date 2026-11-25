import { expect, test } from "bun:test";
import { META } from "../src/index.ts";

test("META.worktree keeps its wire key name", () => {
  expect(META.worktree).toBe("cycle/worktree");
});
