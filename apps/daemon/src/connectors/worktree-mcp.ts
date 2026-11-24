// The MCP server Cycle gives Codex and agy so they can enter and leave a worktree in the middle of a session
// (docs/protocol.md §6 "Worktree"). Claude has its own EnterWorktree and ExitWorktree; these take the same input and
// give the same output, and refuse in the same cases, so that a prompt written for one reads the same for all.
// Stateless streamable HTTP: one JSON-RPC message in, one JSON message out.

export const WORKTREE_CONNECTOR_ID = "cycle-worktree";
export const WORKTREE_SERVER_NAME = "cycle-worktree";

export type EnterInput = { name?: string; path?: string };
export type ExitInput = { action: "keep" | "remove"; discard_changes?: boolean };

export type WorktreeHost = {
  enter(
    sessionId: string,
    input: EnterInput,
  ): Promise<{ worktreePath: string; worktreeBranch?: string; message: string }>;
  exit(
    sessionId: string,
    input: ExitInput,
  ): Promise<{
    action: "keep" | "remove";
    originalCwd: string;
    worktreePath: string;
    worktreeBranch?: string;
    discardedFiles?: number;
    discardedCommits?: number;
    message: string;
  }>;
};

/** A tool's refusal: its message goes back to the agent as the tool's error, not as a failure of the protocol. */
export class ToolRefusal extends Error {}

const INSTRUCTIONS =
  "EnterWorktree and ExitWorktree here are Cycle's own, the same as the tools of the same name in Claude Code: " +
  "EnterWorktree creates (or enters) an isolated git worktree and moves this session's working directory into it; " +
  "ExitWorktree leaves it, keeping or removing it. They take effect from the next turn.";

const TOOLS = [
  {
    name: "EnterWorktree",
    description:
      "Create an isolated git worktree on a new branch (worktree-<name>, from the remote default branch) under .agents/worktree/<name>, or enter an existing worktree of this repository by path, and switch this session's working directory into it. Pass name or path, not both. Use only when the user asks to work in a worktree.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Up to 64 characters of letters, digits, ".", "_" and "-", in parts separated by "/". A random name when omitted.',
        },
        path: {
          type: "string",
          description:
            "Path of an existing worktree of this repository (see `git worktree list`) to enter instead of creating one.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ExitWorktree",
    description:
      'Leave the worktree this session is in and return to the main checkout. action "keep" leaves the worktree and branch on disk; "remove" deletes both, and is refused when there are uncommitted files or unmerged commits unless discard_changes is true.',
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["keep", "remove"] },
        discard_changes: {
          type: "boolean",
          description:
            'Required true with "remove" when the worktree holds uncommitted files or unmerged commits.',
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
] as const;

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const result = (id: Rpc["id"], value: unknown) =>
  json({ jsonrpc: "2.0", id: id ?? null, result: value });
const failure = (id: Rpc["id"], code: number, message: string) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const text = (value: unknown, isError = false) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
  ...(isError ? { isError: true } : {}),
});

/** Answers one MCP request of one session. */
export const handleWorktreeMcp = async (
  host: WorktreeHost,
  sessionId: string,
  request: Request,
): Promise<Response> => {
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let message: Rpc;
  try {
    message = (await request.json()) as Rpc;
  } catch {
    return failure(null, -32700, "Parse error");
  }
  if (typeof message !== "object" || message === null)
    return failure(null, -32600, "Invalid request");
  // Notifications have no answer.
  if (message.id === undefined) return new Response(null, { status: 202 });
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return result(message.id, {
        protocolVersion: typeof asked === "string" ? asked : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: WORKTREE_SERVER_NAME, version: "1" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(message.id, {});
    case "tools/list":
      return result(message.id, { tools: TOOLS });
    case "tools/call": {
      const name = message.params?.name;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        if (name === "EnterWorktree") {
          const input: EnterInput = {};
          if (args.name !== undefined) {
            if (typeof args.name !== "string") throw new ToolRefusal("name must be a string");
            input.name = args.name;
          }
          if (args.path !== undefined) {
            if (typeof args.path !== "string") throw new ToolRefusal("path must be a string");
            input.path = args.path;
          }
          if (input.name !== undefined && input.path !== undefined)
            throw new ToolRefusal("Pass name or path, not both");
          return result(message.id, text(await host.enter(sessionId, input)));
        }
        if (name === "ExitWorktree") {
          if (args.action !== "keep" && args.action !== "remove")
            throw new ToolRefusal('action must be "keep" or "remove"');
          const input: ExitInput = { action: args.action };
          if (args.discard_changes !== undefined) {
            if (typeof args.discard_changes !== "boolean")
              throw new ToolRefusal("discard_changes must be a boolean");
            input.discard_changes = args.discard_changes;
          }
          return result(message.id, text(await host.exit(sessionId, input)));
        }
        return failure(message.id, -32602, `Unknown tool ${String(name)}`);
      } catch (error) {
        return result(
          message.id,
          text(error instanceof Error ? error.message : String(error), true),
        );
      }
    }
    default:
      return failure(message.id, -32601, "Method not found");
  }
};
