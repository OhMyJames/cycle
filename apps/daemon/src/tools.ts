import { createHash, timingSafeEqual } from "node:crypto";
import type { Item, Session, Turn } from "@cycle/protocol";

/*
 * Cycle's own tools for agents: an MCP server, `cycle`, that every session's agent can reach. It
 * lists the owner's sessions and reads one's conversation, which is what a mention of a session in
 * a prompt points to. It changes nothing, so its tools are marked read-only.
 */

/** The name codex knows the server by, and the page shows. */
export const TOOLS_SERVER = "cycle";
/** The environment variable codex reads the server's key from. */
export const TOOLS_KEY_ENV = "CYCLE_TOOLS_KEY";
/** How a prompt names a session: a link to this, then the session's id. */
export const SESSION_LINK = "cycle://session/";

/** What the tools read. The hub gives it; tests give a fake. */
export interface SessionSource {
  list(): Promise<Session[]>;
  /** A session's turns, or null when there is no such session. */
  turns(sessionId: string): Promise<{ info: Session; turns: Turn[] } | null>;
}

const MAX_LISTED = 50;
const DEFAULT_TURNS = 10;
const MAX_TURNS = 50;
/** One piece of work, as a line: enough to know what was done, not its output. */
const LINE = 200;
/** A whole answer. A conversation longer than this keeps its end. */
const MAX_TEXT = 60_000;

const TOOLS = [
  {
    name: "list_sessions",
    description:
      "Lists the owner's Cycle sessions, newest first: id, title, folder, status and when each last changed. Use it to find a session to read.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Only sessions whose title or folder holds this." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_session",
    description: `Reads another Cycle session's conversation: what the owner asked, what the agent answered and what it did. A prompt mentions a session as a link to ${SESSION_LINK}<id>; pass that id.`,
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session's id." },
        turns: {
          type: "number",
          description: `How many of its latest turns to read. ${DEFAULT_TURNS} when left out, at most ${MAX_TURNS}.`,
        },
      },
      required: ["session_id"],
    },
    annotations: { readOnlyHint: true },
  },
] as const;

const clip = (text: string, length: number): string => {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length)}…` : line;
};

const titleOf = (info: Session): string =>
  info.title?.trim() || clip(info.preview, 80) || "Untitled session";

/** One item of a turn as text, or null for what a reader does not need. */
export function itemText(item: Item): string | null {
  switch (item.kind) {
    case "userMessage":
      return `## Owner\n${item.text}`;
    case "agentMessage":
      return `## Agent\n${item.text}`;
    case "plan":
      return `## Agent's plan\n${item.text}`;
    case "command":
      return `- ran \`${clip(item.command, LINE)}\`${item.exitCode ? ` (exit ${item.exitCode})` : ""}`;
    case "fileChange":
      return `- changed ${item.changes.map((change) => change.path).join(", ")}`;
    case "toolCall":
      return `- called ${item.server ? `${item.server}.` : ""}${item.tool}${item.error ? ` (failed: ${clip(item.error, LINE)})` : ""}`;
    case "webSearch":
      return `- searched the web for "${clip(item.query, LINE)}"`;
    default:
      return null;
  }
}

/** A session's latest turns as text, cut from the start when it is too long. */
export function sessionText(info: Session, turns: readonly Turn[], count: number): string {
  const shown = turns.slice(-count);
  const head = [
    `# ${titleOf(info)}`,
    `Folder: ${info.cwd}`,
    `Status: ${info.status}`,
    shown.length < turns.length ? `Showing the last ${shown.length} of ${turns.length} turns.` : "",
  ].filter(Boolean);
  const body = shown
    .map((turn) =>
      turn.items
        .map(itemText)
        .filter((text) => text !== null)
        .join("\n"),
    )
    .join("\n\n");
  const text = body.length > MAX_TEXT ? `[Earlier text left out]\n${body.slice(-MAX_TEXT)}` : body;
  return `${head.join("\n")}\n\n${text || "No turns yet."}`;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  source: SessionSource,
): Promise<string> {
  if (name === "list_sessions") {
    const query = typeof args["query"] === "string" ? args["query"].toLowerCase() : "";
    const all = await source.list();
    const found = all.filter((info) =>
      `${titleOf(info)} ${info.cwd}`.toLowerCase().includes(query),
    );
    if (!found.length) return "No sessions.";
    return found
      .slice(0, MAX_LISTED)
      .map(
        (info) =>
          `- ${titleOf(info)} | id ${info.id} | ${info.cwd} | ${info.status} | changed ${new Date(info.updatedAt).toISOString()}`,
      )
      .join("\n");
  }
  if (name === "read_session") {
    const given = typeof args["session_id"] === "string" ? args["session_id"].trim() : "";
    const sessionId = given.startsWith(SESSION_LINK) ? given.slice(SESSION_LINK.length) : given;
    if (!sessionId) throw new Error("session_id is needed");
    const wanted = typeof args["turns"] === "number" ? Math.floor(args["turns"]) : DEFAULT_TURNS;
    const read = await source.turns(sessionId);
    if (!read) throw new Error(`There is no session ${sessionId}. list_sessions shows the ids.`);
    return sessionText(read.info, read.turns, Math.min(Math.max(wanted, 1), MAX_TURNS));
  }
  throw new Error(`unknown tool: ${name}`);
}

interface RpcRequest {
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The answer to one MCP message, or null for a notification, which has none. */
export async function answerMcp(message: unknown, source: SessionSource): Promise<unknown> {
  if (!isRecord(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  }
  const { id, method, params } = message as RpcRequest;
  if (id === undefined || id === null) return null;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  const given = isRecord(params) ? params : {};
  switch (method) {
    case "initialize":
      return result({
        protocolVersion:
          typeof given["protocolVersion"] === "string" ? given["protocolVersion"] : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: TOOLS_SERVER, version: "1.0.0" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      const name = typeof given["name"] === "string" ? given["name"] : "";
      const args = isRecord(given["arguments"]) ? given["arguments"] : {};
      try {
        const text = await callTool(name, args, source);
        return result({ content: [{ type: "text", text }] });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return result({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export interface ToolsServer {
  url: string;
  key: string;
  /** The sessions to read, once there is a hub to read them from. */
  serve(source: SessionSource): void;
  stop(): void;
}

/**
 * Starts the server agents reach the tools through. As the providers' gateway: on loopback only,
 * for a request that names it by its loopback address, and only with its own key, which is not the
 * page's connection token.
 */
export function startTools(key: string): ToolsServer {
  const expected = digest(`Bearer ${key}`);
  let source: SessionSource | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, bunServer) {
      const hosts = [`127.0.0.1:${bunServer.port}`, `localhost:${bunServer.port}`];
      if (!hosts.includes(request.headers.get("host") ?? "")) {
        return new Response("forbidden", { status: 403 });
      }
      if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), expected)) {
        return new Response("unauthorized", { status: 401 });
      }
      if (new URL(request.url).pathname !== "/mcp")
        return new Response("not found", { status: 404 });
      // No stream of its own: every answer is the response to its request.
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!source) return new Response("starting", { status: 503 });
      let message: unknown;
      try {
        message = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const reader = source;
      const answer = Array.isArray(message)
        ? (await Promise.all(message.map((each) => answerMcp(each, reader)))).filter(
            (each) => each !== null,
          )
        : await answerMcp(message, reader);
      if (answer === null || (Array.isArray(answer) && answer.length === 0)) {
        return new Response(null, { status: 202 });
      }
      return Response.json(answer);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    key,
    serve(next) {
      source = next;
    },
    stop: () => void server.stop(true),
  };
}
