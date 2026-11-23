// An OIDC public client: authorization code with PKCE (RFC 7636), refresh, and revocation (RFC 7009). The Electron main
// process signs the person in with it (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md); the exchange for a service's token
// (RFC 8693, CYCL-162) is meant to sit here too. Endpoints come from the issuer's discovery document, never from a
// provider's own paths.
//
// What it never does: put a token in an error's message. A message here says what failed, in words, so that a log line or
// a page that shows it carries nothing that could be used.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Which identity provider, and which application of it: a public client has an id and no secret. */
export type OidcClient = { issuer: string; clientId: string };

/** Clawdot's SSO: authentik, the public client shrimpdot-durable and cycle_v2 sign in with. */
export const CLAWDOT_SSO: OidcClient = {
  issuer: "https://sso.shrimpdot.ai/application/o/clawdot-team/",
  clientId: "clawdot-team",
};

/** `offline_access` is what makes the provider issue a refresh token. */
export const SCOPE = "openid profile email offline_access";

export type Endpoints = {
  issuer: string;
  authorization: string;
  token: string;
  revocation?: string;
};

export type Tokens = {
  accessToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  refreshToken?: string;
  idToken?: string;
};

/** Who signed in, as the ID token says. */
export type Identity = { sub: string; name: string; email: string };

/** The provider will not take the refresh token again (`invalid_grant`): expired, revoked or used. Only signing in helps. */
export class SignInRequired extends Error {
  override name = "SignInRequired";
}

/** The provider could not be reached, did not answer in time, or failed itself (5xx): try again later. */
export class Unreachable extends Error {
  override name = "Unreachable";
}

/** The provider answered, and said no for a reason that trying again will not change (a 4xx other than invalid_grant). */
export class Refused extends Error {
  override name = "Refused";
  constructor(
    message: string,
    /** The OAuth error word (`invalid_client`, …): a word of the protocol, never a token. */
    readonly code: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;
const DEFAULT_EXPIRES_IN_S = 3600;

const isFields = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const withSlash = (issuer: string) => (issuer.endsWith("/") ? issuer : `${issuer}/`);

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Where a provider's endpoint may be: https, or http on this machine for a stand-in in a test. A discovery document that
 * names anything else (a downgrade to http on the network) is not followed.
 */
export const allowedEndpoint = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
};

/** A fetch that went wrong before an answer, as `Unreachable`, with no part of the request in its message. */
const send = async (fetch: Fetch, url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Unreachable("The sign-in service could not be reached");
  }
};

export async function discover(fetch: Fetch, issuer: string): Promise<Endpoints> {
  if (!allowedEndpoint(issuer)) throw new Refused("The sign-in service is not https", "insecure");
  const response = await send(
    fetch,
    new URL(".well-known/openid-configuration", withSlash(issuer)).href,
    { headers: { accept: "application/json" } },
  );
  if (response.status >= 500)
    throw new Unreachable(`The sign-in service answered HTTP ${response.status}`);
  if (!response.ok)
    throw new Refused(`The sign-in service answered HTTP ${response.status}`, "discovery");
  const body: unknown = await response.json().catch(() => undefined);
  if (!isFields(body))
    throw new Refused("The sign-in service's discovery is not JSON", "discovery");
  // The document must be the issuer's own (OIDC Discovery §4.3): one that names another is not trusted.
  if (withSlash(text(body.issuer) ?? "") !== withSlash(issuer))
    throw new Refused("The sign-in service's discovery names another issuer", "discovery");
  const authorization = text(body.authorization_endpoint);
  const token = text(body.token_endpoint);
  const revocation = text(body.revocation_endpoint);
  if (authorization === undefined || token === undefined)
    throw new Refused("The sign-in service names no authorization or token endpoint", "discovery");
  for (const endpoint of [authorization, token, revocation])
    if (endpoint !== undefined && !allowedEndpoint(endpoint))
      throw new Refused("The sign-in service names an endpoint that is not https", "insecure");
  return {
    issuer: text(body.issuer) as string,
    authorization,
    token,
    ...(revocation !== undefined ? { revocation } : {}),
  };
}

/** A random value for `state`, `nonce` or a PKCE verifier: 32 bytes, base64url. */
export const randomValue = (): string => randomBytes(32).toString("base64url");

export const challengeOf = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** Two secrets compared in a time that does not depend on where they differ. */
export const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** What one sign-in holds until its code comes back: never sent anywhere but to the provider. */
export type Attempt = { verifier: string; state: string; nonce: string; redirectUri: string };

export const newAttempt = (redirectUri: string): Attempt => ({
  verifier: randomValue(),
  state: randomValue(),
  nonce: randomValue(),
  redirectUri,
});

export function authorizeUrl(endpoints: Endpoints, client: OidcClient, attempt: Attempt): string {
  const url = new URL(endpoints.authorization);
  const params = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: attempt.redirectUri,
    scope: SCOPE,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: challengeOf(attempt.verifier),
    code_challenge_method: "S256",
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}

/** An answer of the token endpoint, read; a failure as one of the three errors above. */
async function postForm(
  fetch: Fetch,
  url: string,
  form: Record<string, string>,
  what: string,
): Promise<Record<string, unknown>> {
  const response = await send(fetch, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const body: unknown = await response.json().catch(() => ({}));
  const fields = isFields(body) ? body : {};
  if (response.ok) return fields;
  if (response.status >= 500)
    throw new Unreachable(`The sign-in service failed (HTTP ${response.status})`);
  // Only the error word, and only when it is one: `error_description` is the provider's free text.
  const code = text(fields.error);
  const word = code !== undefined && /^[a-z_]{1,64}$/.test(code) ? code : "unknown";
  if (word === "invalid_grant") throw new SignInRequired(`The sign-in service refused ${what}`);
  throw new Refused(`The sign-in service refused ${what} (${word})`, word);
}

/** A refresh that issues no new refresh token keeps the old one (RFC 6749 §6). */
export function tokensOf(body: Record<string, unknown>, now: number, previous?: string): Tokens {
  const accessToken = text(body.access_token);
  if (accessToken === undefined)
    throw new Refused("The sign-in service's answer has no access token", "invalid_response");
  const expiresIn =
    typeof body.expires_in === "number" && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_EXPIRES_IN_S;
  const refreshToken = text(body.refresh_token) ?? previous;
  const idToken = text(body.id_token);
  return {
    accessToken,
    expiresAt: now + expiresIn * 1000,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
  };
}

export async function exchangeCode(
  fetch: Fetch,
  endpoints: Endpoints,
  client: OidcClient,
  attempt: Attempt,
  code: string,
  now: () => number = Date.now,
): Promise<Tokens> {
  const body = await postForm(
    fetch,
    endpoints.token,
    {
      grant_type: "authorization_code",
      client_id: client.clientId,
      code,
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.verifier,
    },
    "the sign-in",
  );
  return tokensOf(body, now());
}

/** Throws `SignInRequired` when the refresh token no longer works, `Unreachable` when the provider cannot say. */
export async function refreshTokens(
  fetch: Fetch,
  endpoints: Endpoints,
  client: OidcClient,
  refreshToken: string,
  now: () => number = Date.now,
): Promise<Tokens> {
  const body = await postForm(
    fetch,
    endpoints.token,
    { grant_type: "refresh_token", client_id: client.clientId, refresh_token: refreshToken },
    "a renewal",
  );
  return tokensOf(body, now(), refreshToken);
}

/** Revokes a refresh token (RFC 7009). A provider without the endpoint: nothing to do. */
export async function revokeToken(
  fetch: Fetch,
  endpoints: Endpoints,
  client: OidcClient,
  refreshToken: string,
): Promise<void> {
  if (endpoints.revocation === undefined) return;
  await postForm(
    fetch,
    endpoints.revocation,
    { client_id: client.clientId, token: refreshToken, token_type_hint: "refresh_token" },
    "the sign-out",
  );
}

/** The claims of a JWT, unverified: for what came straight from the token endpoint over TLS. */
export const jwtClaims = (jwt: string): Record<string, unknown> | undefined => {
  const payload = jwt.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isFields(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
};

const audienceHas = (aud: unknown, clientId: string) =>
  aud === clientId || (Array.isArray(aud) && aud.includes(clientId));

/**
 * Who an ID token names, after the checks OIDC Core §3.1.3.7 asks of a client that got it from the token endpoint over
 * TLS: the issuer, the audience, not expired, and (for a sign-in) the nonce it was asked with. The signature is the
 * TLS connection's to vouch for (§3.1.3.7 item 6).
 */
export function identityOf(
  idToken: string,
  client: OidcClient,
  options: { nonce?: string; now?: number } = {},
): Identity {
  const claims = jwtClaims(idToken);
  if (claims === undefined) throw new Refused("The ID token cannot be read", "invalid_id_token");
  if (withSlash(text(claims.iss) ?? "") !== withSlash(client.issuer))
    throw new Refused("The ID token is from another issuer", "invalid_id_token");
  if (!audienceHas(claims.aud, client.clientId))
    throw new Refused("The ID token is for another application", "invalid_id_token");
  const now = options.now ?? Date.now();
  // A minute of leeway for the two clocks.
  if (typeof claims.exp !== "number" || claims.exp * 1000 + 60_000 < now)
    throw new Refused("The ID token has expired", "invalid_id_token");
  if (
    options.nonce !== undefined &&
    !sameSecret(typeof claims.nonce === "string" ? claims.nonce : "", options.nonce)
  )
    throw new Refused("The ID token was not for this sign-in", "invalid_id_token");
  const sub = text(claims.sub);
  if (sub === undefined) throw new Refused("The ID token names nobody", "invalid_id_token");
  const email = text(claims.email) ?? "";
  return {
    sub,
    name: text(claims.name) ?? text(claims.preferred_username) ?? email,
    email,
  };
}

/** Whom a renewal is for: its ID token's `sub`, else the access token's; undefined when neither says. */
export const subjectOf = (tokens: Tokens): string | undefined => {
  for (const jwt of [tokens.idToken, tokens.accessToken]) {
    if (jwt === undefined) continue;
    const sub = text(jwtClaims(jwt)?.sub);
    if (sub !== undefined) return sub;
  }
  return undefined;
};
