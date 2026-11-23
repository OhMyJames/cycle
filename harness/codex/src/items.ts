import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { ThreadItem } from "./wire.generated.ts";

export function itemUpdate(
  item: ThreadItem,
  completed: boolean,
  streamed: boolean,
  planId?: string,
): SessionUpdate | undefined {
  if (item.type === "plan" && completed)
    return {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: planId ?? item.id,
        entries: [
          {
            content: item.text,
            priority: "medium",
            status: completed ? "completed" : "in_progress",
          },
        ],
      },
    } as SessionUpdate;
  if (item.type === "collabAgentToolCall")
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: item.id,
      name: item.tool,
      kind: "other",
      status: completed
        ? item.status === "failed" || item.status === "interrupted"
          ? "failed"
          : "completed"
        : "in_progress",
      rawInput: item.prompt ? { prompt: item.prompt, model: item.model } : undefined,
    };
  // The call that started a sub-agent: what its `subagent_update` points to. Its other activity (given input,
  // done) is told as the sub-agent's state, not as calls.
  if (item.type === "subAgentActivity") {
    if (item.kind !== "started") return;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: item.id,
      name: "spawn_agent",
      title: item.agentPath.split("/").filter(Boolean).at(-1) ?? item.agentPath,
      kind: "other",
      status: completed ? "completed" : "in_progress",
      rawInput: { agentPath: item.agentPath, ...(item.model ? { model: item.model } : {}) },
    };
  }
  if (item.type === "agentMessage" || item.type === "reasoning") {
    if (!completed || streamed) return;
    const text =
      item.type === "agentMessage" ? item.text : [...item.summary, ...item.content].join("\n");
    if (!text) return;
    return {
      sessionUpdate: item.type === "agentMessage" ? "agent_message" : "agent_thought",
      messageId: item.id,
      content: [{ type: "text", text }],
    } as SessionUpdate;
  }
  let title: string | undefined;
  let name: string, kind: "execute" | "edit" | "search" | "other", output: string | undefined;
  switch (item.type) {
    case "commandExecution":
      name = "exec_command";
      title = item.command;
      kind = "execute";
      output = item.aggregatedOutput ?? undefined;
      break;
    case "mcpToolCall":
      name = `${item.server}/${item.tool}`;
      kind = "other";
      output = completed ? JSON.stringify(item.error?.message ?? item.result?.content) : undefined;
      break;
    case "fileChange":
      name = "Edit files";
      kind = "edit";
      output = item.changes.map((c) => c.diff).join("\n");
      break;
    case "webSearch":
      name = "web_search";
      title = item.query;
      kind = "search";
      break;
    default:
      return;
  }
  const failed = "status" in item && (item.status === "failed" || item.status === "declined");
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: item.id,
    name,
    ...(title ? { title } : {}),
    kind,
    status: completed ? (failed ? "failed" : "completed") : "in_progress",
    ...(output ? { content: [{ type: "content", content: { type: "text", text: output } }] } : {}),
  };
}
