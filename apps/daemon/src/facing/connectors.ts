// Connectors (docs/protocol.md §14): the MCP servers Cycle keeps for every session, and signing in to them.
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import {
  connectorsAdd,
  connectorsAuthClear,
  connectorsAuthFinish,
  connectorsAuthStart,
  connectorsList,
  connectorsRemove,
  connectorsUpdate,
} from "@cycle/protocol";
import { type Core, cycleOn } from "./core.ts";

export const registerConnectors = (app: AgentApp, core: Core): void => {
  const cycle = cycleOn(app, core.log);
  cycle(connectorsList, async () => ({ connectors: await core.connectors.list() }));
  cycle(connectorsAdd, async (params) => ({ connector: await core.connectors.add(params) }));
  cycle(connectorsUpdate, async (params) => ({
    connector: await core.connectors.update(params),
  }));
  cycle(connectorsRemove, async (params) => {
    await core.connectors.remove(params.id);
    return {};
  });
  cycle(connectorsAuthStart, (params) => core.connectors.authStart(params.id, params.redirectUri));
  cycle(connectorsAuthFinish, async (params) => ({
    connector: await core.connectors.authFinish(params),
  }));
  cycle(connectorsAuthClear, async (params) => ({
    connector: await core.connectors.authClear(params.id),
  }));
};
