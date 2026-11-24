// The owner's model providers (docs/adapters/codex.md "自带模型"): list, change, remove. A key goes in once; no answer holds one.
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import { providersCatalog, providersList, providersRemove, providersSave } from "@cycle/protocol";
import { type Core, cycleOn } from "./core.ts";

export const registerProviders = (app: AgentApp, core: Core): void => {
  const cycle = cycleOn(app, core.log);
  cycle(providersList, () => ({
    providers: core.providers.list(),
    kinds: core.providers.kinds(),
  }));
  cycle(providersCatalog, (params) => ({ models: core.providers.catalog(params.kind) }));
  cycle(providersSave, async (params) => ({
    provider: await core.providers.save(params.provider),
  }));
  cycle(providersRemove, async (params) => {
    await core.providers.remove(params.id);
    return {};
  });
};
