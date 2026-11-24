// The vault (docs/protocol.md §6 "环境"): the keys of `secrets.env`. A value goes in once; no answer holds one.
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import { vaultList, vaultRemove, vaultSet } from "@cycle/protocol";
import { removeSecret, secretKeys, setSecret } from "../secrets.ts";
import { type Core, cycleOn } from "./core.ts";

export const registerVault = (app: AgentApp, core: Core): void => {
  const cycle = cycleOn(app, core.log);
  cycle(vaultList, async () => ({
    items: (await secretKeys(core.dataDir)).map((key) => ({ key })),
  }));
  cycle(vaultSet, async (params) => {
    await setSecret(core.dataDir, params.key, params.value);
    return {};
  });
  cycle(vaultRemove, async (params) => {
    await removeSecret(core.dataDir, params.key);
    return {};
  });
};
