import { isAbsolute } from "node:path";
import { LineJsonRpcProcess, type LineRpcOptions, RpcError } from "@cycle/line-rpc";
import { CODEX_VERSION, codexAppServerArgs } from "./protocol.ts";
import type { AdapterProviders } from "./providers.ts";

export type AdapterConfig = {
  env: Record<string, string>;
  /**
   * The session's environment variables (docs/protocol.md §6 "环境"), for the commands the agent runs. Never the agent's
   * own settings: those are in `env`, the app-server's own, which these never reach: they go to its commands only.
   */
  sessionEnv?: Record<string, string>;
  codexExecutable: string;
  /**
   * Files the agent's commands must not read (the daemon's `secrets.env`, `providers.json`). They are put in the
   * thread's permission profile as `none`, on top of the built-in workspace profile, which is what `sandbox:
   * "workspace-write"` is. Read-only and Full access are not covered: see `denyProfile` in agent.ts.
   */
  denyRead?: string[];
  /** The owner's own models, and the gateway that serves them. Absent: there are none. */
  providers?: AdapterProviders;
  /** The app-server ended while its session was open: nothing more can be done with this adapter. */
  onServerExit?: () => void;
};
/** An error answer from the app-server, or one a request handler gives it (with the code it is answered with). */
export { RpcError as CodexRpcError };

/** How long a call to the app-server waits unless it says otherwise. */
const REQUEST_TIMEOUT_MS = 20_000;

const options = (config: AdapterConfig): LineRpcOptions => {
  if (
    !config.env.HOME ||
    !config.env.CODEX_HOME ||
    !isAbsolute(config.env.HOME) ||
    !isAbsolute(config.env.CODEX_HOME) ||
    !isAbsolute(config.codexExecutable)
  )
    throw new Error("Codex needs an explicit home, config directory and executable");
  return {
    name: "Codex app-server",
    executable: config.codexExecutable,
    args: codexAppServerArgs(),
    cwd: config.env.HOME,
    env: config.env,
    // The app-server's messages are JSON-RPC without the version field.
    jsonrpc: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
};

export class AppServer extends LineJsonRpcProcess {
  constructor(
    config: AdapterConfig,
    onEvent: (method: string, params: unknown) => void,
    onExit: (error: Error) => void,
    onRequest: (method: string, params: unknown) => Promise<unknown>,
  ) {
    super(options(config), { onNotification: onEvent, onRequest, onExit });
  }
  async initialize() {
    const result = await this.request<{ userAgent?: string }>("initialize", {
      clientInfo: { name: "cycle", title: null, version: "1" },
      // `turn/start.collaborationMode` (Codex's plan mode) is experimental in the pinned version.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (typeof result.userAgent !== "string" || !result.userAgent.includes(CODEX_VERSION))
      throw new Error(`Codex app-server version is not the pinned ${CODEX_VERSION}`);
    this.notify("initialized", undefined);
  }
}
