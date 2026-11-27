// Structured Work loop heartbeats (CYC-484): written into SQLite `heartbeats` so the supervisor can detect stalled
// workers or overdue turns/commands without parsing logs.

import { SqliteStore } from "../db/store.ts";
import type { LoopStore } from "../store.ts";
import type { Config } from "../types.ts";

export type WaitingOn = "session" | "ci" | "merge" | "person" | "tracker" | "command" | "idle";

export type HeartbeatPayload = {
  worker?: string;
  phase: string;
  waitingOn: WaitingOn;
  deadline: string | null;
  pid?: number;
};

/** Special heartbeat key written when a worker is idle between steps. */
export const WORKER_BEAT_KEY = "__worker__";

const MINUTE = 60_000;

/** Computes the overdue deadline for a wait kind, or null when waiting on a person or idle. */
export const deadlineFor = (
  waitingOn: WaitingOn,
  now: Date,
  config: Pick<Config, "turnTimeoutMs" | "commandTimeoutMs" | "ciTimeoutMs" | "mergeTimeoutMs">,
): string | null => {
  const ms = now.getTime();
  switch (waitingOn) {
    case "session":
      return new Date(ms + config.turnTimeoutMs + 5 * MINUTE).toISOString();
    case "command":
      return new Date(ms + config.commandTimeoutMs + 2 * MINUTE).toISOString();
    case "ci":
      return new Date(ms + config.ciTimeoutMs + 5 * MINUTE).toISOString();
    case "merge":
      return new Date(ms + config.mergeTimeoutMs + 5 * MINUTE).toISOString();
    case "person":
    case "idle":
    case "tracker":
      return null;
  }
};

/** Writes a structured heartbeat when the backing store is SQLite; no-op for legacy file stores. */
export const recordHeartbeat = (
  store: LoopStore,
  runKey: string,
  payload: HeartbeatPayload,
): void => {
  if (!(store instanceof SqliteStore)) return;
  store.beat(runKey, JSON.stringify({ ...payload, pid: payload.pid ?? process.pid }));
};

/** Parses the JSON detail written by `recordHeartbeat`; returns null for legacy plain-text details. */
export const parseHeartbeat = (detail: string | null): HeartbeatPayload | null => {
  if (detail === null || !detail.startsWith("{")) return null;
  try {
    const raw = JSON.parse(detail) as Record<string, unknown>;
    if (typeof raw.phase !== "string" || typeof raw.waitingOn !== "string") return null;
    return {
      ...(typeof raw.worker === "string" ? { worker: raw.worker } : {}),
      phase: raw.phase,
      waitingOn: raw.waitingOn as WaitingOn,
      deadline: typeof raw.deadline === "string" ? raw.deadline : null,
      ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
    };
  } catch {
    return null;
  }
};
