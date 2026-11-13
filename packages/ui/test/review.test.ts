import { expect, test } from "bun:test";
import { reviewArgument, reviewTarget } from "../src/lib/review.ts";

test("only text that starts with /review is a review", () => {
  expect(reviewArgument("/review")).toBe("");
  expect(reviewArgument("  /review   the parser ")).toBe("the parser");
  expect(reviewArgument("/reviews")).toBeNull();
  expect(reviewArgument("please /review")).toBeNull();
});

test("a review reads the changes, a branch, a commit or what the owner says", () => {
  const branches = ["main", "origin/main"];
  expect(reviewTarget("", branches)).toEqual({ kind: "uncommitted" });
  expect(reviewTarget("origin/main", branches)).toEqual({ kind: "branch", branch: "origin/main" });
  expect(reviewTarget("a1b2c3d", branches)).toEqual({ kind: "commit", sha: "a1b2c3d" });
  expect(reviewTarget("deadbeef please", branches)).toEqual({
    kind: "custom",
    instructions: "deadbeef please",
  });
  expect(reviewTarget("security", branches)).toEqual({ kind: "custom", instructions: "security" });
});
