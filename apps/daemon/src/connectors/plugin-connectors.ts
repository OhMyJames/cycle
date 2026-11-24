import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Fetch } from "./http-proxy.ts";
import { secureUrl } from "./oauth.ts";
import { filled, requiredBy } from "./rules.ts";
import type { ConnectorSignIn } from "./sign-in.ts";
import type { ConnectorState } from "./state.ts";
import type { CatalogEntry } from "./store.ts";

/** A name for a plugin's server among the connectors: nobody types it, an agent never sees it. */
const slugFor = (plugin: string, server: string, taken: ReadonlySet<string>): string => {
  const base =
    `${plugin}-${server}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "plugin";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};

/** An http server a plugin brings, as the agent's plugin machinery describes it. */
export type PluginServerSpec = {
  /** The agent's own id for the plugin: kept whole, never taken apart. */
  pluginId: string;
  /** Its name, as the agent gives it. */
  pluginName: string;
  /** Whether the plugin is switched on. */
  enabled: boolean;
  server: string;
  agentName: string;
  url: string;
  headers: Record<string, string>;
};

/** The connectors that plugins' http servers are (docs/protocol.md §15), kept as the agents' plugins say. */
export class PluginConnectors {
  readonly #state: ConnectorState;
  readonly #signIn: ConnectorSignIn;
  readonly #fetch: Fetch;
  /** Removes a connector whose plugin's server is gone, as the service removes any. */
  readonly #drop: (entry: CatalogEntry) => Promise<void>;
  /** One reconciliation of plugins' connectors at a time. */
  #syncing: Promise<unknown> = Promise.resolve();

  constructor(
    state: ConnectorState,
    signIn: ConnectorSignIn,
    fetch: Fetch,
    drop: (entry: CatalogEntry) => Promise<void>,
  ) {
    this.#state = state;
    this.#signIn = signIn;
    this.#fetch = fetch;
    this.#drop = drop;
  }

  /**
   * Makes the connectors of one agent's plugins what `servers` says (docs/protocol.md §15): a new one for a server
   * not seen before, the address and headers of one that changed, none for a server that is gone. Returns which
   * connector stands for which server (`pluginId`, then server name); a server whose address would not be safe for
   * a token has none and is left to the agent.
   */
  sync(
    agentId: string,
    servers: readonly PluginServerSpec[],
  ): Promise<Map<string, Map<string, string>>> {
    const run = this.#syncing.then(() => this.#sync(agentId, servers));
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  async #sync(
    agentId: string,
    servers: readonly PluginServerSpec[],
  ): Promise<Map<string, Map<string, string>>> {
    const all = await this.#state.catalog.list();
    const mine = new Map<string, CatalogEntry>();
    for (const entry of all) {
      if (entry.origin?.agentId === agentId) {
        mine.set(JSON.stringify([entry.origin.pluginId, entry.origin.server]), entry);
      }
    }
    const names = new Set(all.map((entry) => entry.name));
    const made = new Map<string, Map<string, string>>();
    let changed = false;
    const seen = new Set<string>();
    for (const spec of servers) {
      if (secureUrl(spec.url) === undefined) continue;
      const key = JSON.stringify([spec.pluginId, spec.server]);
      // A server named twice is one server: a second connector would be made for it again and again.
      if (seen.has(key)) continue;
      seen.add(key);
      const before = mine.get(key);
      mine.delete(key);
      const origin: NonNullable<CatalogEntry["origin"]> = {
        type: "plugin",
        agentId,
        pluginId: spec.pluginId,
        pluginName: spec.pluginName,
        server: spec.server,
        agentName: spec.agentName,
        headers: spec.headers,
      };
      let entry: CatalogEntry;
      if (before === undefined) {
        const name = slugFor(spec.pluginName, spec.server, names);
        names.add(name);
        entry = {
          id: randomUUID(),
          name,
          enabled: spec.enabled,
          transport: { type: "http", url: spec.url },
          // Whether it signs in is not known yet: asked below, and learnt from the first 401 otherwise.
          auth: { type: "none" },
          createdAt: new Date().toISOString(),
          origin,
        };
        await this.#state.vault.put(entry.id, { headers: {}, env: {} });
        await this.#state.catalog.put(entry);
        changed = true;
        if (spec.enabled) void this.#probe(entry.id);
      } else {
        const moved = before.transport.type !== "http" || before.transport.url !== spec.url;
        entry = {
          ...before,
          enabled: spec.enabled,
          transport: { type: "http", url: spec.url },
          ...(moved ? { auth: { type: "none" as const } } : {}),
          origin,
        };
        if (JSON.stringify(entry) !== JSON.stringify(before)) {
          if (moved) {
            // What the person gave belongs to the address they gave it for: an update of the plugin that moves its
            // server signs it out, and the keys they typed are asked for again rather than sent to the new address.
            await this.#signIn.signOut(entry.id);
            await this.#state.mutate(entry.id, () => ({ headers: {}, env: {} }));
          }
          // Another address, other headers, or switched on again: what the last request learnt (a refusal of the old
          // headers, a server that was down) is no longer said, and the server is asked afresh.
          const fresh =
            moved ||
            !isDeepStrictEqual(before.origin?.headers, origin.headers) ||
            (spec.enabled && !before.enabled);
          await this.#state.catalog.put(entry);
          if (fresh) this.renewed(entry);
          changed = true;
        }
      }
      let ofPlugin = made.get(spec.pluginId);
      if (ofPlugin === undefined) {
        ofPlugin = new Map();
        made.set(spec.pluginId, ofPlugin);
      }
      ofPlugin.set(spec.server, entry.id);
    }
    for (const gone of mine.values()) {
      await this.#drop(gone);
      changed = true;
    }
    if (changed) this.#state.changed();
    return made;
  }

  /**
   * Its settings, as now written, are not what they were: nothing learnt of the old is said any more, and a plugin's
   * server is asked afresh whether it wants a sign-in.
   */
  renewed(entry: CatalogEntry): void {
    this.#state.reset(entry.id);
    if (entry.enabled && entry.origin !== undefined) void this.#probe(entry.id);
  }

  /**
   * A plugin's server signs in when it answers 401 to a request with no token: what MCP's authorization says it does.
   * `generation`: the settings the request was sent with; a 401 to settings since changed says nothing.
   */
  async needsSignIn(id: string, generation: number): Promise<void> {
    const entry = await this.#state.catalog.get(id);
    if (generation !== this.#state.generation(id)) return;
    if (entry?.origin === undefined || entry.auth.type !== "none") return;
    // A plugin that carries a credential of its own (an `Authorization` header, or a key the person types into any
    // header) is refused because that is wrong, not because it wants a sign-in.
    const own =
      requiredBy(entry.origin.headers).length > 0 ||
      Object.keys(entry.origin.headers).some((name) => name.toLowerCase() === "authorization");
    if (own) return;
    await this.#state.catalog.put({ ...entry, auth: { type: "oauth" } });
    this.#state.reset(id);
    this.#state.changed();
  }

  /** Asks a plugin's server once, as an agent would begin, whether it wants a sign-in. */
  async #probe(id: string): Promise<void> {
    const generation = this.#state.generation(id);
    try {
      const entry = await this.#state.catalog.get(id);
      if (entry?.origin === undefined || entry.transport.type !== "http") return;
      const headers = filled(entry.origin.headers, (await this.#state.vault.get(id)).env);
      if (headers === undefined) return;
      const response = await this.#fetch(entry.transport.url, {
        method: "POST",
        headers: {
          ...headers,
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
            clientInfo: { name: "cycle", version: "1" },
          },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) await this.needsSignIn(id, generation);
    } catch {
      // Not reachable now: it is asked again by the first request an agent makes.
    }
  }
}
