import type { Connector } from "@cycle/protocol";
import { CycleErrorCode } from "@cycle/protocol";
import { RESOURCE_NOT_FOUND, RpcError } from "../errors.ts";
import type { AuthFlow, OAuthBroker } from "./oauth.ts";
import { invalid, serverOf } from "./rules.ts";
import type { ConnectorState } from "./state.ts";
import type { CatalogEntry, Credentials } from "./store.ts";

/** Signing in to a connector (OAuth, in the daemon: oauth.ts), signing out, and keeping its token fresh. */
export class ConnectorSignIn {
  readonly #state: ConnectorState;
  readonly #broker: OAuthBroker;
  /** One refresh at a time for a connector: two would each spend the same refresh token. */
  readonly #refreshing = new Map<string, Promise<boolean>>();
  /**
   * Moved on whenever a connector's sign-in is ended (sign-out, server change, removal). An
   * in-flight start, finish, or refresh from before the bump refuses to write back and revokes
   * any tokens it just obtained.
   */
  readonly #epochs = new Map<string, number>();
  /** Connectors currently moving, clearing, or being removed: no sign-in may start or commit during the transition. */
  readonly #detaching = new Map<string, number>();
  /** The server identity and epoch each activated flow belongs to. */
  readonly #flowMeta = new WeakMap<AuthFlow, { server: string; epoch: number }>();

  constructor(state: ConnectorState, broker: OAuthBroker) {
    this.#state = state;
    this.#broker = broker;
  }

  #epoch(id: string): number {
    return this.#epochs.get(id) ?? 0;
  }

  #isDetaching(id: string): boolean {
    return (this.#detaching.get(id) ?? 0) > 0;
  }

  #invalidate(id: string): void {
    this.#epochs.set(id, this.#epoch(id) + 1);
    this.#broker.forget(id);
    this.#refreshing.delete(id);
  }

  /**
   * Ends any sign-in under way, clears stored OAuth credentials (or runs `transform` alongside
   * another vault edit), and keeps new sign-ins from starting or committing until `release()` is
   * called after local catalog state is updated. Returns the removed credentials for revocation.
   */
  async beginDetach(
    id: string,
    transform: (current: Credentials) => Credentials | undefined = (current) => {
      if (current.oauth === undefined) return undefined;
      const { oauth: _gone, ...rest } = current;
      return rest;
    },
  ): Promise<{ revoked: Credentials | undefined; release: () => void }> {
    this.#detaching.set(id, (this.#detaching.get(id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (this.#detaching.get(id) ?? 1) - 1;
      if (left <= 0) this.#detaching.delete(id);
      else this.#detaching.set(id, left);
    };
    try {
      this.#invalidate(id);
      let revoked: Credentials | undefined;
      await this.#state.mutate(id, (current) => {
        if (current.oauth !== undefined) revoked = current;
        return transform(current);
      });
      return { revoked, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Tells the authorization server to forget tokens that were detached or discarded. */
  async revoke(credentials: Credentials | undefined): Promise<void> {
    if (credentials !== undefined) await this.#broker.revoke(credentials);
  }

  async start(
    id: string,
    redirectUri: string,
  ): Promise<{ flowId: string; authorizationUrl: string }> {
    const entry = await this.#state.entry(id);
    if (entry.auth.type !== "oauth" || entry.transport.type !== "http") {
      throw invalid("This connector does not sign in", "oauth_needs_http");
    }
    if (this.#isDetaching(id)) {
      throw new RpcError(CycleErrorCode.ConnectorFailed, "The connector changed while signing in", {
        reason: "auth_rejected",
      });
    }
    const server = serverOf(entry);
    const epoch = this.#epoch(id);
    const begun = await this.#broker.begin({
      connectorId: id,
      serverUrl: entry.transport.url,
      redirectUri,
      ...(entry.auth.clientId !== undefined ? { clientId: entry.auth.clientId } : {}),
      ...(entry.auth.scopes !== undefined ? { scopes: entry.auth.scopes } : {}),
      credentials: await this.#state.vault.get(id),
    });
    let activated = false;
    let saved = false;
    try {
      saved = await this.#state.mutate(id, (current, now) => {
        if (this.#isDetaching(id) || this.#epoch(id) !== epoch || serverOf(now) !== server) {
          return undefined;
        }
        this.#flowMeta.set(begun.flow, { server, epoch });
        this.#broker.activate(begun.flow);
        activated = true;
        return {
          ...current,
          oauth: {
            ...begun.flow.oauth,
            // Tokens from before stay usable until this sign-in succeeds; whatever they are now.
            ...(current.oauth?.tokens !== undefined ? { tokens: current.oauth.tokens } : {}),
          },
        };
      });
    } catch (error) {
      if (activated) this.#broker.take(begun.flow.flowId);
      throw error;
    }
    if (!saved) {
      if ((await this.#state.catalog.get(id)) === undefined) {
        throw new RpcError(RESOURCE_NOT_FOUND, "No such connector", { id });
      }
      throw new RpcError(CycleErrorCode.ConnectorFailed, "The connector changed while signing in", {
        reason: "auth_rejected",
      });
    }
    return { flowId: begun.flow.flowId, authorizationUrl: begun.authorizationUrl };
  }

  async finish(params: {
    flowId: string;
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
  }): Promise<Connector> {
    const flow = this.#broker.take(params.flowId);
    if (flow === undefined) {
      throw new RpcError(RESOURCE_NOT_FOUND, "That sign-in is over", { flowId: params.flowId });
    }
    if (params.error !== undefined) {
      throw new RpcError(CycleErrorCode.ConnectorFailed, "The connector's sign-in failed", {
        reason: "auth_rejected",
      });
    }
    if (params.state !== flow.state) {
      throw invalid("The sign-in does not match", "state_mismatch");
    }
    if (params.code === undefined) throw invalid("No code came back", "auth_rejected");
    const meta = this.#flowMeta.get(flow);
    const id = flow.connectorId;
    if (meta === undefined || this.#isDetaching(id) || this.#epoch(id) !== meta.epoch) {
      if ((await this.#state.catalog.get(id)) === undefined) {
        throw new RpcError(RESOURCE_NOT_FOUND, "No such connector", { id });
      }
      throw new RpcError(CycleErrorCode.ConnectorFailed, "The connector changed while signing in", {
        reason: "auth_rejected",
      });
    }
    const entry = await this.#state.entry(id);
    if (
      this.#isDetaching(id) ||
      this.#epoch(id) !== meta.epoch ||
      serverOf(entry) !== meta.server
    ) {
      throw new RpcError(CycleErrorCode.ConnectorFailed, "The connector changed while signing in", {
        reason: "auth_rejected",
      });
    }
    const exchanged = await this.#broker.exchange(flow, params.code);
    let latest: CatalogEntry | undefined;
    const saved = await this.#state.mutate(id, (current, now) => {
      if (
        this.#isDetaching(id) ||
        this.#epoch(id) !== meta.epoch ||
        serverOf(now) !== meta.server
      ) {
        return undefined;
      }
      latest = now;
      return {
        ...current,
        oauth: exchanged.oauth as NonNullable<Credentials["oauth"]>,
      };
    });
    if (!saved || latest === undefined) {
      // Removed, moved, or signed out while exchanging the code: revoke the tokens just issued.
      await this.#broker.revoke(exchanged);
      if ((await this.#state.catalog.get(id)) === undefined) {
        throw new RpcError(RESOURCE_NOT_FOUND, "No such connector", { id });
      }
      throw new RpcError(CycleErrorCode.ConnectorFailed, "The connector changed while signing in", {
        reason: "auth_rejected",
      });
    }
    this.#state.reset(id);
    this.#state.changed();
    return this.#state.view(latest);
  }

  async clear(id: string): Promise<Connector> {
    const entry = await this.#state.entry(id);
    const { revoked, release } = await this.beginDetach(id);
    try {
      this.#state.reset(id);
    } finally {
      release();
    }
    this.#state.changed();
    await this.revoke(revoked);
    return this.#state.view((await this.#state.catalog.get(id)) ?? entry);
  }

  async #revokeDiscarded(
    discarded: Credentials,
    current: Credentials | undefined,
    invalidated: boolean,
  ): Promise<void> {
    if (invalidated || current?.oauth?.tokens === undefined) {
      await this.#broker.revoke(discarded);
      return;
    }
    const oauth = discarded.oauth;
    const tokens = oauth?.tokens;
    if (oauth === undefined || tokens === undefined) return;
    const keep = current.oauth.tokens;
    const refreshToken =
      tokens.refreshToken !== undefined && tokens.refreshToken !== keep.refreshToken
        ? tokens.refreshToken
        : undefined;
    const accessToken = tokens.accessToken !== keep.accessToken ? tokens.accessToken : "";
    if (accessToken === "" && refreshToken === undefined) return;
    await this.#broker.revoke({
      ...discarded,
      oauth: {
        ...oauth,
        tokens: {
          accessToken,
          ...(refreshToken !== undefined ? { refreshToken } : {}),
        },
      },
    });
  }

  /** Refreshes once for everyone waiting on the same expired token. */
  refresh(connectorId: string, stale: Credentials): Promise<boolean> {
    const running = this.#refreshing.get(connectorId);
    if (running !== undefined) return running;
    const run = (async () => {
      if (this.#isDetaching(connectorId)) return false;
      const entry = await this.#state.catalog.get(connectorId);
      if (entry === undefined || entry.auth.type !== "oauth") return false;
      const server = serverOf(entry);
      const epoch = this.#epoch(connectorId);
      const current = await this.#state.vault.get(connectorId);
      // Signed out meanwhile: nothing to refresh.
      if (this.#isDetaching(connectorId) || this.#epoch(connectorId) !== epoch) return false;
      if (current.oauth?.tokens === undefined) return false;
      // Someone else already refreshed since the token that failed was read.
      if (current.oauth.tokens.accessToken !== stale.oauth?.tokens?.accessToken) return true;
      const refreshed = await this.#broker.refresh(current);
      const tokens = refreshed?.oauth?.tokens;
      if (refreshed === undefined || tokens === undefined) return false;
      // Only onto the tokens it replaces, for the same server and sign-in: a sign-out, server
      // change, removal, or new sign-in meanwhile wins, and the newly-issued tokens are revoked.
      let replaced: Credentials | undefined;
      const stored = await this.#state.mutate(connectorId, (now, nowEntry) => {
        if (
          this.#isDetaching(connectorId) ||
          this.#epoch(connectorId) !== epoch ||
          serverOf(nowEntry) !== server ||
          now.oauth === undefined ||
          now.oauth.tokens?.accessToken !== stale.oauth?.tokens?.accessToken
        ) {
          replaced = now;
          return undefined;
        }
        return { ...now, oauth: { ...now.oauth, tokens } };
      });
      if (!stored) {
        await this.#revokeDiscarded(
          refreshed,
          replaced,
          this.#epoch(connectorId) !== epoch || this.#isDetaching(connectorId),
        );
      }
      return stored;
    })().finally(() => {
      if (this.#refreshing.get(connectorId) === run) this.#refreshing.delete(connectorId);
    });
    this.#refreshing.set(connectorId, run);
    return run;
  }
}
