import { CHILD_UPDATE, META, ToolResultSchema } from "@cycle/protocol";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A tool call's `_meta["cycle/toolResult"]` as it may be kept: as the agent sent it when it matches `ToolResultSchema`
 * (counts and flags only, docs/protocol.md §9), else left out. Checked once, where a record goes into the log, so a
 * client never sees one that does not match and need not check it again. A record without one comes back as it is.
 */
export const checkToolResult = (kind: string, data: unknown): unknown => {
  // A sub-agent's call (docs/protocol.md §9) is checked as any other, inside the record that carries it.
  if (kind === "update" && isObject(data) && data.sessionUpdate === CHILD_UPDATE) {
    const update = checkToolResult(kind, data.update);
    return update === data.update ? data : { ...data, update };
  }
  if (kind !== "update" || !isObject(data) || data.sessionUpdate !== "tool_call_update")
    return data;
  const meta = data._meta;
  if (!isObject(meta) || !(META.toolResult in meta)) return data;
  if (ToolResultSchema.safeParse(meta[META.toolResult]).success) return data;
  const { [META.toolResult]: _dropped, ...rest } = meta;
  const { _meta: _old, ...update } = data;
  return Object.keys(rest).length > 0 ? { ...update, _meta: rest } : update;
};
