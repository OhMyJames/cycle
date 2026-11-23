import { expect, test } from "bun:test";
import { modes, options, policy, turnPolicy } from "../src/settings.ts";

test("Codex owns its permission mapping and exposes model-dependent effort options", () => {
  expect(policy("read-only")).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
  expect(policy("full-access")).toMatchObject({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  expect(turnPolicy("untrusted")).toMatchObject({
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "workspaceWrite" },
  });
  expect(modes.map((mode) => mode.value)).toEqual([
    "default",
    "untrusted",
    "read-only",
    "auto-review",
    "plan",
    "full-access",
  ]);
  const catalog = [
    {
      id: "m1",
      model: "gpt-test",
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: "Test model",
      description: "A test model",
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
      defaultReasoningEffort: "high",
      inputModalities: [],
      supportsPersonality: false,
      multiAgentVersion: null,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      availableAccessPrograms: null,
      isDefault: true,
    },
  ];
  const model = options("default", catalog, "gpt-test", "high");
  expect(model.find((option) => option.configId === "model")?.currentValue).toBe("gpt-test");
  expect(model.find((option) => option.configId === "effort")?.options).toEqual([
    { value: "default", name: "Default" },
    { value: "high", name: "High" },
  ]);
});
