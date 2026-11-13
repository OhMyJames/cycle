import { modelInfos, modelRef, piModel, splitModelRef, startGateway } from "@cycle/gateway";
import type { ExtraProvider } from "@cycle/harness-codex";
import type { ProvidersFile } from "./providers.ts";
import { JsonStore, type TextFile } from "./store.ts";

export interface OpenProviders {
  store: JsonStore<ProvidersFile>;
  /** What the codex harness needs to run sessions on the owner's providers. */
  provider: ExtraProvider;
  stop(): void;
}

/**
 * Opens the owner's providers and the gateway that answers codex for them.
 * Both read the same store, so a provider saved in the page serves its next
 * request with nothing started again.
 */
export async function openProviders(file: TextFile, token: string): Promise<OpenProviders> {
  const store = await JsonStore.open<ProvidersFile>(file, { providers: [] });
  const gateway = startGateway({
    token,
    resolve(ref) {
      const parts = splitModelRef(ref);
      const config = parts && store.value.providers.find(({ id }) => id === parts.providerId);
      const model = config && parts ? piModel(config, parts.modelId) : null;
      return config && model ? { model, apiKey: config.apiKey } : null;
    },
  });
  return {
    store,
    provider: {
      id: "cycle",
      name: "Cycle",
      baseUrl: gateway.url,
      token,
      models: () =>
        store.value.providers.flatMap((config) => {
          const windows = new Map(
            config.models.map((model) => [modelRef(config.id, model.id), model.contextWindow]),
          );
          return modelInfos(config).map((info) => ({
            info,
            contextWindow: windows.get(info.id) ?? 0,
          }));
        }),
    },
    stop: () => gateway.stop(),
  };
}
