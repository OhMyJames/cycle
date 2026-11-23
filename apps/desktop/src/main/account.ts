// The person's Cycle account: signing in to the SSO, keeping the login, renewing it, and signing out
// (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md). Only the main process holds it. The page is told how it stands and who is signed
// in, never a token; the daemon and the agents are told nothing (a service's own credential, exchanged from this one,
// is CYCL-162's).
//
// The refresh token rotates: each renewal makes the one before worthless, and using one twice ends the whole login. So
// there is one holder (this object), one renewal at a time (the others wait for it), and every renewal is saved before
// its tokens are used.

import {
  type Attempt,
  allowedEndpoint,
  authorizeUrl,
  CLAWDOT_SSO,
  discover,
  type Endpoints,
  exchangeCode,
  type Fetch,
  identityOf,
  newAttempt,
  type OidcClient,
  Refused,
  refreshTokens,
  revokeToken,
  SignInRequired,
  sameSecret,
  subjectOf,
  type Tokens,
  Unreachable,
} from "@cycle/oidc";
import type { AccountStatus } from "@cycle/ui/api";
import { authorizeInBrowser, type OpenBrowser } from "./connector-auth.ts";

/** How long the app opens without the provider having taken the login: from the last sign-in or renewal. */
export const GRACE_MS = 30 * 24 * 60 * 60_000;
/** An access token with less than this left is renewed before it is used. */
export const REFRESH_MARGIN_MS = 2 * 60_000;
/** How long the start waits for the provider to confirm the login before it opens the app anyway (offline). */
export const STARTUP_CHECK_MS = 5_000;
/** How often a login that could not be renewed tries again; and, once a day, a login is renewed to keep it alive. */
const RETRY_MS = 5 * 60_000;
const KEEP_ALIVE_MS = 24 * 60 * 60_000;

/** What is kept between runs. The refresh token is the secret; the rest says whose it is. */
export type SavedAccount = {
  issuer: string;
  clientId: string;
  sub: string;
  name: string;
  email: string;
  /** When the provider last took the login (a sign-in or a renewal), in milliseconds since the epoch. */
  renewedAt: number;
  /**
   * Absent once signed out or refused: who it was is kept only to tell, at the next sign-in, that someone else signed
   * in.
   */
  refreshToken?: string;
};

/** Where the account is kept: the keychain in the installed app; a file of its own in a test or a run from source. */
export type AccountStore = {
  load(): Promise<SavedAccount | undefined>;
  save(account: SavedAccount): Promise<void>;
  clear(): Promise<void>;
};

export type AccountDeps = {
  client: OidcClient;
  store: AccountStore;
  /** Opens the sign-in page in the person's browser (`shell.openExternal`). */
  open: OpenBrowser;
  fetch?: Fetch;
  now?: () => number;
  /** Told every time the status changes. */
  onChange?: (status: AccountStatus) => void;
  track?: (name: AccountEvent, props: Record<string, string | boolean>) => void;
  /** A line for the log. Never given a token: only what happened, in words. */
  log?: (message: string) => void;
  /** How long the browser has to come back. Default ten minutes. */
  signInTimeoutMs?: number;
};

export type AccountEvent =
  | "sign_in_shown"
  | "signed_in"
  | "sign_in_required"
  | "offline_grace"
  | "signed_out"
  | "account_switched";

/** What has to be done before an account's login ends: a service's credentials cleared (CYCL-162). */
export type SignOutHook = (account: { sub: string }) => Promise<void>;

/** Why an error happened, as a word: never its message, which may be the provider's. */
const kindOf = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error === "string" ? "string" : "unknown";

export class Account {
  readonly #deps: AccountDeps;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  #saved: SavedAccount | undefined;
  #tokens: Tokens | undefined;
  #endpoints: Promise<Endpoints> | undefined;
  #renewing: Promise<Tokens> | undefined;
  #signing: { controller: AbortController; done: Promise<AccountStatus> } | undefined;
  /** Counts sign-ins and sign-outs: a renewal that started before one does not save over it. */
  #epoch = 0;
  /** The start is confirming the login: a refusal then is the sign-in page's, not a note over an open window. */
  #starting = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #hooks = new Set<SignOutHook>();
  #status: AccountStatus = { state: "signed-out", open: false, signingIn: false };

  constructor(deps: AccountDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetch ?? fetch;
    this.#now = deps.now ?? Date.now;
  }

  status(): AccountStatus {
    return this.#status;
  }

  /** Runs before every sign-out, and before a sign-in as someone else replaces the login. Returns what removes it. */
  onSignOut(hook: SignOutHook): () => void {
    this.#hooks.add(hook);
    return () => this.#hooks.delete(hook);
  }

  /**
   * Reads what was kept and decides whether the app opens. A login within its grace is confirmed with the provider for
   * at most `STARTUP_CHECK_MS`: refused there, the sign-in page is shown; not reachable, the app opens offline.
   */
  async start(): Promise<AccountStatus> {
    let saved: SavedAccount | undefined;
    try {
      saved = await this.#deps.store.load();
    } catch (error) {
      this.#log(`the saved login could not be read (${kindOf(error)})`);
    }
    // A login of another provider or application (the issuer was changed for a test) is not this one.
    if (
      saved !== undefined &&
      (saved.issuer !== this.#deps.client.issuer || saved.clientId !== this.#deps.client.clientId)
    )
      saved = undefined;
    this.#saved = saved;
    if (saved?.refreshToken === undefined) {
      this.#gate(saved === undefined ? "new" : "signed_out");
    } else if (this.#now() - saved.renewedAt > GRACE_MS) {
      this.#gate("expired");
    } else {
      this.#set({ state: "signed-in", open: true, signingIn: false, user: userOf(saved) });
      this.#starting = true;
      const check = this.#renew().then(
        () => undefined,
        () => undefined,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        check,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STARTUP_CHECK_MS);
        }),
      ]);
      clearTimeout(timer);
      this.#starting = false;
      // Refused before the window opened: nothing is running yet, so the sign-in page is what is shown.
      if (this.#status.state === "reauth") this.#gate("revoked");
    }
    this.#timer = setInterval(() => this.#tick(), RETRY_MS);
    this.#timer.unref?.();
    return this.#status;
  }

  close(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#signing?.controller.abort();
  }

  /**
   * An access token for the SSO, renewed first when it has less than two minutes left. Throws `SignInRequired` when
   * there is no login or the provider refused it, `Unreachable` when it could not be asked. Main's only: never sent to
   * the page or a daemon.
   */
  async accessToken(): Promise<string> {
    const tokens = this.#tokens;
    if (tokens !== undefined && tokens.expiresAt - this.#now() > REFRESH_MARGIN_MS)
      return tokens.accessToken;
    return (await this.#renew()).accessToken;
  }

  /** Signs in in the browser. One at a time: asked again while one waits, it answers when that one ends. */
  signIn(): Promise<AccountStatus> {
    if (this.#signing !== undefined) return this.#signing.done;
    const controller = new AbortController();
    const done = this.#signInOnce(controller.signal).finally(() => {
      this.#signing = undefined;
    });
    this.#signing = { controller, done };
    return done;
  }

  /** Stops waiting for the browser. */
  cancelSignIn(): void {
    this.#signing?.controller.abort();
  }

  /**
   * Ends the login: what was registered with `onSignOut` runs, it is forgotten here and the sign-in page is shown, and
   * then the refresh token is revoked with the provider (a failure there is only logged). Forgotten before the provider
   * is asked: offline, the revocation can take its whole timeout, and quitting meanwhile must not leave the person signed
   * in. Nothing else of this machine's is touched.
   */
  async signOut(): Promise<void> {
    this.#signing?.controller.abort();
    this.#epoch++;
    const saved = this.#saved;
    if (saved === undefined) return this.#gate("signed_out");
    await this.#runHooks(saved);
    await this.#forget(saved);
    this.#gate("signed_out");
    const revoked = await this.#revoke(saved.refreshToken);
    this.#track("signed_out", { revoked });
  }

  // ---- inside ----

  async #signInOnce(signal: AbortSignal): Promise<AccountStatus> {
    const { problem: _problem, switched: _switched, ...before } = this.#status;
    this.#set({ ...before, signingIn: true });
    // A sign-out while the browser is open ends this sign-in too.
    const epoch = this.#epoch;
    try {
      const endpoints = await this.#discover();
      let attempt: Attempt | undefined;
      const outcome = await authorizeInBrowser({
        start: async (redirectUri) => {
          attempt = newAttempt(redirectUri);
          return {
            flowId: "sso",
            authorizationUrl: authorizeUrl(endpoints, this.#deps.client, attempt),
          };
        },
        finish: async ({ code, state, error }) => {
          if (error !== undefined || attempt === undefined) return undefined;
          // Only the answer to the request this sign-in made: compared in constant time (RFC 6749 §10.12).
          if (state === undefined || !sameSecret(state, attempt.state))
            throw new Refused("The sign-in came back for another request", "invalid_state");
          if (code === undefined)
            throw new Refused("The sign-in came back without a code", "no_code");
          const tokens = await exchangeCode(
            this.#fetch,
            endpoints,
            this.#deps.client,
            attempt,
            code,
            this.#now,
          );
          if (tokens.idToken === undefined)
            throw new Refused("The sign-in gave no ID token", "no_id_token");
          if (tokens.refreshToken === undefined)
            throw new Refused("The sign-in gave no refresh token", "no_refresh_token");
          const identity = identityOf(tokens.idToken, this.#deps.client, {
            nonce: attempt.nonce,
            now: this.#now(),
          });
          return { tokens, identity };
        },
        open: this.#deps.open,
        signal,
        ...(this.#deps.signInTimeoutMs !== undefined
          ? { timeoutMs: this.#deps.signInTimeoutMs }
          : {}),
      });
      if (outcome.kind !== "done" || outcome.value === undefined) {
        const result = outcome.kind === "refused" ? "failed" : "cancelled";
        this.#track("signed_in", { result });
        return this.#set({
          ...this.#status,
          signingIn: false,
          ...(result === "failed" ? { problem: "failed" as const } : {}),
        });
      }
      if (epoch !== this.#epoch) {
        // Signed out while the code was being exchanged: what it got is not kept, and not left valid either.
        void this.#revoke(outcome.value.tokens.refreshToken);
        return this.#set({ ...this.#status, signingIn: false });
      }
      // A renewal of the old login that is still out does not save over this one.
      this.#epoch++;
      const { tokens, identity } = outcome.value;
      const previous = this.#saved;
      const switched = previous !== undefined && previous.sub !== identity.sub;
      // Someone else's login is ended as a sign-out ends it; the same person's old refresh token is only revoked.
      if (switched) await this.#runHooks(previous);
      // Not waited for: offline it could take its whole timeout, and the new login does not depend on it.
      if (previous?.refreshToken !== undefined) void this.#revoke(previous.refreshToken);
      const saved: SavedAccount = {
        issuer: this.#deps.client.issuer,
        clientId: this.#deps.client.clientId,
        sub: identity.sub,
        name: identity.name,
        email: identity.email,
        renewedAt: this.#now(),
        refreshToken: tokens.refreshToken as string,
      };
      try {
        await this.#deps.store.save(saved);
      } catch (error) {
        // No keychain to keep it in: signed in for this run, and asked again at the next start.
        this.#log(`the login could not be kept (${kindOf(error)})`);
      }
      this.#saved = saved;
      this.#tokens = tokens;
      this.#track("signed_in", { result: "ok" });
      if (previous !== undefined) this.#track("account_switched", { switched });
      return this.#set({
        state: "signed-in",
        open: true,
        signingIn: false,
        user: userOf(saved),
        ...(switched ? { switched: true } : {}),
      });
    } catch (error) {
      this.#log(`sign-in failed (${kindOf(error)})`);
      this.#track("signed_in", { result: "failed" });
      return this.#set({
        ...this.#status,
        signingIn: false,
        problem: error instanceof Unreachable ? "unreachable" : "failed",
      });
    }
  }

  /** One renewal at a time; each caller gets its result. The new refresh token is saved before the tokens are used. */
  #renew(): Promise<Tokens> {
    if (this.#renewing !== undefined) return this.#renewing;
    const run = this.#renewOnce().finally(() => {
      this.#renewing = undefined;
    });
    this.#renewing = run;
    return run;
  }

  async #renewOnce(): Promise<Tokens> {
    const saved = this.#saved;
    const epoch = this.#epoch;
    if (saved?.refreshToken === undefined) throw new SignInRequired("Not signed in");
    let tokens: Tokens;
    try {
      tokens = await refreshTokens(
        this.#fetch,
        await this.#discover(),
        this.#deps.client,
        saved.refreshToken,
        this.#now,
      );
    } catch (error) {
      if (epoch !== this.#epoch) throw error;
      if (error instanceof SignInRequired) {
        await this.#refused(saved, "revoked");
      } else {
        // Not reachable, or a refusal that is not about the login: it stands, within its grace.
        this.#endpoints = undefined;
        this.#offline();
      }
      throw error;
    }
    // Signed out or in again meanwhile: what this renewal got is not the login any more.
    if (epoch !== this.#epoch) {
      if (tokens.refreshToken !== undefined) void this.#revoke(tokens.refreshToken);
      throw new SignInRequired("The login changed during a renewal");
    }
    const sub = subjectOf(tokens);
    if (sub !== undefined && sub !== saved.sub) {
      if (tokens.refreshToken !== undefined) void this.#revoke(tokens.refreshToken);
      await this.#refused(saved, "changed_account");
      throw new SignInRequired("The renewal was for someone else");
    }
    const next: SavedAccount = {
      ...saved,
      renewedAt: this.#now(),
      ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    };
    try {
      await this.#deps.store.save(next);
    } catch (error) {
      // The old refresh token is spent and the new one could not be kept: the login cannot outlive this run.
      this.#log(`the renewed login could not be saved (${kindOf(error)})`);
    }
    this.#saved = next;
    this.#tokens = tokens;
    this.#set({
      ...this.#status,
      state: this.#status.open ? "signed-in" : this.#status.state,
      user: userOf(next),
    });
    return tokens;
  }

  /** The provider will not take the login: kept as whose it was, without the token. The window stays as it is. */
  async #refused(saved: SavedAccount, reason: "revoked" | "changed_account"): Promise<void> {
    this.#log(`the login was refused (${reason})`);
    this.#tokens = undefined;
    await this.#forget(saved);
    if (!this.#starting) this.#track("sign_in_required", { reason });
    this.#set({ ...this.#status, state: "reauth" });
  }

  #offline(): void {
    if (this.#status.state !== "signed-in") return;
    this.#track("offline_grace", {});
    this.#set({ ...this.#status, state: "offline" });
  }

  async #forget(saved: SavedAccount): Promise<void> {
    const { refreshToken: _, ...kept } = saved;
    this.#saved = kept;
    this.#tokens = undefined;
    try {
      await this.#deps.store.save(kept);
    } catch (error) {
      this.#log(`the login could not be removed (${kindOf(error)})`);
    }
  }

  async #revoke(refreshToken: string | undefined): Promise<boolean> {
    if (refreshToken === undefined) return false;
    try {
      await revokeToken(this.#fetch, await this.#discover(), this.#deps.client, refreshToken);
      return true;
    } catch (error) {
      this.#endpoints = undefined;
      this.#log(`the refresh token could not be revoked (${kindOf(error)})`);
      return false;
    }
  }

  async #runHooks(saved: SavedAccount): Promise<void> {
    for (const hook of [...this.#hooks]) {
      try {
        await hook({ sub: saved.sub });
      } catch (error) {
        this.#log(`a sign-out step failed (${kindOf(error)})`);
      }
    }
  }

  /** The discovery document, read once and kept; read again after a failure. */
  #discover(): Promise<Endpoints> {
    if (this.#endpoints === undefined) {
      const reading = discover(this.#fetch, this.#deps.client.issuer);
      reading.catch(() => {
        if (this.#endpoints === reading) this.#endpoints = undefined;
      });
      this.#endpoints = reading;
    }
    return this.#endpoints;
  }

  /** The timer only says when to look: what is done is decided by the clock, which a sleep does not stop. */
  #tick(): void {
    const saved = this.#saved;
    if (saved?.refreshToken === undefined || !this.#status.open) return;
    if (this.#status.state === "offline" || this.#now() - saved.renewedAt > KEEP_ALIVE_MS)
      void this.#renew().catch(() => undefined);
  }

  #gate(reason: "new" | "signed_out" | "expired" | "revoked"): void {
    this.#tokens = undefined;
    this.#track("sign_in_shown", { reason });
    this.#set({
      state: "signed-out",
      open: false,
      signingIn: false,
      ...(reason === "expired" || reason === "revoked" ? { reason } : {}),
    });
  }

  #set(status: AccountStatus): AccountStatus {
    // Only the keys that have a value: the page is given nothing else.
    const clean = Object.fromEntries(
      Object.entries(status).filter(([, value]) => value !== undefined),
    ) as AccountStatus;
    this.#status = clean;
    this.#deps.onChange?.(clean);
    return clean;
  }

  #track(name: AccountEvent, props: Record<string, string | boolean>): void {
    this.#deps.track?.(name, props);
  }

  #log(message: string): void {
    this.#deps.log?.(message);
  }

  /** For a test: renew now, as a caller of `accessToken` would when the token is old. */
  renewNow(): Promise<Tokens> {
    return this.#renew();
  }
}

/**
 * Which provider to sign in with: Clawdot's SSO, or the stand-in a test names in `CYCLE_SSO_ISSUER`. Only an issuer on
 * this machine is taken, so the variable can point the app at a test's stand-in and nowhere else; it changes where the
 * login is asked for, never whether it is. `test` says the login is kept apart from the person's own.
 */
export const ssoClientFor = (
  env: Record<string, string | undefined>,
): { client: OidcClient; test: boolean } => {
  const issuer = env.CYCLE_SSO_ISSUER;
  if (issuer === undefined || issuer === "") return { client: CLAWDOT_SSO, test: false };
  const parsed = URL.canParse(issuer) ? new URL(issuer) : undefined;
  if (parsed === undefined || parsed.protocol !== "http:" || !allowedEndpoint(issuer))
    throw new Error("CYCLE_SSO_ISSUER must be an http address on this machine (a test's stand-in)");
  return { client: { issuer, clientId: CLAWDOT_SSO.clientId }, test: true };
};

const userOf = (saved: SavedAccount) => ({ name: saved.name, email: saved.email });
