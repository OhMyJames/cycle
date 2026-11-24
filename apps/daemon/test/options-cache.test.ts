import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_META, EFFORTS_META, PLAN_USAGE_UPDATE } from "@cycle/harness-claude";
import { META, PLAN_USAGE_UPDATE as PLAN_USAGE } from "@cycle/protocol";
import { CLAUDE_CONFIG_SCHEMA } from "../src/claude-agent.ts";
import { AgentOptionsCache, choicesFromConfigOptions } from "../src/options-cache.ts";

const dirs: string[] = [];
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "cycle-options-cache-"));
  dirs.push(dir);
  return join(dir, "agent-options.json");
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("caches discovered model choices to disk and overlays them onto configSchema across restarts", async () => {
  const path = tempPath();
  const cache = await AgentOptionsCache.load(path);
  expect(cache.apply("claude", CLAUDE_CONFIG_SCHEMA)).toBe(CLAUDE_CONFIG_SCHEMA);

  const choices = choicesFromConfigOptions(
    [
      {
        configId: "model",
        name: "Model",
        options: [
          { value: "default", name: "Default model" },
          { value: "fabel", name: "Fabel", description: "Latest model." },
          { value: "opus", name: "Opus" },
        ],
      },
    ],
    "model",
  );
  expect(choices).toHaveLength(3);
  await cache.update("claude", "model", choices ?? []);

  const reloaded = await AgentOptionsCache.load(path);
  const merged = reloaded.apply("claude", CLAUDE_CONFIG_SCHEMA) as {
    properties: {
      model: {
        oneOf: { const: string; title: string }[];
        default: string;
        _meta?: Record<string, unknown>;
      };
    };
  };
  // The default a new session starts with (Sonnet) stays a choice, though the agent's list has no row of its own for it.
  expect(merged.properties.model.oneOf.map((o) => o.const)).toEqual([
    "default",
    "fabel",
    "opus",
    "sonnet",
  ]);
  expect(merged.properties.model.default).toBe("sonnet");
  expect(merged.properties.model._meta?.[META.open]).toBe(true);
});

test("ignores corrupt cache files and falls back cleanly to static schema", async () => {
  const path = tempPath();
  writeFileSync(path, "{not valid json");
  const cache = await AgentOptionsCache.load(path);
  expect(cache.apply("claude", CLAUDE_CONFIG_SCHEMA)).toBe(CLAUDE_CONFIG_SCHEMA);
});

test("excludes synthetic custom model entries from being cached globally", async () => {
  const path = tempPath();
  const cache = await AgentOptionsCache.load(path);
  const choices = choicesFromConfigOptions(
    [
      {
        configId: "model",
        options: [
          { value: "default", name: "Default model" },
          { value: "fabel", name: "Fabel" },
          { value: "my-private-model", name: "my-private-model", _meta: { "cycle/custom": true } },
        ],
      },
    ],
    "model",
  );
  expect(choices?.map((c) => c.const)).toEqual(["default", "fabel"]);
  await cache.update("claude", "model", choices ?? []);
  await cache.flush();
  const reloaded = await AgentOptionsCache.load(path);
  const merged = reloaded.apply("claude", CLAUDE_CONFIG_SCHEMA) as {
    properties: { model: { oneOf: { const: string }[] } };
  };
  // (The default, Sonnet, is kept as a choice at the end: see the first test.)
  expect(merged.properties.model.oneOf.map((o) => o.const)).toEqual(["default", "fabel", "sonnet"]);
});

test("keeps each model's effort levels, so a new session knows which models take effort before any process", async () => {
  const path = tempPath();
  const cache = await AgentOptionsCache.load(path);
  const choices = choicesFromConfigOptions(
    [
      {
        configId: "model",
        name: "Model",
        options: [
          { value: "default", name: "Default model" },
          { value: "opus", name: "Opus", _meta: { [META.efforts]: ["low", "high", "max"] } },
          { value: "haiku", name: "Haiku", _meta: { [META.efforts]: [] } },
          { value: "odd", name: "Odd", _meta: { [META.efforts]: "high" } },
        ],
      },
    ],
    "model",
  );
  await cache.update("claude", "model", choices ?? []);
  const merged = (await AgentOptionsCache.load(path)).apply("claude", CLAUDE_CONFIG_SCHEMA) as {
    properties: { model: { oneOf: { const: string; _meta?: Record<string, unknown> }[] } };
  };
  const efforts = Object.fromEntries(
    merged.properties.model.oneOf.map((o) => [o.const, o._meta?.[META.efforts]]),
  );
  // Not said, or said in a shape that is not a list: not known.
  expect(efforts).toEqual({
    default: undefined,
    opus: ["low", "high", "max"],
    haiku: [],
    odd: undefined,
  });
});

test("a cache written before effort levels were kept still loads", async () => {
  const path = tempPath();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      agents: { claude: { model: [{ const: "opus", title: "Opus" }] } },
    }),
  );
  const merged = (await AgentOptionsCache.load(path)).apply("claude", CLAUDE_CONFIG_SCHEMA) as {
    properties: { model: { oneOf: Record<string, unknown>[] } };
  };
  expect(merged.properties.model.oneOf).toEqual([
    { const: "opus", title: "Opus" },
    // The default a new session starts with, kept as a choice.
    { const: "sonnet", title: "Sonnet", description: "Balanced speed for everyday coding." },
  ]);
});

test("a model list that does not say effort levels keeps the ones an earlier list said", async () => {
  const cache = await AgentOptionsCache.load(tempPath());
  await cache.update("claude", "model", [
    { const: "opus", title: "Opus", efforts: ["high"] },
    { const: "haiku", title: "Haiku", efforts: [] },
  ]);
  // The adapter's fallback list, before the SDK's catalog: names only.
  await cache.update("claude", "model", [
    { const: "opus", title: "Opus" },
    { const: "sonnet", title: "Sonnet" },
  ]);
  const merged = cache.apply("claude", CLAUDE_CONFIG_SCHEMA) as {
    properties: { model: { oneOf: { const: string; _meta?: Record<string, unknown> }[] } };
  };
  expect(
    Object.fromEntries(
      merged.properties.model.oneOf.map((o) => [o.const, o._meta?.[META.efforts]]),
    ),
  ).toEqual({ opus: ["high"], sonnet: undefined });
});

test("the adapter writes effort levels and the context's parts under the keys the protocol names", () => {
  expect(EFFORTS_META).toBe(META.efforts);
  expect(CONTEXT_META).toBe(META.context);
  expect(PLAN_USAGE_UPDATE).toBe(PLAN_USAGE);
});
