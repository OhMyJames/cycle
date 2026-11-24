import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { META, type ProviderModel } from "@cycle/protocol";
import {
  isGoneOwnModel,
  ModelProviders,
  ProvidersUnreadableError,
  withProviderModels,
} from "../src/providers.ts";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cycle-providers-"));
  path = join(dir, "providers.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const model = (id: string): ProviderModel => ({
  id,
  name: id.toUpperCase(),
  reasoning: true,
  images: false,
  contextWindow: 32_000,
  maxTokens: 4_000,
});
const custom = {
  name: "Acme",
  kind: "custom",
  api: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:9/v1/",
  apiKey: "sk-secret",
  models: [model("fast")],
};

test("a key goes in once: it is on disk (0600), and in no answer", async () => {
  const providers = await ModelProviders.load(path);
  const saved = await providers.save(custom);
  expect(saved).toMatchObject({ id: "acme", hasKey: true, baseUrl: "http://127.0.0.1:9/v1" });
  expect(JSON.stringify([saved, providers.list()])).not.toContain("sk-secret");
  expect(await Bun.file(path).text()).toContain("sk-secret");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await ModelProviders.load(path)).list()[0]?.id).toBe("acme");
  await providers.close();
});

test("a key stays with the address it was given for", async () => {
  const providers = await ModelProviders.load(path);
  const saved = await providers.save(custom);
  const same = await providers.save({ ...custom, id: saved.id, apiKey: undefined, name: "Acme 2" });
  expect(same.hasKey).toBe(true);
  const moved = await providers.save({
    ...custom,
    id: saved.id,
    apiKey: undefined,
    baseUrl: "http://evil.example/v1",
  });
  expect(moved.hasKey).toBe(false);
  await providers.close();
});

test("an id is made once and never changes; two with one name are told apart", async () => {
  const providers = await ModelProviders.load(path);
  const first = await providers.save(custom);
  const second = await providers.save({ ...custom, apiKey: undefined });
  expect([first.id, second.id]).toEqual(["acme", "acme-2"]);
  expect((await providers.save({ ...custom, id: "acme", name: "Renamed" })).id).toBe("acme");
  await providers.close();
});

test("what cannot be reached is refused", async () => {
  const providers = await ModelProviders.load(path);
  await expect(providers.save({ ...custom, baseUrl: "ftp://x" })).rejects.toThrow("http");
  await expect(providers.save({ ...custom, baseUrl: "http://u:p@x/v1" })).rejects.toThrow("key");
  await expect(providers.save({ ...custom, baseUrl: null })).rejects.toThrow("address");
  await expect(providers.save({ ...custom, models: [] })).rejects.toThrow("model");
  await expect(providers.save({ ...custom, kind: "nope" })).rejects.toThrow("known");
  await expect(providers.save({ ...custom, id: "gone" })).rejects.toThrow("gone");
  expect(providers.list()).toEqual([]);
  await providers.close();
});

test("the gateway starts when a session asks and there is something to serve; it needs the token", async () => {
  const providers = await ModelProviders.load(path);
  expect(providers.adapterConfig()).toBeUndefined();
  await providers.save(custom);
  const own = providers.adapterConfig();
  expect(own?.models.map((m) => m.id)).toEqual(["acme/fast"]);
  if (!own) throw new Error("no providers");
  expect((await fetch(`${own.url}/responses`, { method: "POST", body: "{}" })).status).toBe(401);
  expect(providers.adapterConfig()?.token).toBe(own.token);
  await providers.close();
});

test("a providers file that cannot be read stops the daemon rather than being replaced", async () => {
  await writeFile(path, "{ not json");
  await expect(ModelProviders.load(path)).rejects.toBeInstanceOf(ProvidersUnreadableError);
  expect(await Bun.file(path).text()).toBe("{ not json");
});

test("the owner's models join an agent's model choices, marked with their provider", async () => {
  const providers = await ModelProviders.load(path);
  await providers.save(custom);
  const schema = { properties: { model: { oneOf: [{ const: "default", title: "Default" }] } } };
  const out = withProviderModels(schema, providers.models()) as typeof schema;
  expect(out.properties.model.oneOf).toMatchObject([
    { const: "default" },
    { const: "acme/fast", title: "FAST", _meta: { [META.provider]: { id: "acme", name: "Acme" } } },
  ]);
  expect(withProviderModels({ properties: {} }, providers.models())).toEqual({ properties: {} });
  await providers.close();
});

test("a saved default that names a model gone since is told from one of the agent's own", async () => {
  const providers = await ModelProviders.load(path);
  await providers.save(custom);
  const offered = providers.models();
  expect(isGoneOwnModel("acme/fast", offered)).toBe(false);
  expect(isGoneOwnModel("acme/slow", offered)).toBe(true);
  expect(isGoneOwnModel("gpt-5.4", offered)).toBe(false);
  expect(isGoneOwnModel(undefined, offered)).toBe(false);
  await providers.close();
});

test("nothing is served once the providers are closed", async () => {
  const providers = await ModelProviders.load(path);
  await providers.save(custom);
  await providers.close();
  expect(providers.adapterConfig()).toBeUndefined();
});
