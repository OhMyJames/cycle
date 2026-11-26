// The connection itself (docs/protocol.md §3): `initialize`, where a client says what it can do and is told what the
// daemon can.

import { rename, writeFile } from "node:fs/promises";
import { type AgentApp, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { CYCLE_PROTOCOL_VERSION, META } from "@cycle/protocol";
import { appVersionPath } from "../data-dir.ts";
import { RpcError, UNSUPPORTED_VERSION } from "../errors.ts";
import { VERSION_FORMAT } from "../version.ts";
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
    // Only a client this daemon accepts says what the app is. Best effort: nothing depends on it being written.
    const appVersion = params._meta?.[META.appVersion];
    if (typeof appVersion === "string" && VERSION_FORMAT.test(appVersion)) {
      const path = appVersionPath(core.dataDir);
      // Written aside and renamed over, so a reader never sees half of it.
      const aside = `${path}.${process.pid}.tmp`;
      writeFile(aside, `${appVersion}\n`, { mode: 0o600 })
        .then(() => rename(aside, path))
        .catch((error: unknown) =>
          core.log.warn("app_version_not_saved", { error: String(error) }),
        );
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
          storage: true,
          agentPrewarm: true,
          sessionMentions: true,
          terminal: true,
          environments: true,
          worktrees: true,
          vault: true,
        },
      },
    };
  });
};
