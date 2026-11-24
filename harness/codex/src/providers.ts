// The owner's own models in a Codex session (docs/adapters/codex.md "自带模型"). A thread stays with the model provider
// it began on, so a session is on Codex's own models or on the owner's, chosen when it begins and kept for its life.
import type { CatalogModel } from "./settings.ts";

/** The environment variable that holds the gateway's token, in the app-server's environment alone. */
export const PROVIDER_TOKEN_ENV = "CYCLE_PROVIDER_TOKEN";

/** The id of the model provider Codex is told of: the gateway, whichever of the owner's services answers. */
const CODEX_PROVIDER_ID = "cycle";

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

/**
 * What a thread is started with to run on the owner's models: the gateway as its model provider, and the window of the
 * model it begins with (Codex does not know the model, so it would assume one). Given as the thread's own `config`,
 * never written to the person's `config.toml`.
 */
export const providerThreadConfig = (providers: AdapterProviders, model: ProviderModel) => ({
  model_provider: CODEX_PROVIDER_ID,
  model_providers: {
    [CODEX_PROVIDER_ID]: {
      name: "Cycle",
      base_url: providers.url,
      wire_api: "responses",
      env_key: PROVIDER_TOKEN_ENV,
    },
  },
  model_context_window: model.contextWindow,
  // Codex hands its environment to the commands the agent runs. Not the gateway's token.
  "shell_environment_policy.exclude": [PROVIDER_TOKEN_ENV],
});
