import type { NewRecord, SessionLog } from "./log/types.ts";

const isCommands = (data: unknown): boolean =>
  typeof data === "object" &&
  data !== null &&
  (data as { sessionUpdate?: unknown }).sessionUpdate === "available_commands_update";

/** Whether a record about to be written is the agent's list of commands (docs/protocol.md §12). */
export const isCommandsUpdate = (record: NewRecord, data: unknown): boolean =>
  record.kind === "update" && isCommands(data);

/**
 * The last list of commands on a session's log, as the JSON that was written; "" when there is
 * none. Read once per session per run, the first time the agent sends one.
 */
export const lastCommandsOf = async (log: SessionLog): Promise<string> => {
  if (log.lastSeq() === 0) return "";
  const records = await log.read(undefined, { stored: true });
  const found = records.findLast((r) => r.kind === "update" && isCommands(r.data));
  return found === undefined ? "" : JSON.stringify(found.data);
};
