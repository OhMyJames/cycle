import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBundledModels,
  type ProviderModel,
  providerCatalogDocument,
  providerThreadConfig,
  writeProviderCatalog,
} from "../src/providers.ts";

const ownModel = (
  id: string,
  efforts: string[],
  contextWindow: number,
  provider = { id: "acme", name: "Acme" },
): ProviderModel => ({
  id,
  name: id,
  description: "Acme",
  efforts: efforts.map((effort) => ({ id: effort, description: "" })),
  defaultEffort: efforts[0] ?? null,
  images: false,
  contextWindow,
  provider,
});

const bundled = [
  {
    slug: "gpt-5.6-sol",
    model_messages: { instructions_template: "the bundled instructions" },
  },
];

test("a provider catalog says every model's real window and efforts, and carries no gateway credential", () => {
  const document = providerCatalogDocument(
    [
      ownModel("acme/fast", ["low", "high", "max"], 1_000_000),
      ownModel("acme/small", ["low"], 64_000),
      ownModel("deepseek/deepseek-flash", ["low", "high", "max"], 1_000_000, {
        id: "deepseek",
        name: "DeepSeek",
      }),
    ],
    bundled,
  );
  expect(document.models).toMatchObject([
    {
      slug: "acme/fast",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 95,
      supports_search_tool: true,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
      model_messages: { instructions_template: "the bundled instructions" },
    },
    {
      slug: "acme/small",
      context_window: 64_000,
      max_context_window: 64_000,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      supports_parallel_tool_calls: null,
      tool_mode: null,
      auto_compact_token_limit: null,
    },
    {
      slug: "deepseek/deepseek-flash",
      support_verbosity: true,
      default_verbosity: "high",
      apply_patch_tool_type: "freeform",
      supports_parallel_tool_calls: true,
      tool_mode: null,
      auto_compact_token_limit: 500_000,
    },
  ]);
  expect(document.models.map((model) => model.slug)).toEqual([
    "acme/fast",
    "acme/small",
    "deepseek/deepseek-flash",
  ]);
  const config = providerThreadConfig(
    {
      url: "http://127.0.0.1:4000/v1",
      token: "gw-token",
      models: [],
    },
    "/tmp/models.json",
  );
  expect(config).toMatchObject({
    model_catalog_json: "/tmp/models.json",
    "shell_environment_policy.exclude": ["CYCLE_PROVIDER_TOKEN"],
  });
  expect(JSON.stringify({ document, config })).not.toContain("gw-token");
});

test("a DeepSeek compact limit never exceeds the model's effective window", () => {
  const document = providerCatalogDocument(
    [
      ownModel("deepseek/flash", ["high"], 1_000_000, {
        id: "deepseek",
        name: "DeepSeek",
      }),
      ownModel("deepseek/small", ["high"], 64_000, {
        id: "deepseek",
        name: "DeepSeek",
      }),
    ],
    bundled,
  );
  expect(document.models.map((model) => model.auto_compact_token_limit)).toEqual([500_000, 60_800]);
});

test("the bundled catalog is read from the pinned executable in CODEX_HOME without the gateway token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-bundled-"));
  const codexHome = join(dir, "codex-home");
  await mkdir(codexHome, { recursive: true });
  const executable = join(dir, "fake-codex"),
    token = join(dir, "token"),
    seenCwd = join(dir, "cwd");
  await writeFile(
    executable,
    `#!${process.execPath}
import {writeFileSync} from "node:fs";
if (process.argv.slice(2).join(" ") !== "debug models --bundled") process.exit(2);
writeFileSync(${JSON.stringify(token)}, process.env.CYCLE_PROVIDER_TOKEN ?? "absent");
writeFileSync(${JSON.stringify(seenCwd)}, process.cwd());
console.log(JSON.stringify({models:${JSON.stringify(bundled)}}));
`,
    { mode: 0o700 },
  );
  try {
    const models = await loadBundledModels({
      codexExecutable: executable,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        CODEX_HOME: codexHome,
        CYCLE_PROVIDER_TOKEN: "gw-token",
      },
    });
    expect(models).toEqual(bundled);
    expect(await readFile(token, "utf8")).toBe("absent");
    expect(await realpath(await readFile(seenCwd, "utf8"))).toBe(await realpath(codexHome));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a catalog file is private and is written where the thread can read it", async () => {
  const written = await writeProviderCatalog({ models: [] });
  try {
    expect((await stat(written.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(written.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(written.path, "utf8"))).toEqual({ models: [] });
  } finally {
    await rm(written.dir, { recursive: true, force: true });
  }
});
