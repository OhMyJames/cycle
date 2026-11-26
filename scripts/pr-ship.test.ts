import { expect, test } from "bun:test";
import { ship } from "./pr-ship.ts";

const recorder = (failOn?: string) => {
  const calls: string[] = [];
  const run = async (cmd: string[]) => {
    const line = cmd.join(" ");
    calls.push(line);
    return failOn !== undefined && line.startsWith(failOn) ? 3 : 0;
  };
  return { calls, run };
};

test("runs check, push, pr create, checks --watch, merge --squash, prune in order, without sleep", async () => {
  const { calls, run } = recorder();
  expect(await ship(run)).toBe(0);
  expect(calls).toEqual([
    "bun run check",
    "git push -u origin HEAD",
    "gh pr create --fill",
    "gh pr checks --watch",
    "gh pr merge --squash",
    "bun run worktree:prune",
  ]);
  expect(calls.some((c) => c.includes("sleep"))).toBe(false);
});

test("a failing check stops before push and PR", async () => {
  const { calls, run } = recorder("bun run check");
  expect(await ship(run)).toBe(3);
  expect(calls).toEqual(["bun run check"]);
});

test("failing CI stops before merge and prune, with a non-zero code", async () => {
  const { calls, run } = recorder("gh pr checks");
  expect(await ship(run)).toBe(3);
  expect(calls).toEqual([
    "bun run check",
    "git push -u origin HEAD",
    "gh pr create --fill",
    "gh pr checks --watch",
  ]);
});
