import type { Connector } from "@cycle/protocol";
import { CycleErrorCode } from "@cycle/protocol";
import { RESOURCE_NOT_FOUND, RpcError } from "../errors.ts";
import type { OAuthBroker } from "./oauth.ts";
import { invalid } from "./rules.ts";
import type { ConnectorState } from "./state.ts";
import type { Credentials } from "./store.ts";

/** Signing in to a connector (OAuth, in the daemon: oauth.ts), signing out, and keeping its token fresh. */
export class ConnectorSignIn {
  readonly #state: ConnectorState;
  readonly #broker: OAuthBroker;
  /** One refresh at a time for a connector: two would each spend the same refresh token. */
  readonly #refreshing = new Map<string, Promise<boolean>>();

  constructor(state: ConnectorState, broker: OAuthBroker) {
    this.#state = state;
    this.#broker = broker;
  }

  /** Drops a sign-in under way and revokes the tokens held: they go nowhere again. */
  async signOut(id: string): Promise<void> {
    this.#broker.forget(id);
    await this.#broker.revoke(await this.#state.vault.get(id));
  }

  async start(
    id: string,
    redirectUri: string,
  ): Promise<{ flowId: string; authorizationUrl: string }> {
    const entry = await this.#state.entry(id);
    if (entry.auth.type !== "oauth" || entry.transport.type !== "http") {
      throw invalid("This connector does not sign in", "oauth_needs_http");
    }
    const begun = await this.#broker.begin({
      connectorId: id,
      serverUrl: entry.transport.url,
      redirectUri,
      ...(entry.auth.clientId !== undefined ? { clientId: entry.auth.clientId } : {}),
      ...(entry.auth.scopes !== undefined ? { scopes: entry.auth.scopes } : {}),
      credentials: await this.#state.vault.get(id),
    });
    const { tokens: _old, ...found } = begun.credentials.oauth ?? ({} as never);
    await this.#state.mutate(id, (current) => ({
      ...current,
      oauth: {
        ...found,
        // Tokens from before stay usable until this sign-in succeeds; whatever they are now.
        ...(current.oauth?.tokens !== undefined ? { tokens: current.oauth.tokens } : {}),
      },
    }));
    return { flowId: begun.flowId, authorizationUrl: begun.authorizationUrl };
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
    const entry = await this.#state.entry(flow.connectorId);
    const exchanged = await this.#broker.exchange(
      flow,
      params.code,
      await this.#state.vault.get(entry.id),
    );
    await this.#state.mutate(entry.id, (current) => ({
      ...current,
      oauth: {
        ...(exchanged.oauth as NonNullable<Credentials["oauth"]>),
        ...(current.oauth ?? {}),
        tokens: exchanged.oauth?.tokens,
      },
    }));
    this.#state.reset(entry.id);
    this.#state.changed();
    return this.#state.view(entry);
  }

  async clear(id: string): Promise<Connector> {
    const entry = await this.#state.entry(id);
    await this.signOut(id);
    await this.#state.mutate(id, (current) => {
      const { oauth: _gone, ...rest } = current;
      return rest;
    });
    this.#state.reset(id);
    this.#state.changed();
    return this.#state.view(entry);
  }

  /** Refreshes once for everyone waiting on the same expired token. */
  refresh(connectorId: string, stale: Credentials): Promise<boolean> {
    const running = this.#refreshing.get(connectorId);
    if (running !== undefined) return running;
    const run = (async () => {
      const current = await this.#state.vault.get(connectorId);
      // Someone else already refreshed since the token that failed was read.
      if (current.oauth?.tokens?.accessToken !== stale.oauth?.tokens?.accessToken) return true;
      const refreshed = await this.#broker.refresh(current);
      const tokens = refreshed?.oauth?.tokens;
      if (tokens === undefined) return false;
      // Only onto the tokens it replaces: a sign-out or a new sign-in meanwhile wins.
      return this.#state.mutate(connectorId, (now) =>
        now.oauth !== undefined &&
        now.oauth.tokens?.accessToken === stale.oauth?.tokens?.accessToken
          ? { ...now, oauth: { ...now.oauth, tokens } }
          : undefined,
      );
    })().finally(() => this.#refreshing.delete(connectorId));
    this.#refreshing.set(connectorId, run);
    return run;
  }
}
