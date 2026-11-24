import type { Connector, ConnectorErrorReason } from "@cycle/protocol";
import { RESOURCE_NOT_FOUND, RpcError } from "../errors.ts";
import { requiredBy } from "./rules.ts";
import type { CatalogEntry, ConnectorCatalog, Credentials, CredentialVault } from "./store.ts";

type Runtime = { state: "needs_auth" } | { state: "error"; reason: ConnectorErrorReason };

/**
 * What the parts of the connector service share: the catalog and the vault, what the last requests learnt of each
 * connector (its status), changes to its credentials one at a time, and who is told when any of it moves.
 */
export class ConnectorState {
  readonly catalog: ConnectorCatalog;
  readonly vault: CredentialVault;
  readonly #runtime = new Map<string, Runtime>();
  /**
   * Each connector's settings, counted: moved on by every change to what its requests are (another address, other
   * headers or values, another sign-in, switched on again). What a request learns is kept only under the settings it
   * was sent with, so an answer to the old ones that comes in late does not say anything of the new.
   */
  readonly #generations = new Map<string, number>();
  /** The last credential change queued for each connector (see mutate). */
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Structural catalog+vault edits (update, remove, plugin sync) serialized per connector. */
  readonly #serials = new Map<string, Promise<unknown>>();
  readonly #listeners = new Set<() => void>();

  constructor(catalog: ConnectorCatalog, vault: CredentialVault) {
    this.catalog = catalog;
    this.vault = vault;
  }

  /** Called when a connector is added, changed, removed, or its status moves. */
  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.#listeners) listener();
  }

  generation(id: string): number {
    return this.#generations.get(id) ?? 0;
  }

  /** Its settings changed: what was learnt of the old ones is no longer said, nor learnt from a request still out. */
  reset(id: string): void {
    this.#runtime.delete(id);
    this.#generations.set(id, this.generation(id) + 1);
  }

  setRuntime(id: string, generation: number, runtime: Runtime | undefined): void {
    if (generation !== this.generation(id)) return;
    const before = JSON.stringify(this.#runtime.get(id));
    if (runtime === undefined) this.#runtime.delete(id);
    else this.#runtime.set(id, runtime);
    if (JSON.stringify(runtime) !== before) this.changed();
  }

  async entry(id: string): Promise<CatalogEntry> {
    const entry = await this.catalog.get(id);
    if (entry === undefined) throw new RpcError(RESOURCE_NOT_FOUND, "No such connector", { id });
    return entry;
  }

  /**
   * Changes a connector's credentials, one change at a time for each connector, on what the vault
   * holds at that moment: a refresh or a sign-in that waited on the network never writes back a
   * snapshot older than a sign-out or an edit made meanwhile. `apply` returns undefined to leave
   * them as they are. A connector removed meanwhile is not brought back.
   */
  mutate(
    id: string,
    apply: (current: Credentials, entry: CatalogEntry) => Credentials | undefined,
  ): Promise<boolean> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const run = previous.then(async () => {
      const entry = await this.catalog.get(id);
      if (entry === undefined) return false;
      const next = apply(await this.vault.get(id), entry);
      if (next === undefined) return false;
      await this.vault.put(id, next);
      return true;
    });
    const settled = run.catch(() => undefined);
    this.#locks.set(id, settled);
    void settled.then(() => {
      if (this.#locks.get(id) === settled) this.#locks.delete(id);
    });
    return run;
  }

  /** Resolves once the credential changes queued for a connector are done: none can write them back after. */
  async settled(id: string): Promise<void> {
    await (this.#locks.get(id) ?? Promise.resolve());
  }

  /** Serializes structural edits (update, remove, plugin sync) for one connector so none interleave or resurrect it. */
  serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#serials.get(id) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#serials.set(id, settled);
    void settled.then(() => {
      if (this.#serials.get(id) === settled) this.#serials.delete(id);
    });
    return run;
  }

  async view(entry: CatalogEntry): Promise<Connector> {
    const credentials = await this.vault.get(entry.id);
    const authorized = credentials.oauth?.tokens !== undefined;
    const runtime = this.#runtime.get(entry.id);
    const requires = entry.origin !== undefined ? requiredBy(entry.origin.headers) : [];
    const unfilled = requires.some((name) => credentials.env[name] === undefined);
    const status: Connector["status"] = !entry.enabled
      ? { state: "disabled" }
      : (entry.auth.type === "oauth" && !authorized) || unfilled
        ? { state: "needs_auth" }
        : runtime === undefined
          ? { state: "ready" }
          : runtime.state === "needs_auth"
            ? { state: "needs_auth" }
            : { state: "error", reason: runtime.reason };
    return {
      id: entry.id,
      name: entry.name,
      enabled: entry.enabled,
      transport: entry.transport,
      auth: entry.auth,
      secrets: { headers: Object.keys(credentials.headers), env: Object.keys(credentials.env) },
      authorized,
      status,
      ...(entry.origin !== undefined
        ? {
            origin: {
              type: "plugin" as const,
              agentId: entry.origin.agentId,
              pluginId: entry.origin.pluginId,
              pluginName: entry.origin.pluginName ?? entry.origin.pluginId,
              server: entry.origin.server,
            },
          }
        : {}),
      ...(requires.length > 0 ? { requires } : {}),
    };
  }
}
