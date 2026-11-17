import { expect, test } from "bun:test";
import { emptyConfig, setHooks, startKey } from "../src/config.ts";
import { resultError } from "../src/translate.ts";

const settings = (run: Partial<ReturnType<typeof emptyConfig>["run"]>) => ({
  hooks: [],
  run: { ...emptyConfig().run, ...run },
  ownerHooks: true,
  ownerSettings: true,
  revision: 0,
});
const keep = (run: Parameters<typeof settings>[0]) =>
  setHooks(emptyConfig(), settings(run), () => "id").run;

test("a limit that did not succeed is told in words, and what Claude Code said comes first", () => {
  expect(resultError({ subtype: "error_max_turns" })).toContain("limit of requests");
  expect(resultError({ subtype: "error_max_budget_usd" })).toContain("most it may spend");
  expect(resultError({ subtype: "error_during_execution" })).toContain("failed");
  expect(resultError({ subtype: "error_max_turns", errors: ["a", "b"] })).toBe("a\nb");
  expect(resultError({ subtype: "error_during_execution", result: "boom" })).toBe("boom");
  expect(resultError({})).toBe("The turn failed.");
});

test("the run settings are kept as numbers and names, and nothing else gets through", () => {
  expect(keep({ fallbackModel: " a , b ", maxTurns: 5, maxBudgetUsd: 2.5 })).toEqual({
    fallbackModel: "a,b",
    maxTurns: 5,
    maxBudgetUsd: 2.5,
    promptSuggestions: false,
  });
  expect(keep({ fallbackModel: "" }).fallbackModel).toBeNull();
  for (const run of [
    { fallbackModel: "a b;rm" },
    { maxTurns: 0 },
    { maxTurns: 1.5 },
    { maxBudgetUsd: 0 },
    { maxBudgetUsd: Number.NaN },
  ]) {
    expect(() => keep(run)).toThrow();
  }
});

test("a change of what a process starts with is told by its key", () => {
  const before = startKey(emptyConfig(), []);
  const after = startKey({ ...emptyConfig(), run: { ...emptyConfig().run, maxTurns: 3 } }, []);
  expect(after).not.toBe(before);
});
