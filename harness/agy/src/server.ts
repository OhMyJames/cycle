import { isAbsolute } from "node:path";
import { LineJsonRpcProcess, type LineRpcOptions, RpcError } from "@cycle/line-rpc";

export type AdapterConfig = {
  /** Explicit environment given to `agy`; nothing is inherited from the adapter process. */
  env: Record<string, string>;
  /** Absolute path to the `agy` executable (if resolved at startup). */
  agyExecutable: string;
  /** Fallback absolute paths checked if `agy` is installed after the daemon starts (never inherited). */
  fallbackExecutables?: string[];
  /** When `false`, `agy` is not looked up on `PATH` (an explicitly configured executable never falls back elsewhere). */
  searchPath?: boolean;
  /** Optional `--log-file` path passed to `agy acp`. */
  logFile?: string;
  /** Pass `--sandbox` to `agy acp`. */
  sandbox?: boolean;
  /** Pass `--agent <name>` to `agy acp`. */
  agent?: string;
  /** When explicitly `false`, pass `--disable-telemetry` to `agy acp`. */
  telemetry?: boolean;
  /** Pass `--dangerously-skip-permissions` to `agy acp`: every tool call is approved without asking. */
  skipPermissions?: boolean;
  /** Optional factory replacing the spawned child process (for in-process unit tests or alternate transports). */
  connect?: (handlers: AgyServerHandlers) => AgyTransport;
  /** Called if the underlying `agy acp` process terminates unexpectedly. */
  onServerExit?: () => void;
  /** How long `session/cancel` waits for `agy` to settle an in-flight prompt before forcing cancellation. */
  cancelTimeoutMs?: number;
  /** Quiet window (ms) before closing a synthesized autonomous turn that had no in-flight prompt. */
  autonomousIdleMs?: number;
};

export type AgyServerHandlers = {
  onNotification: (method: string, params: unknown) => void;
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onExit: (error: Error) => void;
};

export type AgyTransport = {
  request: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  notify: (method: string, params: unknown) => void;
  close: (reason?: Error) => void;
  readonly closed: boolean;
};

/** An error answer from agy, or one a request handler gives it (with the code it is answered with). */
export { RpcError as AgyRpcError };

export const buildAgyArgs = (config: AdapterConfig): string[] => {
  const args = ["acp", "--process-per-session"];
  if (config.logFile) args.push("--log-file", config.logFile);
  if (config.sandbox) args.push("--sandbox");
  if (config.agent) args.push("--agent", config.agent);
  if (config.telemetry === false) args.push("--disable-telemetry");
  if (config.skipPermissions === true) args.push("--dangerously-skip-permissions");
  return args;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const options = (config: AdapterConfig): LineRpcOptions => {
  if (!config.env.HOME || !isAbsolute(config.env.HOME) || !isAbsolute(config.agyExecutable)) {
    throw new Error("agy needs an explicit absolute HOME and executable");
  }
  return {
    name: "agy acp",
    executable: config.agyExecutable,
    args: buildAgyArgs(config),
    cwd: config.env.HOME,
    env: config.env,
    jsonrpc: true,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };
};

export class AgyProcess extends LineJsonRpcProcess implements AgyTransport {
  constructor(config: AdapterConfig, handlers: AgyServerHandlers) {
    super(options(config), handlers);
  }
}
