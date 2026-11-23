import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  allowedEndpoint,
  authorizeUrl,
  discover,
  exchangeCode,
  identityOf,
  newAttempt,
  Refused,
  refreshTokens,
  revokeToken,
  SignInRequired,
  sameSecret,
  subjectOf,
  Unreachable,
} from "../src/index.ts";
import { type MockIdp, startMockIdp } from "../src/mock-idp.ts";

let idp: MockIdp;
beforeEach(async () => {
  idp = await startMockIdp();
});
afterEach(async () => {
  await idp.close();
});

const client = () => ({ issuer: idp.issuer, clientId: idp.clientId });

/** A loopback callback that only remembers what came back. */
const catcher = () => {
  let seen: URL | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen = new URL(request.url);
      return new Response("ok");
    },
  });
  return {
    redirectUri: `http://127.0.0.1:${server.port}/callback`,
    seen: () => seen,
    stop: () => server.stop(true),
  };
};

test("endpoints come from discovery, and only https or this machine is followed", async () => {
  const endpoints = await discover(fetch, idp.issuer);
  expect(endpoints.token).toBe(`${idp.issuer}token`);
  expect(endpoints.revocation).toBe(`${idp.issuer}revoke`);
  expect(allowedEndpoint("https://sso.example/token")).toBe(true);
  expect(allowedEndpoint("http://127.0.0.1:9/token")).toBe(true);
  expect(allowedEndpoint("http://sso.example/token")).toBe(false);
  expect(allowedEndpoint("file:///etc/passwd")).toBe(false);
  await expect(discover(fetch, "http://sso.example/")).rejects.toBeInstanceOf(Refused);
});

test("a discovery document that names another issuer is not trusted", async () => {
  const lying = (async () =>
    Response.json({
      issuer: "https://evil.example/",
      authorization_endpoint: "https://evil.example/a",
      token_endpoint: "https://evil.example/t",
    })) as unknown as typeof fetch;
  await expect(discover(lying, idp.issuer)).rejects.toThrow("another issuer");
});

test("a provider that cannot be reached, or fails, is Unreachable; one that refuses is not", async () => {
  idp.controls.offline = true;
  await expect(discover(fetch, idp.issuer)).rejects.toBeInstanceOf(Unreachable);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await expect(discover(down, idp.issuer)).rejects.toBeInstanceOf(Unreachable);
});

test("a sign-in: PKCE, state and nonce, a code once, and a refresh token that rotates", async () => {
  const endpoints = await discover(fetch, idp.issuer);
  const back = catcher();
  try {
    const attempt = newAttempt(back.redirectUri);
    const url = new URL(authorizeUrl(endpoints, client(), attempt));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("code_challenge")).not.toBe(attempt.verifier);
    expect(await idp.browse(url.href)).toBe(200);
    const code = back.seen()?.searchParams.get("code") ?? "";
    expect(back.seen()?.searchParams.get("state")).toBe(attempt.state);

    const tokens = await exchangeCode(fetch, endpoints, client(), attempt, code);
    expect(identityOf(tokens.idToken ?? "", client(), { nonce: attempt.nonce })).toEqual({
      sub: "user-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    // The code is good once.
    await expect(exchangeCode(fetch, endpoints, client(), attempt, code)).rejects.toBeInstanceOf(
      SignInRequired,
    );

    const renewed = await refreshTokens(fetch, endpoints, client(), tokens.refreshToken ?? "");
    expect(renewed.refreshToken).not.toBe(tokens.refreshToken);
    expect(subjectOf(renewed)).toBe("user-1");
    // The one before is spent.
    await expect(
      refreshTokens(fetch, endpoints, client(), tokens.refreshToken ?? ""),
    ).rejects.toBeInstanceOf(SignInRequired);

    await revokeToken(fetch, endpoints, client(), renewed.refreshToken ?? "");
    expect(idp.live(renewed.refreshToken ?? "")).toBe(false);
  } finally {
    back.stop();
  }
});

test("a code is refused without the verifier it was asked with", async () => {
  const endpoints = await discover(fetch, idp.issuer);
  const back = catcher();
  try {
    const attempt = newAttempt(back.redirectUri);
    await idp.browse(authorizeUrl(endpoints, client(), attempt));
    const code = back.seen()?.searchParams.get("code") ?? "";
    await expect(
      exchangeCode(fetch, endpoints, client(), { ...attempt, verifier: "another" }, code),
    ).rejects.toBeInstanceOf(SignInRequired);
  } finally {
    back.stop();
  }
});

test("the provider refuses a redirect that is not a loopback /callback", async () => {
  const endpoints = await discover(fetch, idp.issuer);
  for (const redirect of ["http://localhost:9/callback", "http://127.0.0.1:9/other"])
    expect(await idp.browse(authorizeUrl(endpoints, client(), newAttempt(redirect)))).toBe(400);
});

test("an ID token is checked: issuer, audience, expiry, nonce", () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims: object) => `${part({ alg: "none" })}.${part(claims)}.`;
  const now = Date.now();
  const good = { iss: idp.issuer, aud: idp.clientId, exp: now / 1000 + 60, sub: "u", nonce: "n" };
  expect(identityOf(jwt(good), client(), { nonce: "n" }).sub).toBe("u");
  expect(() => identityOf(jwt({ ...good, iss: "https://x/" }), client())).toThrow("issuer");
  expect(() => identityOf(jwt({ ...good, aud: "other" }), client())).toThrow("application");
  expect(() => identityOf(jwt({ ...good, exp: now / 1000 - 3600 }), client())).toThrow("expired");
  expect(() => identityOf(jwt(good), client(), { nonce: "m" })).toThrow("not for this");
  expect(() => identityOf("garbage", client())).toThrow();
});

test("no error says a token", async () => {
  const endpoints = await discover(fetch, idp.issuer);
  const secret = idp.issueRefreshToken();
  idp.revokeAll();
  const messages: string[] = [];
  for (const run of [
    () => refreshTokens(fetch, endpoints, client(), secret),
    () => refreshTokens(fetch, { ...endpoints, token: `${idp.issuer}nowhere` }, client(), secret),
    () => revokeToken(fetch, endpoints, { ...client(), clientId: "wrong" }, secret),
  ])
    await run().catch((error: Error) => messages.push(`${error.name} ${error.message}`));
  expect(messages).toHaveLength(3);
  for (const message of messages) expect(message).not.toContain(secret);
});

test("secrets are compared whole", () => {
  expect(sameSecret("abc", "abc")).toBe(true);
  expect(sameSecret("abc", "abd")).toBe(false);
  expect(sameSecret("abc", "abcd")).toBe(false);
});
