import { expect, test } from "bun:test";
import type { ModelProvider, ModelProviderDraft } from "@cycle/protocol";
import { JsonStore, Providers, type ProvidersFile } from "../src/index.ts";
import { manualSchedule } from "./fake-harness.ts";

async function setup() {
  let written = "";
  const timers = manualSchedule();
  const store = await JsonStore.open<ProvidersFile>(
    {
      read: async () => null,
      write: async (text) => {
        written = text;
      },
    },
    { providers: [] },
    timers.schedule,
  );
  const changes: ModelProvider[][] = [];
  const providers = new Providers(store, (list) => changes.push(list));
  return { providers, store, changes, written: () => written };
}

const custom: ModelProviderDraft = {
  name: "My Ollama",
  kind: "custom",
  api: "openai-completions",
  baseUrl: "http://localhost:11434/v1/",
  apiKey: " sk-secret ",
  models: [
    { id: " llama ", name: "", reasoning: false, images: false, contextWindow: 0, maxTokens: -1 },
    { id: "llama", name: "again", reasoning: true, images: true, contextWindow: 1, maxTokens: 1 },
  ],
};

test("a key goes in and never comes back out", async () => {
  const { providers, store, changes, written } = await setup();
  const saved = providers.save(custom);
  expect(saved).toMatchObject({
    id: "my-ollama",
    hasKey: true,
    baseUrl: "http://localhost:11434/v1",
    // A model named twice is one model, and numbers that make no sense get a usable one.
    models: [{ id: "llama", name: "llama", contextWindow: 128_000, maxTokens: 16_384 }],
  });
  expect(JSON.stringify([saved, providers.list(), changes])).not.toContain("sk-secret");
  expect(providers.configs()[0]?.apiKey).toBe("sk-secret");
  await store.flush();
  expect(written()).toContain("sk-secret");
  expect(providers.models().map((model) => model.id)).toEqual(["my-ollama/llama"]);
});

test("changing a provider keeps its id and its key unless a new key is given", async () => {
  const { providers } = await setup();
  const { id } = providers.save(custom);
  const { apiKey: _, ...noKey } = custom;
  const renamed = providers.save({ ...noKey, id, name: "Renamed", kind: "anthropic" });
  // The id names its models in every session, and what it is for was chosen once.
  expect(renamed).toMatchObject({ id, name: "Renamed", kind: "custom", hasKey: true });
  expect(providers.configs()[0]?.apiKey).toBe("sk-secret");
  expect(providers.save({ ...custom, id, apiKey: "" }).hasKey).toBe(false);
  expect(providers.save({ ...custom, name: "My Ollama" }).id).toBe("my-ollama-2");
  providers.remove(id);
  expect(providers.list().map((provider) => provider.id)).toEqual(["my-ollama-2"]);
  expect(() => providers.save({ ...custom, id })).toThrow("gone");
});

test("a provider that could not be asked is refused, with the reason", async () => {
  const { providers } = await setup();
  expect(() => providers.save({ ...custom, kind: "nope" })).toThrow("not known");
  expect(() => providers.save({ ...custom, baseUrl: null })).toThrow("needs an address");
  expect(() => providers.save({ ...custom, baseUrl: "ftp://x" })).toThrow("http://");
  expect(() => providers.save({ ...custom, baseUrl: "https://key@host" })).toThrow("own field");
  expect(() => providers.save({ ...custom, api: null })).toThrow("protocol");
  expect(() => providers.save({ ...custom, models: [] })).toThrow("at least one model");
  expect(providers.list()).toEqual([]);
});

test("a known service takes its models from the catalog, not from the page", async () => {
  const { providers } = await setup();
  const known = providers.catalog("anthropic")[0];
  if (!known) throw new Error("the catalog is empty");
  const saved = providers.save({
    name: "",
    kind: "anthropic",
    api: "openai-completions",
    baseUrl: null,
    apiKey: "k",
    models: [{ ...known, contextWindow: 5, name: "Renamed by the page" }],
  });
  expect(saved).toMatchObject({ id: "anthropic", name: "Anthropic", api: null, models: [known] });
  expect(() => providers.save({ ...saved, models: [{ ...known, id: "made-up" }] })).toThrow(
    "not a model this service is known to serve",
  );
});
