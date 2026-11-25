// The owner's own models in a Codex session (docs/adapters/codex.md "自带模型"). A thread stays with the model provider
// it began on, so a session is on Codex's own models or on the owner's, chosen when it begins and kept for its life.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "./settings.ts";

/** The environment variable that holds the gateway's token, in the app-server's environment alone. */
export const PROVIDER_TOKEN_ENV = "CYCLE_PROVIDER_TOKEN";

/** The id of the model provider Codex is told of: the gateway, whichever of the owner's services answers. */
const CODEX_PROVIDER_ID = "cycle";

/**
 * The bundled model whose instructions a provider's models use. It is one Codex already knows, so its instructions ship
 * with the same pinned binary; the model fields itself are replaced below. It is the smaller current template, around a
 * thousand tokens less than `gpt-5.5`'s.
 */
const INSTRUCTIONS_MODEL = "gpt-5.6-sol";

/** DeepSeek's own Codex integration names this provider; its model and tool behavior gets tuned together. */
const DEEPSEEK_PROVIDER_ID = "deepseek";

/** The most context Codex keeps before compacting a DeepSeek thread. The model reads 1M, but replaying that much through
 * every tool turn is the expensive part. */
const DEEPSEEK_AUTO_COMPACT_TOKEN_LIMIT = 500_000;

/** What a thread of the owner's models learns about them, from the Codex binary's own bundled catalog. */
export type BundledModel = {
  slug: string;
  model_messages?: { instructions_template?: string | null } | null;
  base_instructions?: string | null;
};

/** One of the owner's models, as the daemon describes it. `id` is `<provider id>/<model id>`. */
export type ProviderModel = {
  id: string;
  name: string;
  /** The provider's name. */
  description: string;
  efforts: { id: string; description: string }[];
  defaultEffort: string | null;
  images: boolean;
  contextWindow: number;
  provider: { id: string; name: string };
};

/** Where the owner's models are asked, and which there are. The daemon's gateway listens on this machine only. */
export type AdapterProviders = {
  url: string;
  token: string;
  models: ProviderModel[];
};

/** The menu of a session on the owner's models: what `model/list` is for a session on Codex's own. */
export const providerCatalog = (models: readonly ProviderModel[]): CatalogModel[] =>
  models.map((model) => ({
    model: model.id,
    displayName: model.name,
    description: model.description,
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: model.efforts.map((effort) => ({
      reasoningEffort: effort.id,
      description: effort.description || effort.id,
    })),
    defaultReasoningEffort: model.defaultEffort,
    provider: model.provider,
  }));

const instructionsOf = (bundled: readonly BundledModel[]): string => {
  const template =
    bundled.find((model) => model.slug === INSTRUCTIONS_MODEL) ??
    bundled.find((model) => model.slug === "gpt-5.5") ??
    bundled.find((model) => model.model_messages?.instructions_template || model.base_instructions);
  const instructions =
    template?.model_messages?.instructions_template ?? template?.base_instructions;
  if (!instructions)
    throw new Error(`Codex ${INSTRUCTIONS_MODEL} has no instructions in its bundled model catalog`);
  return instructions;
};

/**
 * What Codex's own catalog would say of every model of the owner's. Codex does not know any of them: without this it
 * assumes its 272K fallback and clips even `model_context_window` to it. A catalog entry carries the real window, and
 * the efforts its provider supports, and enables `supports_search_tool` (matching every bundled Codex model) so MCP,
 * sub-agent and `codex_apps` tools stay deferred behind `tool_search` instead of inflating every request by >100K
 * tokens. DeepSeek follows its own Codex catalog's parallel calls and freeform patch. Code mode was measured and made
 * requests and context larger, so it stays on direct tools. Other providers also keep the direct tool set.
 */
export const providerCatalogDocument = (
  models: readonly ProviderModel[],
  bundled: readonly BundledModel[],
) => {
  const instructions = instructionsOf(bundled);
  return {
    models: models.map((model, index) => {
      const deepseek = model.provider.id === DEEPSEEK_PROVIDER_ID;
      return {
        slug: model.id,
        display_name: model.name,
        description: model.description,
        default_reasoning_level: model.defaultEffort,
        supported_reasoning_levels: model.efforts.map((effort) => ({
          effort: effort.id,
          description: effort.description || effort.id,
        })),
        shell_type: "unified_exec",
        visibility: "none" as const,
        supported_in_api: true,
        priority: 99 + index,
        additional_speed_tiers: [],
        service_tiers: [],
        available_access_programs: null,
        availability_nux: null,
        upgrade: null,
        model_messages: { instructions_template: instructions },
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
        default_reasoning_summary: "auto",
        support_verbosity: deepseek,
        default_verbosity: deepseek ? "high" : null,
        apply_patch_tool_type: deepseek ? "freeform" : null,
        web_search_tool_type: "text",
        truncation_policy: { mode: "bytes", limit: 10_000 },
        supports_image_detail_original: false,
        context_window: model.contextWindow,
        max_context_window: model.contextWindow,
        auto_compact_token_limit: deepseek
          ? Math.min(DEEPSEEK_AUTO_COMPACT_TOKEN_LIMIT, Math.floor(model.contextWindow * 0.95))
          : null,
        comp_hash: null,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: model.images ? ["text", "image"] : ["text"],
        supports_search_tool: true,
        supports_parallel_tool_calls: deepseek ? true : null,
        supports_experimental_context: false,
        use_responses_lite: false,
        supports_reasoning_effort_updates: false,
        node_repl_auto_review_required: false,
        node_repl_disabled: false,
        tool_mode: null,
        multi_agent_version: null,
        multi_agent_reasoning_effort: null,
      };
    }),
  };
};

/**
 * Reads the pinned Codex binary's bundled catalog. `--bundled` keeps third-party providers and the person's own catalog
 * out of it: this only needs a model's instructions, and nothing from the person's account. The gateway token is not in
 * this process's environment.
 */
export async function loadBundledModels(config: {
  codexExecutable: string;
  env: Record<string, string>;
}): Promise<BundledModel[]> {
  const env = { ...config.env };
  delete env[PROVIDER_TOKEN_ENV];
  const child = Bun.spawn([config.codexExecutable, "debug", "models", "--bundled"], {
    cwd: env.HOME ?? process.cwd(),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error("Codex did not list its bundled models in 20 seconds");
    if (code !== 0)
      throw new Error(
        `Codex could not list its bundled models (${code}): ${stderr.trim().slice(0, 500)}`,
      );
    const parsed = JSON.parse(stdout) as { models?: unknown };
    if (!Array.isArray(parsed.models)) throw new Error("Codex's bundled model catalog is invalid");
    return parsed.models as BundledModel[];
  } finally {
    clearTimeout(timer);
  }
}

/** A catalog file for one thread, in a private directory, removed when the session ends. */
export async function writeProviderCatalog(document: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-catalog-"));
  try {
    await chmod(dir, 0o700);
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    return { dir, path };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * What a thread is started with to run on the owner's models: the gateway as its model provider, and the catalog that
 * tells Codex each model's real window and efforts. Given as the thread's own `config`, never written to the person's
 * `config.toml`.
 */
export const providerThreadConfig = (providers: AdapterProviders, catalogPath: string) => ({
  model_provider: CODEX_PROVIDER_ID,
  model_providers: {
    [CODEX_PROVIDER_ID]: {
      name: "Cycle",
      base_url: providers.url,
      wire_api: "responses",
      env_key: PROVIDER_TOKEN_ENV,
    },
  },
  model_catalog_json: catalogPath,
  // Codex hands its environment to the commands the agent runs. Not the gateway's token.
  "shell_environment_policy.exclude": [PROVIDER_TOKEN_ENV],
});
