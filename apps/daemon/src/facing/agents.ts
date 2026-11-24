// The agents (docs/protocol.md §8 "agent"): which there are, the defaults a person set for each, and the plan usage
// each told.
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import {
  agentDefaultsRead,
  agentDefaultsSet,
  agentsList,
  NOTIFICATIONS,
  planUsageRead,
} from "@cycle/protocol";
import { withProviderModels } from "../providers.ts";
import { checkedConfig } from "../session-config.ts";
import { type Core, cycleOn } from "./core.ts";

export const registerAgents = (app: AgentApp, core: Core): void => {
  const cycle = cycleOn(app, core.log);
  cycle(agentsList, async () => ({
    agents: await Promise.all(
      [...core.agents.values()].map(async (a) => ({
        id: a.id,
        name: a.name,
        available: (await a.available?.()) ?? true,
        configSchema: withProviderModels(
          core.optionsCache.apply(a.id, a.configSchema),
          a.providerModels?.() ?? [],
        ),
        ...(a.promptCapabilities !== undefined ? { promptCapabilities: a.promptCapabilities } : {}),
        ...(a.steer === true ? { steer: true } : {}),
      })),
    ),
  }));
  cycle(planUsageRead, () => ({ agents: Object.fromEntries(core.planUsage) }));
  cycle(agentDefaultsRead, (params) => {
    core.definition(params.agent);
    return { config: core.defaults.get(params.agent) };
  });
  cycle(agentDefaultsSet, async (params) => {
    const definition = core.definition(params.agent);
    await core.defaults.set(params.agent, checkedConfig(definition, params.config));
    core.clients.broadcast(NOTIFICATIONS.agentDefaultsChanged, { agent: params.agent });
    return {};
  });
};
