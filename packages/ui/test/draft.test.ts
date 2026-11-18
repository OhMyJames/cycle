import { expect, test } from "bun:test";
import {
  canSandbox,
  draftHarness,
  draftModel,
  draftEnvironment,
  draftStart,
  harnessesOf,
  lastDraftFrom,
} from "../src/lib/draft.ts";

const models = [
  { id: "gpt-a", harness: "codex", isDefault: false, sandbox: false },
  { id: "gpt-b", harness: "codex", isDefault: true, sandbox: false },
  { id: "mine/model", harness: "codex", isDefault: false, sandbox: false },
  { id: "claude-sonnet", harness: "claude", isDefault: false, sandbox: true },
  { id: "claude-opus", harness: "claude", isDefault: false, sandbox: true },
];

test("the agents are the ones the models name, the main one first", () => {
  expect(harnessesOf(models)).toEqual(["codex", "claude"]);
  expect(harnessesOf([])).toEqual([]);
});

test("a new session starts on the agent of the owner's usual model, or the main one", () => {
  expect(draftHarness(models, "claude-opus")).toBe("claude");
  expect(draftHarness(models, null)).toBe("codex");
  expect(draftHarness(models, "gone")).toBe("codex");
  expect(draftHarness([], "claude-opus")).toBe("codex");
});

test("an agent's session names a model of that agent's, so the usual one cannot move it to another", () => {
  expect(draftModel(models, "claude", "claude-opus")).toBe("claude-opus");
  // The usual model is another agent's: this agent's own choice, or its first.
  expect(draftModel(models, "codex", "claude-opus")).toBe("gpt-b");
  expect(draftModel(models, "claude", "gpt-a")).toBe("claude-sonnet");
  expect(draftModel(models, "claude", null)).toBe("claude-sonnet");
  expect(draftModel([], "claude", "claude-opus")).toBeNull();
});

test("where a session can run is its agent's to say", () => {
  expect(canSandbox(models, "claude")).toBe(true);
  expect(canSandbox(models, "codex")).toBe(false);
});

test("a new session starts as the last one did, while what that chose is still there", () => {
  const environments = [{ id: "standard" }, { id: "node" }];
  const last = { harness: "claude", environment: { claude: "node", codex: "node" } };
  expect(draftStart(models, "gpt-a", last)).toBe("claude");
  expect(draftEnvironment(models, environments, "claude", last)).toBe("node");
  // Codex runs on this machine only, whatever was kept for it.
  expect(draftEnvironment(models, environments, "codex", last)).toBeNull();
  // An environment that is gone, or an agent no longer on offer, falls back.
  expect(draftEnvironment(models, [{ id: "standard" }], "claude", last)).toBeNull();
  expect(draftStart(models.slice(0, 3), "gpt-a", last)).toBe("codex");
  expect(draftStart(models, "claude-opus", { harness: null, environment: {} })).toBe("claude");
  expect(
    draftEnvironment(models, environments, "claude", { harness: null, environment: {} }),
  ).toBeNull();
});

test("what the owner's last session chose is read back, and nothing unreadable chooses anything", () => {
  const stored = JSON.stringify({
    harness: "claude",
    environment: { claude: "node", codex: null },
  });
  expect(lastDraftFrom(stored)).toEqual({
    harness: "claude",
    environment: { claude: "node", codex: null },
  });
  expect(lastDraftFrom("{}")).toEqual({ harness: null, environment: {} });
  expect(lastDraftFrom(null)).toEqual({ harness: null, environment: {} });
  expect(lastDraftFrom("not json")).toEqual({ harness: null, environment: {} });
});

test("the choice a page of before kept as `sandbox` is still the owner's last choice", () => {
  const legacy = JSON.stringify({ harness: "claude", sandbox: { claude: "node" } });
  expect(lastDraftFrom(legacy)).toEqual({ harness: "claude", environment: { claude: "node" } });
  // Once kept as `environment`, that is what counts.
  const both = JSON.stringify({
    harness: "claude",
    sandbox: { claude: "node" },
    environment: { claude: "standard" },
  });
  expect(lastDraftFrom(both).environment).toEqual({ claude: "standard" });
});
