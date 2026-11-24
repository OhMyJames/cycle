import { isAbsolute } from "node:path";
import type { ConnectorAuth, ConnectorSecrets, ConnectorTransport } from "@cycle/protocol";
import { INVALID_PARAMS, RpcError } from "../errors.ts";
import { secureUrl } from "./oauth.ts";
import type { CatalogEntry, Credentials } from "./store.ts";

// What a connector may be, and what its headers become: rules without state, shared by the parts of the service.

/** Header names the gateway sets itself, or that would break the request. */
export const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);

export const invalid = (
  message: string,
  reason: string,
  data: Record<string, unknown> = {},
): RpcError => new RpcError(INVALID_PARAMS, message, { ...data, reason });

/** A connector is fit to keep: its address is safe for a token, its names are usable. */
export const checkTransport = (transport: ConnectorTransport, auth: ConnectorAuth): void => {
  if (transport.type === "http") {
    if (secureUrl(transport.url) === undefined) {
      throw invalid("The address must be https (or http to this machine)", "insecure_url");
    }
  } else {
    if (auth.type === "oauth")
      throw invalid("Signing in needs an http connector", "oauth_needs_http");
    if (transport.cwd !== undefined && !isAbsolute(transport.cwd)) {
      throw invalid("The folder must be an absolute path", "invalid_cwd");
    }
  }
};

export const applySecrets = (
  credentials: Credentials,
  secrets: ConnectorSecrets | undefined,
): Credentials => {
  if (secrets === undefined) return credentials;
  const next = { ...credentials, headers: { ...credentials.headers }, env: { ...credentials.env } };
  for (const [name, value] of Object.entries(secrets.headers ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw invalid("That header is set by Cycle", "reserved_header", { header: name });
    }
    if (value === null) delete next.headers[name];
    else next.headers[name] = value;
  }
  for (const [name, value] of Object.entries(secrets.env ?? {})) {
    if (value === null) delete next.env[name];
    else next.env[name] = value;
  }
  return next;
};

/**
 * What a token is bound to: the server's address (or the command) and how it signs in. Scopes and
 * names are not part of it, so renaming a connector does not sign it out.
 */
export const serverOf = (entry: CatalogEntry): string =>
  JSON.stringify([
    entry.transport.type === "http"
      ? entry.transport.url
      : [entry.transport.command, entry.transport.args, entry.transport.cwd ?? null],
    entry.auth.type,
    entry.auth.type === "oauth" ? (entry.auth.clientId ?? null) : null,
  ]);

/** The names a plugin's headers leave to the person: each `${NAME}` in them. */
export const requiredBy = (headers: Record<string, string>): string[] => {
  const names = new Set<string>();
  for (const value of Object.values(headers)) {
    for (const match of value.matchAll(/\$\{([A-Za-z0-9_-]+)\}/g)) names.add(match[1] as string);
  }
  return [...names];
};

/** A plugin's headers with the person's values in. Undefined while one of them has none. */
export const filled = (
  headers: Record<string, string>,
  values: Record<string, string>,
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    let missing = false;
    out[name] = template.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (_all, key: string) => {
      const value = values[key];
      if (value === undefined) missing = true;
      return value ?? "";
    });
    if (missing) return undefined;
  }
  return out;
};
