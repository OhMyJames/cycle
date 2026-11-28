import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import type { FileUpdateChange, ThreadItem } from "./wire.generated.ts";

/**
 * The most of a call's output, its title, or its files' diff kept in one update, as the other harnesses keep a patch
 * to (Claude's MAX_PATCH): a build log or a generated file goes on to the daemon's log, the store and the window,
 * every time it is told. What is cut is said in a line of its own, beyond this.
 */
export const MAX_OUTPUT = 100_000;

/** Characters as a person counts them: an emoji is one. */
const count = (text: string): number => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

/** A long output, told by its end: where a command says what went wrong. */
export const outputTail = (text: string): string => {
  if (text.length <= MAX_OUTPUT) return text;
  let cut = text.length - MAX_OUTPUT;
  // Not in the middle of a character told in two halves (an emoji).
  const code = text.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut++;
  return `… ${count(text.slice(0, cut))} earlier characters not shown\n${text.slice(cut)}`;
};

/** A long result or title, told by its start: where it says what it is. */
export const outputHead = (text: string): string => {
  if (text.length <= MAX_OUTPUT) return text;
  let end = MAX_OUTPUT;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}\n… ${count(text.slice(end))} more characters not shown`;
};

/**
 * An MCP result's content blocks: text blocks as text (joined by a line), images as images, and any other block
 * (a resource, a link) as its JSON, so none is dropped.
 */
const mcpResult = (
  content: unknown,
): {
  text: string;
  images: { type: "content"; content: { type: "image"; data: string; mimeType: string } }[];
} => {
  const texts: string[] = [];
  const images: { type: "content"; content: { type: "image"; data: string; mimeType: string } }[] =
    [];
  if (!Array.isArray(content)) {
    if (content !== null && content !== undefined) texts.push(JSON.stringify(content));
    return { text: texts.join("\n"), images };
  }
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (
      block?.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    )
      images.push({
        type: "content",
        content: { type: "image", data: block.data, mimeType: block.mimeType },
      });
    else texts.push(JSON.stringify(block));
  }
  return { text: texts.join("\n"), images };
};

const changeWord = (change: FileUpdateChange): string =>
  change.kind.type === "add" ? "added" : change.kind.type === "delete" ? "deleted" : "updated";

/**
 * The files' diff, a file at a time while they fit in MAX_OUTPUT: a file whose diff does not is named, with nothing
 * of its content, and the small edits beside it are still shown. Past the limit, the files are only counted.
 */
export const diffOf = (changes: readonly FileUpdateChange[]): string => {
  const parts: string[] = [];
  let left = MAX_OUTPUT;
  for (const [i, change] of changes.entries()) {
    const part =
      change.diff.length <= left
        ? change.diff
        : `${changeWord(change)} ${change.path} (its diff is too long to show)`;
    if (part.length > left) {
      parts.push(`… and ${changes.length - i} more files`);
      break;
    }
    parts.push(part);
    left -= part.length + 1;
  }
  return parts.join("\n");
};

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
            status: "completed",
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
  let rawInput: unknown;
  let images: { type: "content"; content: { type: "image"; data: string; mimeType: string } }[] =
    [];
  let locations: { path: string }[] | undefined;
  let meta: Record<string, unknown> | undefined;
  switch (item.type) {
    case "commandExecution": {
      name = "exec_command";
      const command = outputHead(item.command);
      title = command;
      kind = "execute";
      rawInput = { command, ...(item.cwd ? { cwd: item.cwd } : {}) };
      output = item.aggregatedOutput ? outputTail(item.aggregatedOutput) : undefined;
      if (completed) {
        const exitCode =
          typeof item.exitCode === "number" && Number.isInteger(item.exitCode) && item.exitCode > 0
            ? item.exitCode
            : undefined;
        meta = { [META.toolResult]: { run: exitCode !== undefined ? { exitCode } : {} } };
      }
      break;
    }
    case "mcpToolCall":
      name = `${item.server}/${item.tool}`;
      title = `${item.server} · ${item.tool}`;
      kind = "other";
      if (item.arguments !== null && item.arguments !== undefined) rawInput = item.arguments;
      if (completed) {
        if (item.error) output = outputHead(item.error.message);
        else {
          const result = mcpResult(item.result?.content);
          output = result.text ? outputHead(result.text) : undefined;
          images = result.images;
        }
      }
      break;
    case "fileChange":
      name = "Edit files";
      kind = "edit";
      if (item.changes.length > 0) locations = item.changes.map((c) => ({ path: c.path }));
      output = diffOf(item.changes);
      break;
    case "webSearch":
      name = "web_search";
      title = item.query;
      kind = "search";
      if (item.query) rawInput = { query: item.query };
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
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(locations !== undefined ? { locations } : {}),
    ...(output || images.length > 0
      ? {
          content: [
            ...(output
              ? [{ type: "content" as const, content: { type: "text" as const, text: output } }]
              : []),
            ...images,
          ],
        }
      : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
  };
}
