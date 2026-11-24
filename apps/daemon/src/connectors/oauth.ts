import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CycleErrorCode } from "@cycle/protocol";
import { INVALID_PARAMS, RpcError } from "../errors.ts";
import type { Credentials } from "./store.ts";

/**
 * Signing in to a connector, all of it in the daemon (docs/protocol.md §14): discovery, dynamic
 * registration, PKCE, the token exchange and refreshing. A client only opens the browser and brings
 * back the code; the verifier never leaves here, so neither does anything the code could buy.
 *
 * Follows MCP's authorization (protected resource metadata, RFC 9728; authorization server metadata,
 * RFC 8414; dynamic registration, RFC 7591; resource indicators, RFC 8707), and falls back to the
 * older default endpoints (`/authorize`, `/token`, `/register` at the server's origin) when a server
 * publishes no metadata.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

type OAuthRecord = NonNullable<Credentials["oauth"]>;

type Discovered = Omit<OAuthRecord, "client" | "tokens"> & {
  registrationEndpoint?: string;
  scopes?: string[];
};

/** One sign-in waiting for the browser. Kept in memory only: a daemon restart ends it. */
export type AuthFlow = {
  flowId: string;
  connectorId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  /** The endpoints and client registration this flow was started with. */
  oauth: Omit<OAuthRecord, "tokens">;
};

const FLOW_LIFETIME_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const failed = (reason: "auth_rejected" | "unreachable", detail: string): RpcError =>
  new RpcError(CycleErrorCode.ConnectorFailed, "The connector's sign-in failed", {
    reason,
    detail,
  });

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** https, or http to this machine. Anything else is not where a token may go. */
export const secureUrl = (raw: string): URL | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  return undefined;
};

/**
 * Two loopback redirects that differ only in port are the same to an authorization server (RFC 8252
 * §7.3), and the desktop's callback takes a new port each time: a client registered once is reused.
 */
const sameLoopbackRedirect = (registered: string | undefined, now: string): boolean => {
  if (registered === undefined) return false;
  try {
    const a = new URL(registered);
    const b = new URL(now);
    return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname;
  } catch {
    return false;
  }
};

const base64url = (bytes: Buffer): string =>
  bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** `resource_metadata="..."` from a `WWW-Authenticate: Bearer ...` header. */
const resourceMetadataOf = (header: string | null): string | undefined =>
  header?.match(/resource_metadata="([^"]+)"/)?.[1];

export class OAuthBroker {
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #flows = new Map<string, AuthFlow>();

  constructor(options: { fetch?: Fetch; now?: () => number } = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  async #get(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw failed("unreachable", error instanceof Error ? error.message : String(error));
    }
  }

  async #json(url: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.#get(url, { headers: { accept: "application/json" } }).catch(
      () => undefined,
    );
    if (response === undefined || !response.ok) return undefined;
    const body = await response.json().catch(() => undefined);
    return typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  }

  /** Where the server's authorization is: its protected resource metadata, then its authorization server's. */
  async discover(serverUrl: string): Promise<Discovered> {
    const server = secureUrl(serverUrl);
    if (server === undefined) {
      throw new RpcError(INVALID_PARAMS, "The connector's address must be https", {
        reason: "insecure_url",
      });
    }
    // A request without a token: a server that wants one says where its metadata is.
    const probe = await this.#get(server.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cycle", version: "0" },
        },
      }),
    });
    await probe.body?.cancel().catch(() => undefined);
    const fromHeader = resourceMetadataOf(probe.headers.get("www-authenticate"));
    const path = server.pathname === "/" ? "" : server.pathname.replace(/\/$/, "");
    const candidates = [
      ...(fromHeader !== undefined && secureUrl(fromHeader) !== undefined ? [fromHeader] : []),
      `${server.origin}/.well-known/oauth-protected-resource${path}`,
      `${server.origin}/.well-known/oauth-protected-resource`,
    ];
    let resource: Record<string, unknown> | undefined;
    for (const candidate of candidates) {
      resource = await this.#json(candidate);
      if (resource !== undefined) break;
    }
    const servers = Array.isArray(resource?.authorization_servers)
      ? (resource.authorization_servers as unknown[]).filter((s) => typeof s === "string")
      : [];
    const issuer = secureUrl((servers[0] as string | undefined) ?? server.origin);
    if (issuer === undefined) throw failed("auth_rejected", "insecure authorization server");
    const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
    const metadataUrls = [
      `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
      ...(issuerPath !== ""
        ? [`${issuer.origin}${issuerPath}/.well-known/openid-configuration`]
        : []),
    ];
    let metadata: Record<string, unknown> | undefined;
    for (const candidate of metadataUrls) {
      metadata = await this.#json(candidate);
      if (metadata !== undefined) break;
    }
    const scopes = Array.isArray(resource?.scopes_supported)
      ? (resource.scopes_supported as unknown[]).filter((s): s is string => typeof s === "string")
      : undefined;
    const resourceId = typeof resource?.resource === "string" ? resource.resource : undefined;
    const endpoint = (key: string, fallback?: string): string | undefined => {
      const value = metadata?.[key];
      const chosen = typeof value === "string" ? value : fallback;
      if (chosen === undefined) return undefined;
      if (secureUrl(chosen) === undefined) throw failed("auth_rejected", `insecure ${key}`);
      return chosen;
    };
    if (metadata !== undefined) {
      const methods = metadata.code_challenge_methods_supported;
      if (Array.isArray(methods) && !methods.includes("S256")) {
        throw failed("auth_rejected", "the server does not support PKCE with S256");
      }
    }
    // No metadata at all: the older default endpoints at the server's origin.
    const legacy = metadata === undefined ? issuer.origin : undefined;
    const authorizationEndpoint = endpoint(
      "authorization_endpoint",
      legacy && `${legacy}/authorize`,
    );
    const tokenEndpoint = endpoint("token_endpoint", legacy && `${legacy}/token`);
    if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
      throw failed("auth_rejected", "the server names no authorization or token endpoint");
    }
    const registrationEndpoint = endpoint("registration_endpoint", legacy && `${legacy}/register`);
    const revocationEndpoint = endpoint("revocation_endpoint");
    return {
      issuer: typeof metadata?.issuer === "string" ? metadata.issuer : issuer.href,
      authorizationEndpoint,
      tokenEndpoint,
      ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
      ...(registrationEndpoint !== undefined ? { registrationEndpoint } : {}),
      ...(resourceId !== undefined ? { resource: resourceId } : {}),
      ...(scopes !== undefined && scopes.length > 0 ? { scopes } : {}),
    };
  }

  async #register(
    registrationEndpoint: string,
    redirectUri: string,
  ): Promise<NonNullable<Credentials["oauth"]>["client"]> {
    const response = await this.#get(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Cycle",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const body = (await response.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!response.ok || typeof body?.client_id !== "string") {
      throw failed("auth_rejected", `registration answered ${response.status}`);
    }
    const method = body.token_endpoint_auth_method;
    return {
      clientId: body.client_id,
      ...(typeof body.client_secret === "string" ? { clientSecret: body.client_secret } : {}),
      redirectUri,
      registered: true,
      ...(method === "client_secret_post" || method === "client_secret_basic" || method === "none"
        ? { tokenEndpointAuthMethod: method }
        : {}),
    };
  }

  /**
   * Prepares a sign-in: finds the server's authorization, registers a client when it must, and
   * builds the URL to open. Does not install the flow yet: the caller calls `activate(flow)` once
   * it has verified the connector did not change while discovering and registering.
   */
  async begin(options: {
    connectorId: string;
    serverUrl: string;
    redirectUri: string;
    clientId?: string;
    scopes?: string[];
    credentials: Credentials;
  }): Promise<{ flow: AuthFlow; authorizationUrl: string }> {
    const redirect = secureUrl(options.redirectUri);
    if (redirect === undefined || redirect.protocol !== "http:") {
      throw new RpcError(INVALID_PARAMS, "The redirect must be a loopback http address", {
        reason: "insecure_url",
      });
    }
    const found = await this.discover(options.serverUrl);
    const previous = options.credentials.oauth?.client;
    let client: NonNullable<Credentials["oauth"]>["client"];
    if (options.clientId !== undefined) {
      client =
        previous !== undefined && !previous.registered && previous.clientId === options.clientId
          ? previous
          : { clientId: options.clientId, registered: false };
    } else if (
      previous?.registered === true &&
      sameLoopbackRedirect(previous.redirectUri, options.redirectUri) &&
      options.credentials.oauth?.issuer === found.issuer
    ) {
      client = previous;
    } else if (found.registrationEndpoint !== undefined) {
      client = await this.#register(found.registrationEndpoint, options.redirectUri);
    } else {
      throw new RpcError(INVALID_PARAMS, "The server needs a client id", {
        reason: "no_registration",
      });
    }
    const { registrationEndpoint: _r, scopes: _s, ...endpoints } = found;
    const verifier = base64url(randomBytes(32));
    const flow: AuthFlow = {
      flowId: randomUUID(),
      connectorId: options.connectorId,
      state: base64url(randomBytes(24)),
      verifier,
      redirectUri: options.redirectUri,
      expiresAt: this.#now() + FLOW_LIFETIME_MS,
      oauth: { ...endpoints, client },
    };
    const url = new URL(found.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set(
      "code_challenge",
      base64url(createHash("sha256").update(verifier).digest()),
    );
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", flow.state);
    const scopes = options.scopes ?? found.scopes;
    if (scopes !== undefined && scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
    if (found.resource !== undefined) url.searchParams.set("resource", found.resource);
    return { flow, authorizationUrl: url.href };
  }

  /** Makes a prepared flow the active sign-in for its connector, ending any earlier one. */
  activate(flow: AuthFlow): void {
    // Only one sign-in for a connector at a time: a new one ends the one before.
    for (const [id, existing] of this.#flows) {
      if (existing.connectorId === flow.connectorId || existing.expiresAt <= this.#now()) {
        this.#flows.delete(id);
      }
    }
    this.#flows.set(flow.flowId, flow);
  }

  /** The flow a `finish` names, if it is still waiting. It is used once: taking it ends it. */
  take(flowId: string): AuthFlow | undefined {
    const flow = this.#flows.get(flowId);
    this.#flows.delete(flowId);
    if (flow === undefined || flow.expiresAt <= this.#now()) return undefined;
    return flow;
  }

  /** Ends any sign-in waiting for a connector (it was removed or changed). */
  forget(connectorId: string): void {
    for (const [id, flow] of this.#flows) {
      if (flow.connectorId === connectorId) this.#flows.delete(id);
    }
  }

  async #token(
    oauth: NonNullable<Credentials["oauth"]>,
    grant: Record<string, string>,
  ): Promise<NonNullable<NonNullable<Credentials["oauth"]>["tokens"]>> {
    const body = new URLSearchParams(grant);
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    const { clientId, clientSecret, tokenEndpointAuthMethod } = oauth.client;
    if (clientSecret !== undefined && tokenEndpointAuthMethod === "client_secret_basic") {
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
      ).toString("base64")}`;
    } else {
      body.set("client_id", clientId);
      if (clientSecret !== undefined) body.set("client_secret", clientSecret);
    }
    if (oauth.resource !== undefined) body.set("resource", oauth.resource);
    const response = await this.#get(oauth.tokenEndpoint, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    const answer = (await response.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!response.ok || typeof answer?.access_token !== "string") {
      throw failed("auth_rejected", `the token endpoint answered ${response.status}`);
    }
    const expiresIn = typeof answer.expires_in === "number" ? answer.expires_in : undefined;
    return {
      accessToken: answer.access_token,
      ...(typeof answer.refresh_token === "string" ? { refreshToken: answer.refresh_token } : {}),
      ...(expiresIn !== undefined ? { expiresAt: this.#now() + expiresIn * 1000 } : {}),
    };
  }

  /** Trades the code the browser brought back for tokens, using the endpoints and client the flow started with. */
  async exchange(flow: AuthFlow, code: string): Promise<Credentials> {
    const tokens = await this.#token(flow.oauth, {
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    return { headers: {}, env: {}, oauth: { ...flow.oauth, tokens } };
  }

  /**
   * A new access token from the refresh token. Undefined when there is none, or the server refused
   * it: the connector needs signing in again. A server that does not send a new refresh token keeps
   * the old one valid.
   */
  async refresh(credentials: Credentials): Promise<Credentials | undefined> {
    const oauth = credentials.oauth;
    const refreshToken = oauth?.tokens?.refreshToken;
    if (oauth === undefined || refreshToken === undefined) return undefined;
    try {
      const tokens = await this.#token(oauth, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      return {
        ...credentials,
        oauth: { ...oauth, tokens: { refreshToken, ...tokens } },
      };
    } catch {
      return undefined;
    }
  }

  /** Tells the server to forget the tokens, where it can be told. Best effort: they are forgotten here either way. */
  async revoke(credentials: Credentials): Promise<void> {
    const oauth = credentials.oauth;
    const endpoint = oauth?.revocationEndpoint;
    const tokens = oauth?.tokens;
    if (oauth === undefined || endpoint === undefined || tokens === undefined) return;
    for (const [token, hint] of [
      [tokens.refreshToken, "refresh_token"],
      [tokens.accessToken, "access_token"],
    ] as const) {
      if (token === undefined || token === "") continue;
      const body = new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: oauth.client.clientId,
      });
      if (oauth.client.clientSecret !== undefined)
        body.set("client_secret", oauth.client.clientSecret);
      await this.#get(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    }
  }
}
