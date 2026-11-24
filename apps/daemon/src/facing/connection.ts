// The connection itself (docs/protocol.md §3): `initialize`, where a client says what it can do and is told what the
// daemon can.
import { type AgentApp, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { CYCLE_PROTOCOL_VERSION, META } from "@cycle/protocol";
import { RpcError, UNSUPPORTED_VERSION } from "../errors.ts";
import type { Core, Me } from "./core.ts";

export const registerConnection = (app: AgentApp, core: Core, me: Me): void => {
  app.onRequest(methods.agent.initialize, async ({ params }) => {
    const requested = (params._meta as Record<string, unknown> | null | undefined)?.[
      META.protocolVersion
    ];
    // Whether this client can answer a form: only then is it asked one (decision 0011).
    me().ackReturns = params._meta?.[META.ackReturns] === true;
    me().elicitation = params.capabilities?.elicitation?.form != null;
    if (
      typeof requested === "string" &&
      requested.split(".")[0] !== CYCLE_PROTOCOL_VERSION.split(".")[0]
    ) {
      throw new RpcError(UNSUPPORTED_VERSION, "Unsupported Cycle protocol version", {
        supported: [CYCLE_PROTOCOL_VERSION],
        requested,
      });
    }
    return {
      protocolVersion: 2,
      info: { name: "cycle", version: core.version },
      capabilities: { session: {} },
      _meta: {
        [META.protocolVersion]: CYCLE_PROTOCOL_VERSION,
        [META.capabilities]: {
          replay: ["start", "_cycle.seq"],
          agents: [...core.agents.keys()],
          sessionListPages: true,
          sessionOps: ["archive", "rename", "delete", "markRead", "stopSubagent"],
          queue: true,
          steer: true,
          files: true,
          folders: true,
          filesInFolder: true,
          fs: true,
          diff: true,
          trust: true,
          connectors: true,
          plugins: core.plugins.agents(),
          planUsage: true,
          agentSetup: true,
          sessionMentions: true,
          terminal: true,
          environments: true,
          worktrees: true,
        },
      },
    };
  });
};
