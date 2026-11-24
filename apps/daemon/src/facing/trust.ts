// Trusting a folder (docs/protocol.md §8 "信任文件夹"): a changed decision restarts the agents working in it, once
// each has nothing to do.
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import { trustRead, trustSet } from "@cycle/protocol";
import { realFolder } from "../trust-file.ts";
import { type Core, cycleOn } from "./core.ts";

export const registerTrust = (app: AgentApp, core: Core): void => {
  const cycle = cycleOn(app, core.log);
  cycle(trustRead, async (params) => core.trust.of(await realFolder(params.path)));
  cycle(trustSet, async (params) => {
    const real = await realFolder(params.path);
    const trust = await core.trust.set(real, params.trusted);
    await core.applyTrust(real);
    return trust;
  });
};
