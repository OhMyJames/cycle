import { expect, test } from "bun:test";
import { resolveMode } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import { isContained } from "../src/sandbox.ts";
import { CLAUDE_MODES, modeOptions, toModels } from "../src/translate.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

/** What Claude Code gives of a session's choices today, pinned before they become one list (step 18). */

const SONNET = "claude-sonnet-5-5";

function begin() {
  const sdk = new FakeSdk();
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/nonexistent/claude" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => "id",
  });
  return { sdk, harness };
}

test("the modes keep their order, one is the default and it is not the one that never asks", () => {
  expect(CLAUDE_MODES.map((mode) => mode.id)).toEqual([
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
  ]);
  expect(CLAUDE_MODES.filter((mode) => mode.isDefault).map((mode) => mode.id)).toEqual([
    "acceptEdits",
  ]);
  expect(CLAUDE_MODES.filter((mode) => mode.dangerous && mode.isDefault)).toEqual([]);
  expect(CLAUDE_MODES.filter((mode) => mode.dangerous).map((mode) => mode.id)).toEqual([
    "bypassPermissions",
  ]);
  expect(CLAUDE_MODES.filter((mode) => mode.plan).map((mode) => mode.id)).toEqual(["plan"]);
});

const read = (value: string | undefined) => resolveMode(CLAUDE_MODES, value)?.id;

test("a stored mode is read by id, an old one by what replaces it, anything else as the default", () => {
  expect(read("dontAsk")).toBe("dontAsk");
  expect(read("legacy:readOnly")).toBe("default");
  expect(read("legacy:auto")).toBe("acceptEdits");
  expect(read("legacy:fullAccess")).toBe("bypassPermissions");
  expect(read("fullAccess")).toBe("acceptEdits");
  expect(read("gone")).toBe("acceptEdits");
  expect(read(undefined)).toBe("acceptEdits");
});

test("a model lists its efforts as Claude Code gives them, and runs at high when it has it", () => {
  const models = toModels([
    {
      value: "default",
      resolvedModel: "a",
      displayName: "A",
      description: "A · x",
      supportedEffortLevels: ["low", "medium", "high", "max"],
    },
    {
      value: "b",
      displayName: "B",
      description: "B · y",
      supportedEffortLevels: ["low", "medium"],
    },
    { value: "c", displayName: "C", description: "C · z", supportedEffortLevels: [] },
    { value: "d", displayName: "D", description: "D" },
  ]);
  expect(models.map((model) => [model.id, model.efforts.map((effort) => effort.id)])).toEqual([
    ["a", ["low", "medium", "high", "max"]],
    ["b", ["low", "medium"]],
    ["c", []],
    ["d", []],
  ]);
  // The model's own effort: high where it is offered, else the first, else none.
  expect(models.map((model) => model.defaultEffort)).toEqual(["high", "low", null, null]);
  expect(models.map((model) => model.isDefault)).toEqual([true, false, false, false]);
  // Claude Code's own models take images, and none is a provider's.
  expect(models.every((model) => model.images && model.provider === null)).toBe(true);
});

test("whether a session can run in a sandbox is said of every model alike", () => {
  const raw = [
    { value: "x", displayName: "X", description: "X" },
    { value: "y", displayName: "Y", description: "Y" },
  ];
  expect(toModels(raw).map((model) => model.sandbox)).toEqual([false, false]);
  expect(toModels(raw, true).map((model) => model.sandbox)).toEqual([true, true]);
});

test("a turn with no mode starts asking first, though the default of the list is another", async () => {
  const { sdk, harness } = begin();
  const session = await harness.createSession({ cwd: "/project", model: SONNET });
  await harness.send(session.id, { text: "hi", images: [] }, { model: SONNET });
  await settle();
  expect(CLAUDE_MODES.find((mode) => mode.isDefault)?.id).toBe("acceptEdits");
  expect(sdk.last.options.permissionMode).toBe("default");
  expect(harness.listModes()).toEqual([...CLAUDE_MODES]);
});

test("a session in a container has no sandbox of Claude Code's own, and the others do", () => {
  expect(isContained(undefined)).toBe(false);
  expect(isContained(null)).toBe(false);
  expect(isContained("sbx-1")).toBe(true);
  expect(modeOptions("acceptEdits", false).sandbox).toEqual({
    enabled: true,
    autoAllowBashIfSandboxed: true,
  });
  expect(modeOptions("acceptEdits", true)).toEqual({ permissionMode: "acceptEdits" });
  expect(modeOptions("auto", true)).toEqual({ permissionMode: "auto" });
  // Never asking has no sandbox, contained or not.
  expect(modeOptions("bypassPermissions", true)).toEqual(modeOptions("bypassPermissions", false));
});

test("an effort of null is the model's default effort, and a model with no high one has none to move to", async () => {
  const { sdk, harness } = begin();
  sdk.models = [
    ...sdk.models,
    { value: "low-only", displayName: "L", description: "L", supportedEffortLevels: ["low"] },
  ];
  const session = await harness.createSession({ cwd: "/project", model: SONNET });
  await harness.send(session.id, { text: "hi", images: [] }, { model: SONNET, mode: "default" });
  await settle();
  const query = sdk.last;
  await harness.configure(session.id, { effort: "low" });
  await harness.configure(session.id, { effort: null });
  expect(query.moves).toEqual(["effort low", "effort high"]);
  await harness.configure(session.id, { model: "low-only", effort: null });
  expect(query.moves.slice(2)).toEqual(["model low-only", "effort default"]);
});
