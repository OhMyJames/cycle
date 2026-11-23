import { type McpServer, RequestError } from "@agentclientprotocol/sdk/experimental/v2";

export type V1McpHeaderOrEnv = { name: string; value: string };

export type V1McpServer =
  | {
      type: "http";
      name: string;
      url: string;
      headers: V1McpHeaderOrEnv[];
    }
  | {
      name: string;
      command: string;
      args: string[];
      env: V1McpHeaderOrEnv[];
    };

const normalizePairs = (raw: unknown, field: string, serverName: string): V1McpHeaderOrEnv[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new RequestError(-32602, `MCP server ${field} must be an array`, { name: serverName });
  }
  const out: V1McpHeaderOrEnv[] = [];
  for (const item of raw) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { name?: unknown }).name !== "string" ||
      typeof (item as { value?: unknown }).value !== "string"
    ) {
      throw new RequestError(-32602, `Invalid entry in MCP server ${field}`, { name: serverName });
    }
    out.push({
      name: (item as { name: string }).name,
      value: (item as { value: string }).value,
    });
  }
  return out;
};

/**
 * Translate ACP v2 `mcpServers` into agy ACP v1 `mcpServers`.
 * Supports `http` (streamable HTTP) and `stdio`; refuses `sse` and invalid entries with `-32602`.
 */
export const translateMcpServers = (
  servers: readonly McpServer[] | null | undefined,
): V1McpServer[] => {
  if (!servers || servers.length === 0) return [];
  const seen = new Set<string>();
  const out: V1McpServer[] = [];

  for (const server of servers) {
    const entry = server as unknown as Record<string, unknown>;
    const name = entry.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new RequestError(-32602, "An MCP server needs a non-empty name");
    }
    if (seen.has(name)) {
      throw new RequestError(-32602, "Two MCP servers have the same name", { name });
    }
    seen.add(name);

    const type = entry.type;
    if (type === "sse") {
      throw new RequestError(-32602, "agy does not support SSE MCP servers", { name });
    }
    if (type === "http") {
      const url = entry.url;
      if (typeof url !== "string" || url.trim() === "") {
        throw new RequestError(-32602, "An HTTP MCP server needs a url", { name });
      }
      out.push({
        type: "http",
        name,
        url,
        headers: normalizePairs(entry.headers, "headers", name),
      });
      continue;
    }
    if (type === undefined || type === "stdio") {
      const command = entry.command;
      if (typeof command !== "string" || command.trim() === "") {
        throw new RequestError(-32602, "A stdio MCP server needs a command", { name });
      }
      const rawArgs = entry.args;
      if (
        rawArgs !== undefined &&
        (!Array.isArray(rawArgs) || !rawArgs.every((arg) => typeof arg === "string"))
      ) {
        throw new RequestError(-32602, "A stdio MCP server's args must be strings", { name });
      }
      out.push({
        name,
        command,
        args: (rawArgs as string[] | undefined) ?? [],
        env: normalizePairs(entry.env, "env", name),
      });
      continue;
    }
    throw new RequestError(-32602, `Unsupported MCP server transport: ${String(type)}`, { name });
  }

  return out;
};
