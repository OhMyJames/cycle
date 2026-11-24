// The app a client talks to: one connection's view of the daemon (CYCL-262, D-01). Each part of the protocol is
// registered by its own module, all on the daemon's `Core`; this only puts them together.
import { type AgentApp, agent as acpAgent } from "@agentclientprotocol/sdk/experimental/v2";
import type { ClientConn } from "../session.ts";
import { registerAgentSetup } from "./agent-setup.ts";
import { registerAgents } from "./agents.ts";
import { registerAttach } from "./attach.ts";
import { registerConnection } from "./connection.ts";
import { registerConnectors } from "./connectors.ts";
import type { Core, Me } from "./core.ts";
import { registerFiles } from "./files.ts";
import { registerPlugins } from "./plugins.ts";
import { registerPrompts } from "./prompts.ts";
import { registerProviders } from "./providers.ts";
import { registerSessions } from "./sessions.ts";
import { registerTerminals } from "./terminals.ts";
import { registerTrust } from "./trust.ts";

/** The app for one connection. `holder` gets the connection's client once it is connected. */
export const facing = (core: Core, holder: { value?: ClientConn }): AgentApp => {
  const me: Me = () => {
    if (holder.value === undefined) throw new Error("connection not ready");
    return holder.value;
  };
  const app = acpAgent({ name: "cycle" });
  registerConnection(app, core, me);
  registerSessions(app, core);
  registerAttach(app, core, me);
  registerPrompts(app, core, me);
  registerAgents(app, core);
  registerAgentSetup(app, core, me);
  registerFiles(app, core);
  registerTerminals(app, core, me);
  registerTrust(app, core);
  registerPlugins(app, core);
  registerConnectors(app, core);
  registerProviders(app, core);
  return app;
};
