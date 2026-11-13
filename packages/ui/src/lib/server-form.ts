import type { McpServerInfo, McpServerInput } from "@cycle/protocol";
import { compactNumber } from "./format.ts";

/** One environment variable on the form. `kept` is a stored value the page was never given. */
export interface EnvRow {
  name: string;
  value: string;
  kept: boolean;
}

/** What the form edits: both ways to reach a server at once, so switching keeps what was typed. */
export interface ServerDraft {
  name: string;
  kind: "stdio" | "http";
  /** The command and its arguments, as they would be typed in a shell. */
  command: string;
  env: EnvRow[];
  url: string;
  bearerTokenEnvVar: string;
}

const quote = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** A command line split as a shell would, quotes and backslashes only. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quoted: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    const escapes = char === "\\" && quoted !== "'" && index + 1 < line.length;
    if (escapes) {
      word += line.charAt(++index);
      started = true;
    } else if (quoted) {
      if (char === quoted) quoted = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quoted = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** The form for a server, or for a new one. */
export function serverDraft(server: McpServerInfo | null): ServerDraft {
  const transport = server?.transport;
  return {
    name: server?.name ?? "",
    kind: transport?.kind ?? "stdio",
    command:
      transport?.kind === "stdio"
        ? [transport.command, ...transport.args].map(quote).join(" ")
        : "",
    env:
      transport?.kind === "stdio"
        ? transport.env.map((name) => ({ name, value: "", kept: true }))
        : [],
    url: transport?.kind === "http" ? transport.url : "",
    bearerTokenEnvVar: transport?.kind === "http" ? (transport.bearerTokenEnvVar ?? "") : "",
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What the form must have before it can be saved, or null when it has all of it. */
export function serverProblem(draft: ServerDraft, taken: readonly string[]): string | null {
  const name = draft.name.trim();
  if (name === "") return "Name it";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return "Use letters, digits, - and _ in the name";
  if (taken.includes(name)) return "Another server has that name";
  if (draft.kind === "stdio") {
    if (splitCommand(draft.command).length === 0) return "Say what command starts it";
    const names = draft.env.map((row) => row.name.trim()).filter(Boolean);
    if (names.some((each) => !ENV_NAME.test(each))) return "A variable's name has no spaces or =";
    if (new Set(names).size !== names.length) return "A variable is set twice";
    return null;
  }
  if (!/^https?:\/\/\S+$/.test(draft.url.trim())) return "Give its http or https address";
  const token = draft.bearerTokenEnvVar.trim();
  if (token && !ENV_NAME.test(token)) return "Name the variable that holds the token";
  return null;
}

/** What the form says, for the daemon. A kept value left empty stays what it was. */
export function serverInput(draft: ServerDraft): McpServerInput {
  const name = draft.name.trim();
  if (draft.kind === "http") {
    return {
      name,
      transport: {
        kind: "http",
        url: draft.url.trim(),
        bearerTokenEnvVar: draft.bearerTokenEnvVar.trim() || null,
      },
    };
  }
  const [command = "", ...args] = splitCommand(draft.command);
  const env: Record<string, string | null> = {};
  for (const row of draft.env) {
    const key = row.name.trim();
    if (key) env[key] = row.kept && row.value === "" ? null : row.value;
  }
  return { name, transport: { kind: "stdio", command, args, env } };
}

/** How a server is reached, in one line. */
export function transportLabel(server: McpServerInfo): string {
  const transport = server.transport;
  if (!transport) return server.pluginId ? `From ${server.pluginId}` : "Set up outside Cycle";
  if (transport.kind === "http") return transport.url;
  return [transport.command, ...transport.args].map(quote).join(" ");
}

const STATUS: Record<McpServerInfo["status"], string> = {
  connected: "Connected",
  failed: "Failed to start",
  needsAuth: "Needs sign-in",
  disabled: "Off",
  unknown: "Not started yet",
};

/** What a server is doing, in a few words. */
export function statusLabel(server: McpServerInfo): string {
  if (!server.enabled) return STATUS.disabled;
  if (server.auth === "signedOut") return STATUS.needsAuth;
  const count = server.tools.length;
  if (server.status === "connected" || (server.status === "unknown" && count > 0)) {
    const on = server.tools.filter((tool) => tool.enabled).length;
    const tokens = toolTokens(server);
    const tools =
      on === count ? (count === 1 ? "1 tool" : `${count} tools`) : `${on} of ${count} tools on`;
    return tokens ? `${tools} · ~${compactNumber(tokens)} tokens` : tools;
  }
  return STATUS[server.status];
}

/** About how much of a request a server's tools take, when they go into it whole. */
export function toolTokens(server: McpServerInfo): number {
  return server.tools.reduce((sum, tool) => sum + (tool.enabled ? (tool.tokens ?? 0) : 0), 0);
}
