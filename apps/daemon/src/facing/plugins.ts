// Plugins (docs/protocol.md §15): each agent's own, done by that agent's machinery.
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import {
  pluginSourcesAdd,
  pluginSourcesRefresh,
  pluginSourcesRemove,
  pluginsAvailable,
  pluginsInstall,
  pluginsList,
  pluginsSetEnabled,
  pluginsUninstall,
  pluginsUpdate,
} from "@cycle/protocol";
import { type Core, cycleOn } from "./core.ts";

export const registerPlugins = (app: AgentApp, core: Core): void => {
  const cycle = cycleOn(app, core.log);
  cycle(pluginsList, (params) => core.plugins.list(params.agentId));
  cycle(pluginsAvailable, (params) => core.plugins.available(params));
  cycle(pluginsInstall, async (params) => ({
    plugin: await core.plugins.install(params.agentId, params.id),
  }));
  cycle(pluginsUninstall, async (params) => {
    await core.plugins.uninstall(params.agentId, params.id);
    return {};
  });
  cycle(pluginsUpdate, (params) => core.plugins.update(params.agentId, params.id));
  cycle(pluginsSetEnabled, async (params) => ({
    plugin: await core.plugins.setEnabled(params.agentId, params.id, params.enabled),
  }));
  cycle(pluginSourcesAdd, async (params) => ({
    source: await core.plugins.addSource(params.agentId, params.location),
  }));
  cycle(pluginSourcesRemove, async (params) => {
    await core.plugins.removeSource(params.agentId, params.id);
    return {};
  });
  cycle(pluginSourcesRefresh, async (params) => {
    await core.plugins.refreshSource(params.agentId, params.id);
    return {};
  });
};
