import { expect, test } from "bun:test";
import { optionsFromLegacy } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import { CLAUDE_MODES } from "../src/translate.ts";
import { FakeSdk } from "./fake-sdk.ts";

function begin(sdk = new FakeSdk()) {
  return new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/nonexistent/claude" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => "id",
  });
}

test("Claude Code's options are its modes and models as one list, and nothing of them is lost", async () => {
  const sdk = new FakeSdk();
  sdk.models = [
    ...sdk.models,
    { value: "haiku", displayName: "Haiku", description: "Haiku · Fast" },
    {
      value: "opus",
      displayName: "Opus",
      description: "Opus · Deep",
      supportedEffortLevels: ["low", "max"],
    },
  ];
  const harness = begin(sdk);
  const options = await harness.options();
  expect(options).toEqual(
    optionsFromLegacy("claude", harness.listModes(), await harness.listModels()),
  );
  expect(options.map((option) => option.id)).toEqual(["model", "mode"]);

  const [model, mode] = options;
  // Every mode, by id and in order, with what marks it.
  expect(mode?.values.map((value) => value.id)).toEqual(CLAUDE_MODES.map((each) => each.id));
  expect(mode?.values.filter((value) => value.default).map((value) => value.id)).toEqual([
    "acceptEdits",
  ]);
  expect(mode?.values.filter((value) => value.dangerous).map((value) => value.id)).toEqual([
    "bypassPermissions",
  ]);
  // Every model, and each one's efforts under it with its own default marked.
  expect(model?.values.map((value) => value.id)).toEqual(["claude-sonnet-5-5", "haiku", "opus"]);
  const efforts = (id: string) =>
    model?.values
      .find((value) => value.id === id)
      ?.under.flatMap((option) => option.values.map((value) => [value.id, value.default]));
  expect(efforts("claude-sonnet-5-5")).toEqual([
    ["low", false],
    ["medium", false],
    ["high", true],
  ]);
  expect(efforts("haiku")).toEqual([]);
  expect(efforts("opus")).toEqual([
    ["low", true],
    ["max", false],
  ]);
  // The one Claude Code calls the default is the default model, and none is a provider's.
  expect(model?.values.filter((value) => value.default).map((value) => value.id)).toEqual([
    "claude-sonnet-5-5",
  ]);
  expect(model?.values.every((value) => value.provider === null)).toBe(true);
});
