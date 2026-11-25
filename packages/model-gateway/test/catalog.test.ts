import { expect, test } from "bun:test";
import {
  catalogModels,
  isProviderKind,
  modelInfos,
  type ProviderConfig,
  piModel,
  providerKinds,
  splitModelRef,
} from "../src/index.ts";

const model = (id: string, reasoning = false) => ({
  id,
  name: id,
  reasoning,
  images: true,
  contextWindow: 64_000,
  maxTokens: 4_000,
});

const custom: ProviderConfig = {
  id: "mine",
  name: "Mine",
  kind: "custom",
  api: "openai-completions",
  baseUrl: "http://localhost:11434/v1",
  apiKey: null,
  models: [model("llama"), model("thinker", true)],
};

test("the services on offer are the ones a pasted key is enough for", () => {
  const kinds = providerKinds().map((kind) => kind.id);
  expect(kinds).toContain("anthropic");
  expect(kinds).toContain("openrouter");
  // These sign in some other way, or need an address of the owner's own.
  for (const other of ["openai-codex", "github-copilot", "amazon-bedrock", "azure"]) {
    expect(kinds).not.toContain(other);
  }
  expect(isProviderKind("custom")).toBe(true);
  expect(isProviderKind("nope")).toBe(false);
  expect(catalogModels("anthropic").length).toBeGreaterThan(0);
  expect(catalogModels("custom")).toEqual([]);
});

test("a custom endpoint's model is built from what the owner said of it", () => {
  expect(piModel(custom, "llama")).toMatchObject({
    id: "llama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 64_000,
    maxTokens: 4_000,
  });
  expect(piModel(custom, "not-chosen")).toBeNull();
  expect(piModel({ ...custom, baseUrl: null }, "llama")).toBeNull();
});

test("a known service's model is the catalog's, at another address when the owner gave one", () => {
  const known = catalogModels("anthropic")[0];
  if (!known) throw new Error("the catalog is empty");
  const config: ProviderConfig = {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    api: null,
    baseUrl: null,
    apiKey: "k",
    models: [known, model("made-up")],
  };
  expect(piModel(config, known.id)).toMatchObject({
    provider: "anthropic",
    api: "anthropic-messages",
  });
  expect(piModel({ ...config, baseUrl: "https://proxy.test" }, known.id)?.baseUrl).toBe(
    "https://proxy.test",
  );
  // A model the service is not known to serve is not offered at all.
  expect(piModel(config, "made-up")).toBeNull();
  expect(modelInfos(config).map((info) => info.id)).toEqual([`anthropic/${known.id}`]);
});

test("a session knows a provider's model by the provider's id and the model's", () => {
  expect(modelInfos(custom)).toMatchObject([
    { id: "mine/llama", efforts: [], defaultEffort: null, provider: { id: "mine", name: "Mine" } },
    { id: "mine/thinker", defaultEffort: "medium" },
  ]);
  expect(modelInfos(custom)[1]?.efforts.map((effort) => effort.id)).toContain("high");
  // A model id may itself hold a slash, as OpenRouter's do.
  expect(splitModelRef("or/anthropic/claude")).toEqual({
    providerId: "or",
    modelId: "anthropic/claude",
  });
  expect(splitModelRef("gpt-5")).toBeNull();
});

test("DeepSeek's own effort levels include max", () => {
  const known = catalogModels("deepseek");
  const flash = known.find((item) => item.id === "deepseek-flash");
  const pro = known.find((item) => item.id === "deepseek-v4-pro");
  if (!flash || !pro) throw new Error("DeepSeek's models are missing from the catalog");
  const config: ProviderConfig = {
    id: "deepseek",
    name: "DeepSeek",
    kind: "deepseek",
    api: null,
    baseUrl: null,
    apiKey: "k",
    models: [flash, pro],
  };
  expect(modelInfos(config).map((model) => model.efforts.map((effort) => effort.id))).toEqual([
    ["low", "high", "max"],
    ["high", "max"],
  ]);
});
