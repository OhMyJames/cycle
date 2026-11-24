import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk/experimental/v2";
import type { Connector, connectorsAdd, connectorsUpdate } from "@cycle/protocol";
import type { z } from "zod";
import type { Fetch } from "./http-proxy.ts";
import { OAuthBroker } from "./oauth.ts";
import { PluginConnectors, type PluginServerSpec } from "./plugin-connectors.ts";
import { applySecrets, checkTransport, invalid, serverOf } from "./rules.ts";
import { ConnectorSignIn } from "./sign-in.ts";
import { ConnectorState } from "./state.ts";
import { bunSpawn, type Spawn } from "./stdio-bridge.ts";
import {
  type CatalogEntry,
  type ConnectorCatalog,
  type CredentialVault,
  FileConnectorCatalog,
  FileCredentialVault,
} from "./store.ts";
import { ConnectorTraffic } from "./traffic.ts";

export type { PluginServerSpec } from "./plugin-connectors.ts";
export { STDIO_ENV_ALLOWLIST } from "./traffic.ts";

/** Where the files live: `$CYCLE_HOME/connectors/`, 0700. */
export const connectorsDir = (dataDir: string): string => join(dataDir, "connectors");

type AddParams = z.infer<typeof connectorsAdd.params>;
type UpdateParams = z.infer<typeof connectorsUpdate.params>;

export type ConnectorServiceOptions = {
  catalog: ConnectorCatalog;
  vault: CredentialVault;
  fetch?: Fetch;
  now?: () => number;
  spawn?: Spawn;
  /** The daemon's own environment, read for the allowlist only. */
  env?: Record<string, string | undefined>;
};

/**
 * Connectors as Cycle keeps them (docs/protocol.md §14, note
 * 2026-11-19-connectors-behind-a-daemon-gateway). The catalog, the vault and the sign-in are each
 * behind their own interface; the gateway is started when the first agent needs it.
 *
 * What the daemon calls. It keeps the person's own edits (add, change, remove); the rest is done by its parts:
 * state.ts (catalog, vault, status), sign-in.ts (OAuth), plugin-connectors.ts (what plugins bring) and traffic.ts
 * (what agents get, and every request they make).
 */
export class ConnectorService {
  readonly #state: ConnectorState;
  readonly #signIn: ConnectorSignIn;
  readonly #plugins: PluginConnectors;
  readonly #traffic: ConnectorTraffic;

  constructor(options: ConnectorServiceOptions) {
    const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#state = new ConnectorState(options.catalog, options.vault);
    this.#signIn = new ConnectorSignIn(
      this.#state,
      new OAuthBroker({
        fetch: fetcher,
        ...(options.now !== undefined ? { now: options.now } : {}),
      }),
    );
    this.#plugins = new PluginConnectors(this.#state, this.#signIn, fetcher, (entry) =>
      this.#drop(entry),
    );
    this.#traffic = new ConnectorTraffic({
      state: this.#state,
      signIn: this.#signIn,
      plugins: this.#plugins,
      fetch: fetcher,
      spawn: options.spawn ?? bunSpawn,
      env: options.env ?? process.env,
    });
  }

  /** The files in `$CYCLE_HOME/connectors/`. Refuses to start when one is there and cannot be read. */
  static async load(
    dataDir: string,
    options: Omit<ConnectorServiceOptions, "catalog" | "vault"> = {},
  ) {
    const dir = connectorsDir(dataDir);
    return new ConnectorService({
      ...options,
      catalog: await FileConnectorCatalog.load(join(dir, "catalog.json")),
      vault: await FileCredentialVault.load(join(dir, "credentials.json")),
    });
  }

  /** Called when a connector is added, changed, removed, or its status moves. */
  onChanged(listener: () => void): () => void {
    return this.#state.onChanged(listener);
  }

  async list(): Promise<Connector[]> {
    return Promise.all((await this.#state.catalog.list()).map((entry) => this.#state.view(entry)));
  }

  async #nameFree(name: string, except?: string): Promise<void> {
    const taken = (await this.#state.catalog.list()).some(
      (e) => e.name === name && e.id !== except,
    );
    if (taken) throw invalid("Another connector has that name", "name_taken", { name });
  }

  async add(params: AddParams): Promise<Connector> {
    checkTransport(params.transport, params.auth);
    await this.#nameFree(params.name);
    const entry: CatalogEntry = {
      id: randomUUID(),
      name: params.name,
      enabled: params.enabled ?? true,
      transport: params.transport,
      auth: params.auth,
      createdAt: new Date().toISOString(),
    };
    const credentials = applySecrets({ headers: {}, env: {} }, params.secrets);
    // The secrets first: a catalog entry never names a connector whose keys were lost.
    await this.#state.vault.put(entry.id, credentials);
    await this.#state.catalog.put(entry);
    this.#state.changed();
    return this.#state.view(entry);
  }

  async update(params: UpdateParams): Promise<Connector> {
    const before = await this.#state.entry(params.id);
    if (
      before.origin !== undefined &&
      (params.name !== undefined ||
        params.enabled !== undefined ||
        params.transport !== undefined ||
        params.auth !== undefined ||
        params.secrets?.headers !== undefined)
    ) {
      throw invalid("This connector is a plugin's: only its values can be set", "managed");
    }
    const entry: CatalogEntry = {
      ...before,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.transport !== undefined ? { transport: params.transport } : {}),
      ...(params.auth !== undefined ? { auth: params.auth } : {}),
    };
    checkTransport(entry.transport, entry.auth);
    if (params.name !== undefined) await this.#nameFree(params.name, entry.id);
    // Refused before anything is written.
    applySecrets({ headers: {}, env: {} }, params.secrets);
    // A token belongs to the server it was given by: another address or another way of signing
    // in, and it is not sent anywhere again.
    const sameServer = serverOf(before) === serverOf(entry);
    if (!sameServer) await this.#signIn.signOut(entry.id);
    await this.#state.mutate(entry.id, (current) => {
      const next = applySecrets(current, params.secrets);
      if (sameServer) return next;
      const { oauth: _gone, ...rest } = next;
      return rest;
    });
    await this.#state.catalog.put(entry);
    // Another server, other keys or sign-in, or switched on again: what was last known of it (a refusal of the old
    // key, a server that was down) is no longer said, and a plugin's server is asked afresh.
    const fresh =
      !sameServer ||
      params.auth !== undefined ||
      params.secrets !== undefined ||
      (entry.enabled && !before.enabled);
    if (fresh) this.#plugins.renewed(entry);
    // A process started with the old command, values or switch does not go on with them.
    if (!sameServer || params.secrets?.env !== undefined || !entry.enabled) {
      this.#traffic.stopBridges(entry.id);
    }
    this.#state.changed();
    return this.#state.view(entry);
  }

  async remove(id: string): Promise<void> {
    const entry = await this.#state.entry(id);
    if (entry.origin !== undefined) {
      throw invalid("This connector is removed with its plugin", "managed");
    }
    await this.#drop(entry);
    this.#state.changed();
  }

  async #drop(entry: CatalogEntry): Promise<void> {
    const id = entry.id;
    this.#traffic.stopBridges(id);
    await this.#signIn.signOut(id);
    await this.#state.catalog.remove(entry.id);
    // After the queued changes: none of them can write the credentials back.
    await this.#state.settled(id);
    await this.#state.vault.remove(entry.id);
    this.#state.reset(id);
  }

  /**
   * Makes the connectors of one agent's plugins what `servers` says (docs/protocol.md §15). Returns which connector
   * stands for which server (`pluginId`, then server name).
   */
  syncPlugins(
    agentId: string,
    servers: readonly PluginServerSpec[],
  ): Promise<Map<string, Map<string, string>>> {
    return this.#plugins.sync(agentId, servers);
  }

  authStart(
    id: string,
    redirectUri: string,
  ): Promise<{ flowId: string; authorizationUrl: string }> {
    return this.#signIn.start(id, redirectUri);
  }

  authFinish(params: {
    flowId: string;
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
  }): Promise<Connector> {
    return this.#signIn.finish(params);
  }

  authClear(id: string): Promise<Connector> {
    return this.#signIn.clear(id);
  }

  /** The connectors a session's agent is given as it starts (traffic.ts). */
  serversFor(
    sessionId: string,
    cwd: string,
    taken: ReadonlySet<string>,
    agentId?: string,
  ): Promise<McpServer[]> {
    return this.#traffic.serversFor(sessionId, cwd, taken, agentId);
  }

  /** The session's agent is gone: its key stops working and its connector processes end. */
  release(sessionId: string): void {
    this.#traffic.release(sessionId);
  }

  close(): void {
    this.#traffic.close();
  }
}
