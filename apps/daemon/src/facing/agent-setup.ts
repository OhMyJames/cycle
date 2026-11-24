// An agent's setup and account (docs/protocol.md §16, CYCL-226): what is known of its binary and sign-in, its runtime
// settings, and signing in and out. A sign-in flow is the connection's that started it: only it may answer or cancel.
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import {
  agentAuthCancel,
  agentAuthLogout,
  agentAuthStart,
  agentAuthSubmit,
  agentSetupRead,
  agentSetupSetRuntime,
} from "@cycle/protocol";
import { type Core, cycleOn, type Me } from "./core.ts";

export const registerAgentSetup = (app: AgentApp, core: Core, me: Me): void => {
  const cycle = cycleOn(app, core.log);
  cycle(agentSetupRead, (params) => core.readAgentSetup(params));
  cycle(agentSetupSetRuntime, (params) => core.setAgentRuntime(params));
  cycle(agentAuthStart, (params) => core.startAgentAuth(me().id, params));
  cycle(agentAuthSubmit, (params) => core.submitAgentAuth(me().id, params));
  cycle(agentAuthCancel, (params) => core.cancelAgentAuth(me().id, params));
  cycle(agentAuthLogout, (params) => core.logoutAgent(params));
};
