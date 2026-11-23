// The login in the main process (CYCL-161, 166, 167), against a stand-in provider on this machine and a file of the
// test's own. Never the real SSO, never the keychain.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS } from "@cycle/analytics/events";
import { SignInRequired, Unreachable } from "@cycle/oidc";
import { type MockIdp, startMockIdp } from "@cycle/oidc/mock-idp";
import type { AccountStatus } from "@cycle/ui/api";
import {
  Account,
  type AccountDeps,
  GRACE_MS,
  type SavedAccount,
  ssoClientFor,
} from "../src/main/account.ts";
import {
  accountStoreFor,
  fileAccountStore,
  sealedAccountStore,
} from "../src/main/account-store.ts";

let idp: MockIdp;
let dir: string;
const started: Account[] = [];

beforeEach(async () => {
  idp = await startMockIdp();
  dir = mkdtempSync(join(tmpdir(), "cycle-account-"));
});
afterEach(async () => {
  for (const account of started.splice(0)) account.close();
  await idp.close();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;

/** An account and everything it said: its statuses, what it reported, what it logged, and the pages it opened. */
const make = (overrides: Partial<AccountDeps> & { browser?: "follow" | "stay" } = {}) => {
  const store = fileAccountStore(join(dir, "account.json"));
  const statuses: AccountStatus[] = [];
  const tracked: [string, Record<string, unknown>][] = [];
  const logs: string[] = [];
  const opened: string[] = [];
  const account = new Account({
    client: { issuer: idp.issuer, clientId: idp.clientId },
    store,
    open: async (url) => {
      opened.push(url);
      // The person's browser: goes to the page and comes back, as the provider sends it.
      if (overrides.browser !== "stay") void idp.browse(url);
    },
    onChange: (status) => statuses.push(status),
    track: (name, props) => tracked.push([name, props]),
    log: (line) => logs.push(line),
    ...overrides,
  });
  started.push(account);
  return { account, store, statuses, tracked, logs, opened };
};

/** What a sign-in that already happened left, for a test that starts signed in. */
const saved = (extra: Partial<SavedAccount> = {}): SavedAccount => ({
  issuer: idp.issuer,
  clientId: idp.clientId,
  sub: "user-1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  renewedAt: Date.now(),
  refreshToken: idp.issueRefreshToken(),
  ...extra,
});

test("signing in with the browser: the login is kept, and the page is told who, never a token", async () => {
  const { account, store, statuses, tracked, opened } = make();
  expect((await account.start()).open).toBe(false);
  const status = await account.signIn();
  expect(status).toEqual({
    state: "signed-in",
    open: true,
    signingIn: false,
    user: { name: "Ada Lovelace", email: "ada@example.com" },
  });
  expect(statuses.some((s) => s.signingIn)).toBe(true);
  const kept = await store.load();
  expect(kept?.sub).toBe("user-1");
  expect(kept?.refreshToken).toBeString();
  expect(idp.live(kept?.refreshToken ?? "")).toBe(true);
  expect(statSync(join(dir, "account.json")).mode & 0o777).toBe(0o600);
  expect(tracked).toEqual([
    ["sign_in_shown", { reason: "new" }],
    ["signed_in", { result: "ok" }],
  ]);
  // The callback took its one answer and is gone.
  const callback = new URL(opened[0] ?? "").searchParams.get("redirect_uri") ?? "";
  await expect(fetch(callback, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  // An access token is there for main, and nothing the page was told has it.
  const token = await account.accessToken();
  expect(JSON.stringify(statuses)).not.toContain(token);
  expect(JSON.stringify(statuses)).not.toContain(kept?.refreshToken);
});

test("a callback with another state is refused, and nothing is kept", async () => {
  const { account, store } = make({
    open: async (url) => {
      void idp.browse(url, (callback) => callback.searchParams.set("state", "forged"));
    },
  });
  await account.start();
  const status = await account.signIn();
  expect(status.open).toBe(false);
  expect(status.problem).toBe("failed");
  expect(idp.stats.exchanged).toBe(0);
  expect(await store.load()).toBeUndefined();
});

test("a sign-in the provider sends back with the person's no is cancelled, not failed", async () => {
  idp.controls.deny = true;
  const { account, tracked } = make();
  await account.start();
  const status = await account.signIn();
  expect(status.open).toBe(false);
  expect(status.problem).toBeUndefined();
  expect(tracked.at(-1)).toEqual(["signed_in", { result: "cancelled" }]);
});

test("one sign-in waits at a time, and stopping it closes the callback", async () => {
  const { account, opened, tracked } = make({ browser: "stay" });
  await account.start();
  const first = account.signIn();
  const second = account.signIn();
  await Bun.sleep(50);
  expect(opened).toHaveLength(1);
  account.cancelSignIn();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(a.signingIn).toBe(false);
  expect(tracked.at(-1)).toEqual(["signed_in", { result: "cancelled" }]);
  const callback = new URL(opened[0] ?? "").searchParams.get("redirect_uri") ?? "";
  await expect(fetch(callback, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
});

test("a sign-in that is not answered within its time is given up", async () => {
  const { account } = make({ browser: "stay", signInTimeoutMs: 100 });
  await account.start();
  const status = await account.signIn();
  expect(status.signingIn).toBe(false);
  expect(status.open).toBe(false);
});

test("a provider that cannot be reached says so on the sign-in page", async () => {
  idp.controls.offline = true;
  const { account } = make();
  await account.start();
  expect((await account.signIn()).problem).toBe("unreachable");
});

test("two callers at once: one renewal, and the new refresh token is what is kept", async () => {
  const { account, store } = make();
  const before = saved();
  await store.save(before);
  idp.controls.holdRefresh = new Promise((resolve) => setTimeout(resolve, 50));
  // The start renews once to confirm the login; the two callers after it share one more.
  await account.start();
  expect(idp.stats.refreshed).toBe(1);
  const afterStart = (await store.load())?.refreshToken;
  expect(afterStart).not.toBe(before.refreshToken);
  expect(idp.live(before.refreshToken ?? "")).toBe(false);

  const [a, b] = await Promise.all([account.renewNow(), account.renewNow()]);
  expect(a).toBe(b);
  expect(idp.stats.refreshed).toBe(2);
  const kept = await store.load();
  expect(kept?.refreshToken).toBe(a.refreshToken ?? "");
  expect(idp.live(afterStart ?? "")).toBe(false);
  // An access token with time left is used as it is.
  expect(await account.accessToken()).toBe(a.accessToken);
  expect(idp.stats.refreshed).toBe(2);
});

test("an access token about to expire is renewed before it is used, by the clock and not a timer", async () => {
  let now = Date.now();
  const { account, store } = make({ now: () => now });
  await store.save(saved({ renewedAt: now }));
  await account.start();
  const first = await account.accessToken();
  now += 3600_000 - 60_000; // a minute left: less than the two-minute margin
  const second = await account.accessToken();
  expect(second).not.toBe(first);
  expect(idp.stats.refreshed).toBe(2);
});

test("a renewal that names someone else is refused", async () => {
  const { account, store, tracked } = make();
  await store.save(saved());
  await account.start();
  idp.controls.renewAs = "user-2";
  await expect(account.renewNow()).rejects.toBeInstanceOf(SignInRequired);
  expect(account.status().state).toBe("reauth");
  expect(account.status().open).toBe(true);
  expect((await store.load())?.refreshToken).toBeUndefined();
  expect(tracked).toContainEqual(["sign_in_required", { reason: "changed_account" }]);
});

test("invalid_grant while open asks to sign in again and keeps the window; no network is offline", async () => {
  const { account, store, tracked } = make();
  await store.save(saved());
  await account.start();
  expect(account.status().state).toBe("signed-in");

  idp.controls.offline = true;
  await expect(account.renewNow()).rejects.toBeInstanceOf(Unreachable);
  expect(account.status()).toMatchObject({ state: "offline", open: true });
  expect(tracked).toContainEqual(["offline_grace", {}]);
  // Still the login it was.
  expect((await store.load())?.refreshToken).toBeString();

  idp.controls.offline = false;
  await account.renewNow();
  expect(account.status().state).toBe("signed-in");

  idp.revokeAll();
  await expect(account.renewNow()).rejects.toBeInstanceOf(SignInRequired);
  expect(account.status()).toMatchObject({ state: "reauth", open: true });
  expect(tracked).toContainEqual(["sign_in_required", { reason: "revoked" }]);

  // Signing in again puts it back, and the note goes.
  const status = await account.signIn();
  expect(status).toMatchObject({ state: "signed-in", open: true });
  expect(status.switched).toBeUndefined();
});

test("the start: nobody, beyond the grace, refused, offline, or fine", async () => {
  // Nobody has signed in here.
  const nobody = make();
  expect(await nobody.account.start()).toMatchObject({ open: false, state: "signed-out" });
  expect(nobody.tracked).toEqual([["sign_in_shown", { reason: "new" }]]);
  nobody.account.close();

  // Signed out before.
  const store = fileAccountStore(join(dir, "account.json"));
  const { refreshToken: _, ...signedOut } = saved();
  await store.save(signedOut);
  const out = make();
  expect((await out.account.start()).open).toBe(false);
  expect(out.tracked).toEqual([["sign_in_shown", { reason: "signed_out" }]]);
  out.account.close();

  // Thirty days and more since the provider last took it: the sign-in page, and the provider is not even asked.
  await store.save(saved({ renewedAt: Date.now() - GRACE_MS - DAY }));
  const old = make();
  expect(await old.account.start()).toMatchObject({ open: false, reason: "expired" });
  expect(idp.stats.refreshed).toBe(0);
  old.account.close();

  // Within it, and the provider cannot be reached: open, offline.
  await store.save(saved({ renewedAt: Date.now() - 29 * DAY }));
  idp.controls.offline = true;
  const offline = make();
  expect(await offline.account.start()).toMatchObject({ open: true, state: "offline" });
  offline.account.close();
  idp.controls.offline = false;

  // Refused at the start: nothing runs yet, so the sign-in page.
  await store.save(saved());
  idp.revokeAll();
  const revoked = make();
  expect(await revoked.account.start()).toMatchObject({ open: false, reason: "revoked" });
  revoked.account.close();

  // Fine: open, and renewed.
  await store.save(saved({ renewedAt: Date.now() - 10 * DAY }));
  const fine = make();
  expect(await fine.account.start()).toMatchObject({ open: true, state: "signed-in" });
  expect((await store.load())?.renewedAt).toBeGreaterThan(Date.now() - 60_000);
});

test("a login of another provider or application is not this one", async () => {
  const store = fileAccountStore(join(dir, "account.json"));
  await store.save(saved({ issuer: "http://127.0.0.1:1/" }));
  const { account } = make();
  expect((await account.start()).open).toBe(false);
  await store.save(saved({ clientId: "another" }));
  const again = make();
  expect((await again.account.start()).open).toBe(false);
});

test("signing out revokes the refresh token, runs what was registered, and keeps no token", async () => {
  const { account, store, tracked } = make();
  const before = saved();
  await store.save(before);
  await account.start();
  const kept = (await store.load())?.refreshToken ?? "";
  const hooks: string[] = [];
  account.onSignOut(async ({ sub }) => {
    hooks.push(sub);
  });
  await account.signOut();
  expect(hooks).toEqual(["user-1"]);
  expect(idp.stats.revoked).toBe(1);
  expect(idp.live(kept)).toBe(false);
  expect((await store.load())?.refreshToken).toBeUndefined();
  expect(account.status()).toEqual({ state: "signed-out", open: false, signingIn: false });
  expect(tracked).toContainEqual(["signed_out", { revoked: true }]);
  await expect(account.accessToken()).rejects.toBeInstanceOf(SignInRequired);
});

test("signing out works when the provider cannot be reached: it is only logged", async () => {
  const { account, store, tracked, logs } = make();
  const before = saved();
  await store.save(before);
  await account.start();
  const token = (await store.load())?.refreshToken ?? "";
  idp.controls.offline = true;
  await account.signOut();
  expect(account.status().open).toBe(false);
  expect((await store.load())?.refreshToken).toBeUndefined();
  expect(tracked).toContainEqual(["signed_out", { revoked: false }]);
  expect(logs.some((line) => line.includes("could not be revoked"))).toBe(true);
  expect(logs.join("\n")).not.toContain(token);
});

test("someone else signing in is told, and what a sign-out does is done first; the same person is not", async () => {
  const { account, tracked } = make();
  await account.start();
  const hooks: string[] = [];
  account.onSignOut(async ({ sub }) => {
    hooks.push(sub);
  });
  await account.signIn();
  await account.signOut();
  expect(hooks).toEqual(["user-1"]);

  // The same person again.
  const same = await account.signIn();
  expect(same.switched).toBeUndefined();
  expect(tracked).toContainEqual(["account_switched", { switched: false }]);

  // Someone else, without signing out first (the login had ended): the old one is cleared for them.
  idp.revokeAll();
  await account.renewNow().catch(() => undefined);
  idp.controls.user = { sub: "user-2", name: "Grace Hopper", email: "grace@example.com" };
  const other = await account.signIn();
  expect(other).toMatchObject({ switched: true, user: { name: "Grace Hopper" } });
  expect(hooks).toEqual(["user-1", "user-1"]);
  expect(tracked).toContainEqual(["account_switched", { switched: true }]);
});

test("a sign-out while the browser is open ends that sign-in", async () => {
  const { account, store } = make({ browser: "stay" });
  await account.start();
  const signing = account.signIn();
  await Bun.sleep(20);
  await account.signOut();
  expect((await signing).open).toBe(false);
  expect(await store.load()).toBeUndefined();
});

test("no token reaches a log line, a status, an error or what is reported", async () => {
  const { account, store, statuses, tracked, logs } = make();
  await account.start();
  await account.signIn();
  await account.renewNow();
  idp.controls.offline = true;
  const errors: string[] = [];
  await account.renewNow().catch((e: Error) => errors.push(`${e.name}: ${e.message}`));
  idp.controls.offline = false;
  idp.revokeAll();
  await account.renewNow().catch((e: Error) => errors.push(`${e.name}: ${e.message}`));
  await account.signIn();
  idp.controls.offline = true;
  await account.signOut();
  // Every token the provider saw in a form, and the last one kept.
  const secrets = new Set<string>();
  for (const { form } of idp.requests)
    for (const key of ["refresh_token", "token", "code", "code_verifier"])
      if (form[key] !== undefined) secrets.add(form[key]);
  expect(secrets.size).toBeGreaterThan(3);
  const said = JSON.stringify({ statuses, tracked, logs, errors, kept: await store.load() });
  for (const secret of secrets) expect(said).not.toContain(secret);
  // What is reported is in the dictionary, words and booleans only.
  for (const [name, props] of tracked) {
    expect(EVENTS[name as keyof typeof EVENTS].safeParse(props).success).toBe(true);
    for (const value of Object.values(props)) expect(typeof value).not.toBe("number");
  }
});

test("CYCLE_SSO_ISSUER changes where, never whether, and only to this machine", () => {
  expect(ssoClientFor({})).toEqual({
    client: {
      issuer: "https://sso.shrimpdot.ai/application/o/clawdot-team/",
      clientId: "clawdot-team",
    },
    test: false,
  });
  expect(ssoClientFor({ CYCLE_SSO_ISSUER: "http://127.0.0.1:4000/" })).toEqual({
    client: { issuer: "http://127.0.0.1:4000/", clientId: "clawdot-team" },
    test: true,
  });
  expect(() => ssoClientFor({ CYCLE_SSO_ISSUER: "https://sso.example/" })).toThrow();
  expect(() => ssoClientFor({ CYCLE_SSO_ISSUER: "http://sso.example/" })).toThrow();
  expect(() => ssoClientFor({ CYCLE_SSO_ISSUER: "nonsense" })).toThrow();
});

test("the installed app, a run from source and a test each keep their own login", async () => {
  const sealer = {
    available: () => true,
    seal: (text: string) => Buffer.from(text, "utf8").reverse(),
    open: (sealed: Buffer) => Buffer.from(sealed).reverse().toString("utf8"),
  };
  const installed = accountStoreFor({ packaged: true, test: false, userData: dir, sealer });
  const source = accountStoreFor({ packaged: false, test: false, userData: dir, sealer });
  const packagedTest = accountStoreFor({ packaged: true, test: true, userData: dir, sealer });
  expect(installed.sealed).toBe(true);
  expect(source.sealed).toBe(false);
  expect(packagedTest.sealed).toBe(false);
  expect(new Set([installed.path, source.path, packagedTest.path]).size).toBe(3);

  const account = saved();
  await installed.store.save(account);
  expect(await installed.store.load()).toEqual(account);
  expect(await source.store.load()).toBeUndefined();
  expect(await packagedTest.store.load()).toBeUndefined();
  // Sealed: the token is not in the file as it is.
  expect((await Bun.file(installed.path).text()).includes(account.refreshToken ?? "")).toBe(false);
});

test("without a keychain nothing is kept, rather than a token in the clear", async () => {
  const store = sealedAccountStore(join(dir, "account.sealed"), {
    available: () => false,
    seal: () => Buffer.alloc(0),
    open: () => "",
  });
  await expect(store.save(saved())).rejects.toThrow("keychain");
  expect(await store.load()).toBeUndefined();
});

test("a sign-in that cannot be kept still signs in for this run", async () => {
  const noKeychain = sealedAccountStore(join(dir, "account.sealed"), {
    available: () => false,
    seal: () => Buffer.alloc(0),
    open: () => "",
  });
  const { account, logs } = make({ store: noKeychain });
  await account.start();
  expect((await account.signIn()).open).toBe(true);
  expect(await noKeychain.load()).toBeUndefined();
  expect(logs.some((line) => line.includes("could not be kept"))).toBe(true);
});

test("a refusal at the start is reported once, as the sign-in page's reason", async () => {
  const store = fileAccountStore(join(dir, "account.json"));
  await store.save(saved());
  idp.revokeAll();
  const { account, tracked } = make();
  expect(await account.start()).toMatchObject({ open: false, reason: "revoked" });
  expect(tracked).toEqual([["sign_in_shown", { reason: "revoked" }]]);
});

test("signing out forgets the login before the provider is asked, so a slow provider cannot keep it", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The provider answers the revocation only when released.
  const { account, store } = make({
    fetch: (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith("/revoke")) await slow;
      return fetch(input, init);
    }) as typeof fetch,
  });
  await store.save(saved());
  await account.start();
  const out = account.signOut();
  await Bun.sleep(50);
  expect(account.status().open).toBe(false);
  expect((await store.load())?.refreshToken).toBeUndefined();
  release();
  await out;
  expect(idp.stats.revoked).toBe(1);
});

test("a sign-in whose code comes back after a sign-out is not kept, and its refresh token is revoked", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { account, store } = make({
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === "object" ? String(init.body) : "";
      if (body.includes("authorization_code")) await slow;
      return fetch(input, init);
    }) as typeof fetch,
  });
  await account.start();
  const signing = account.signIn();
  // The browser came back and the code is being exchanged; the person signs out meanwhile.
  for (let i = 0; i < 100 && idp.stats.authorized === 0; i++) await Bun.sleep(10);
  await Bun.sleep(30);
  await account.signOut();
  release();
  expect((await signing).open).toBe(false);
  expect(await store.load()).toBeUndefined();
  for (let i = 0; i < 100 && idp.stats.revoked === 0; i++) await Bun.sleep(10);
  expect(idp.stats.revoked).toBe(1);
});
