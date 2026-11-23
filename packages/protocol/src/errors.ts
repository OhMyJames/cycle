/**
 * Cycle's own JSON-RPC error codes. They sit in -32010..-32019, clear of the codes ACP v2 uses
 * (-32700, -32600..-32603, -32800, -32000, -32002, -32022). A session that does not exist, or is
 * not Cycle's, is ACP's -32002 with its `SessionNotFoundErrorData`; an unsupported protocol
 * version is ACP's -32022.
 */
export const CycleErrorCode = {
  SessionBusy: -32010,
  AgentUnavailable: -32011,
  AgentExited: -32012,
  ResumeFailed: -32013,
  InvalidConfig: -32014,
  LogUnavailable: -32015,
  NotQueued: -32016,
  /** A connector's authorization server or upstream refused or could not be reached (docs/protocol.md §14). */
  ConnectorFailed: -32017,
  /** The daemon stopped while the turn was running: the turn's end on record says so (docs/protocol.md §8). */
  DaemonStopped: -32018,
  /** A session or the daemon has as many terminals as it may (docs/protocol.md §8 "终端"). */
  TerminalLimit: -32019,
} as const;
export type CycleErrorCode = (typeof CycleErrorCode)[keyof typeof CycleErrorCode];

/** Codes ACP v2 defines. A test checks that no Cycle code collides with one. */
export const ACP_ERROR_CODES = [
  -32700, -32600, -32601, -32602, -32603, -32800, -32000, -32002, -32022,
] as const;
