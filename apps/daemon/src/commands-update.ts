/** Whether this is the agent's list of commands (`available_commands_update`, docs/protocol.md §12). */
export const isCommandsData = (data: unknown): boolean =>
  typeof data === "object" &&
  data !== null &&
  (data as { sessionUpdate?: unknown }).sessionUpdate === "available_commands_update";

/** What a list of commands is compared by: the JSON as written. */
export const commandsKey = (data: unknown): string => JSON.stringify(data);
