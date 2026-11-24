import { isAbsolute } from "node:path";
import { LineJsonRpcProcess, type LineRpcOptions, RpcError } from "@cycle/line-rpc";
import { CODEX_FIXED_ARGS, CODEX_VERSION } from "./protocol.ts";

export type AdapterConfig = {
  env: Record<string, string>;
  codexExecutable: string;
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
    args: [...CODEX_FIXED_ARGS, "-c", "check_for_update_on_startup=false", "app-server"],
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
