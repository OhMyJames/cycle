// A stand-in for the SSO on 127.0.0.1, for tests only (after shrimpdot-durable's `mock-idp.ts`). It checks what authentik
// checks of a public client: PKCE S256, a loopback redirect to /callback, one use per code, and refresh tokens that
// rotate (the old one stops working the moment it is used). Nothing here is reachable from another machine.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockUser = { sub: string; name?: string; email?: string };

export type MockIdp = {
  /** Ends in a slash, as authentik's issuers do. */
  issuer: string;
  clientId: string;
  /** Change these to make the next requests behave differently. */
  controls: {
    user: MockUser;
    accessSeconds: number;
    /** Answer every request with 503. */
    offline: boolean;
    /** Send the browser back with `error=access_denied`. */
    deny: boolean;
    /** Name this account in renewals instead of the one that signed in. */
    renewAs: string | null;
    /** Answer a renewal only when this resolves. */
    holdRefresh: Promise<void> | null;
  };
  stats: { authorized: number; exchanged: number; refreshed: number; revoked: number };
  /** Every request's form, as it came: what a test reads to see that something was (or was not) sent. */
  requests: { path: string; form: Record<string, string> }[];
  /** Makes every refresh token issued so far invalid, as an administrator's revocation would. */
  revokeAll(): void;
  /** Whether this refresh token would still be taken. */
  live(refreshToken: string): boolean;
  /** A sign-in that already happened: a refresh token for `user`, for a test that starts signed in. */
  issueRefreshToken(user?: MockUser): string;
  /**
   * What the person's browser does with a sign-in page: goes to it, and follows the provider back to the callback.
   * Resolves with the callback's status; `tamper` changes the callback's query on the way.
   */
  browse(url: string, tamper?: (callback: URL) => void): Promise<number>;
  close(): Promise<void>;
};

const opaque = () => randomBytes(24).toString("base64url");

export async function startMockIdp(
  options: { user?: MockUser; accessSeconds?: number; clientId?: string } = {},
): Promise<MockIdp> {
  const clientId = options.clientId ?? "clawdot-team";
  const controls: MockIdp["controls"] = {
    user: options.user ?? { sub: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
    accessSeconds: options.accessSeconds ?? 3600,
    offline: false,
    deny: false,
    renewAs: null,
    holdRefresh: null,
  };
  const stats = { authorized: 0, exchanged: 0, refreshed: 0, revoked: 0 };
  const requests: MockIdp["requests"] = [];
  const codes = new Map<
    string,
    { redirectUri: string; challenge: string; nonce: string; user: MockUser }
  >();
  const refreshTokens = new Map<string, MockUser>();
  let issuer = "";

  // Signed with nothing: the client reads an ID token from the token endpoint over TLS and does not check a signature.
  const jwt = (claims: Record<string, unknown>) => {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`;
  };

  const tokens = (user: MockUser, nonce?: string) => {
    const now = Math.floor(Date.now() / 1000);
    const times = { iss: issuer, aud: clientId, iat: now, exp: now + controls.accessSeconds };
    const refreshToken = opaque();
    refreshTokens.set(refreshToken, user);
    return {
      access_token: jwt({ ...times, jti: opaque(), sub: user.sub }),
      id_token: jwt({ ...times, ...user, ...(nonce !== undefined ? { nonce } : {}) }),
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: controls.accessSeconds,
    };
  };

  const json = (response: ServerResponse, status: number, body: object) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };

  const form = async (request: IncomingMessage): Promise<URLSearchParams> => {
    let body = "";
    for await (const chunk of request) body += chunk;
    return new URLSearchParams(body);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (controls.offline) return json(response, 503, { error: "temporarily_unavailable" });
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration")
      return json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        revocation_endpoint: `${issuer}revoke`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/authorize") {
      const query = url.searchParams;
      let redirect: URL;
      try {
        redirect = new URL(query.get("redirect_uri") ?? "");
      } catch {
        return json(response, 400, { error: "invalid_request" });
      }
      if (
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(redirect.origin) ||
        redirect.pathname !== "/callback" ||
        query.get("client_id") !== clientId ||
        query.get("response_type") !== "code" ||
        query.get("code_challenge_method") !== "S256" ||
        !query.get("code_challenge") ||
        !query.get("state") ||
        !query.get("nonce") ||
        !(query.get("scope") ?? "").split(" ").includes("offline_access")
      )
        return json(response, 400, { error: "invalid_request" });
      stats.authorized++;
      redirect.searchParams.set("state", query.get("state") ?? "");
      if (controls.deny) redirect.searchParams.set("error", "access_denied");
      else {
        const code = opaque();
        codes.set(code, {
          redirectUri: query.get("redirect_uri") ?? "",
          challenge: query.get("code_challenge") ?? "",
          nonce: query.get("nonce") ?? "",
          user: { ...controls.user },
        });
        redirect.searchParams.set("code", code);
      }
      response.writeHead(302, { location: redirect.href });
      return void response.end();
    }
    if (request.method === "POST" && (url.pathname === "/token" || url.pathname === "/revoke")) {
      const body = await form(request);
      requests.push({ path: url.pathname, form: Object.fromEntries(body) });
      if (body.get("client_id") !== clientId)
        return json(response, 401, { error: "invalid_client" });
      if (url.pathname === "/revoke") {
        if (refreshTokens.delete(body.get("token") ?? "")) stats.revoked++;
        response.writeHead(200);
        return void response.end();
      }
      const grant = body.get("grant_type");
      if (grant === "authorization_code") {
        const code = codes.get(body.get("code") ?? "");
        codes.delete(body.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          code === undefined ||
          code.redirectUri !== body.get("redirect_uri") ||
          code.challenge !== challenge
        )
          return json(response, 400, { error: "invalid_grant" });
        stats.exchanged++;
        return json(response, 200, tokens(code.user, code.nonce));
      }
      if (grant === "refresh_token") {
        await controls.holdRefresh;
        const token = body.get("refresh_token") ?? "";
        const user = refreshTokens.get(token);
        refreshTokens.delete(token);
        if (user === undefined) return json(response, 400, { error: "invalid_grant" });
        stats.refreshed++;
        const renewed =
          controls.renewAs === null ? user : { ...controls.user, sub: controls.renewAs };
        return json(response, 200, tokens(renewed));
      }
      return json(response, 400, { error: "unsupported_grant_type" });
    }
    json(response, 404, { error: "not_found" });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => json(response, 500, { error: "server_error" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  return {
    issuer,
    clientId,
    controls,
    stats,
    requests,
    revokeAll: () => refreshTokens.clear(),
    live: (token) => refreshTokens.has(token),
    issueRefreshToken: (user = controls.user) => tokens({ ...user }).refresh_token,
    browse: async (url, tamper) => {
      const page = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      const location = page.headers.get("location");
      if (page.status !== 302 || location === null) return page.status;
      const callback = new URL(location);
      tamper?.(callback);
      const back = await fetch(callback, { signal: AbortSignal.timeout(5_000) });
      await back.text();
      return back.status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
