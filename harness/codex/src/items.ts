import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk/experimental/v2";
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

const slash = (path: string): string => (path.startsWith("/") ? path : `/${path}`);

/**
 * One file's change as a git patch, with its +/- counts. Codex's diff is a unified diff with or without a file header,
 * or, for a file added or deleted, only the file's lines: a header is added when there is none (never doubled), and
 * bare lines are made the body of one hunk.
 */
const patchOf = (
  change: FileUpdateChange,
): { text: string; additions: number; deletions: number } | undefined => {
  if (change.diff.trim() === "") return undefined;
  const type = change.kind.type;
  const from = slash(change.path);
  const to = slash(
    change.kind.type === "update" ? (change.kind.move_path ?? change.path) : change.path,
  );
  const lines = change.diff.replace(/\n$/, "").split("\n");
  const hasHeader = lines[0]?.startsWith("diff --git ");
  const hunkAt = lines.findIndex((line) => line.startsWith("@@"));
  let body: string[];
  if (hunkAt >= 0) body = lines.slice(hunkAt);
  else if (hasHeader) body = [];
  else {
    // Only the file's lines: one hunk, the lines marked unless they already are.
    const sign = type === "delete" ? "-" : "+";
    const marked = lines.every((line) => line === "" || line.startsWith(sign));
    const rows = marked ? lines : lines.map((line) => `${sign}${line}`);
    body = [
      type === "delete" ? `@@ -1,${rows.length} +0,0 @@` : `@@ -0,0 +1,${rows.length} @@`,
      ...rows,
    ];
  }
  let additions = 0;
  let deletions = 0;
  for (const line of body) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  const head = hasHeader
    ? lines.slice(0, hunkAt >= 0 ? hunkAt : lines.length)
    : [
        `diff --git a${from} b${to}`,
        type === "add" ? "--- /dev/null" : `--- a${from}`,
        type === "delete" ? "+++ /dev/null" : `+++ b${to}`,
      ];
  // A header Codex gave without its ---/+++ lines gets them.
  if (hasHeader && !head.some((line) => line.startsWith("+++ ")))
    head.push(
      type === "add" ? "--- /dev/null" : `--- a${from}`,
      type === "delete" ? "+++ /dev/null" : `+++ b${to}`,
    );
  return { text: `${[...head, ...body].join("\n")}\n`, additions, deletions };
};

/** The files' changes as one `diff` block, a file at a time: a file whose patch is too long keeps its path and counts. */
const diffBlock = (changes: readonly FileUpdateChange[]) => {
  let additions = 0;
  let deletions = 0;
  const entries = changes.map((change) => {
    const patch = patchOf(change);
    additions += patch?.additions ?? 0;
    deletions += patch?.deletions ?? 0;
    return {
      path: change.path,
      operation: change.kind.type,
      patch:
        patch && patch.text.length <= MAX_OUTPUT
          ? { format: "git_patch" as const, text: patch.text }
          : null,
    };
  });
  return {
    additions,
    deletions,
    blocks: entries.map(
      (e): ToolCallContent => ({
        type: "diff",
        changes: [
          e.operation === "add"
            ? { operation: "add", path: e.path }
            : e.operation === "delete"
              ? { operation: "delete", path: e.path }
              : { operation: "modify", path: e.path },
        ],
        patch: e.patch,
      }),
    ),
  };
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
  let diffs: ReturnType<typeof diffBlock>["blocks"] = [];
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
        const durationMs =
          typeof item.durationMs === "number" &&
          Number.isInteger(item.durationMs) &&
          item.durationMs >= 0
            ? item.durationMs
            : undefined;
        meta = {
          [META.toolResult]: {
            run: {
              ...(exitCode !== undefined ? { exitCode } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          },
        };
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
      if (item.changes.length > 0) {
        const diff = diffBlock(item.changes);
        diffs = diff.blocks;
        if (completed)
          meta = {
            [META.toolResult]: { edit: { additions: diff.additions, deletions: diff.deletions } },
          };
      }
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
    ...(output || images.length > 0 || diffs.length > 0
      ? {
          content: [
            ...(output
              ? [{ type: "content" as const, content: { type: "text" as const, text: output } }]
              : []),
            ...diffs,
            ...images,
          ],
        }
      : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
  };
}
