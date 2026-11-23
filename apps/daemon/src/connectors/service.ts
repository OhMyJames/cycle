import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk/experimental/v2";
import {
  type Connector,
  type ConnectorAuth,
  type ConnectorErrorReason,
  type ConnectorSecrets,
  type ConnectorTransport,
  CycleErrorCode,
  type connectorsAdd,
  type connectorsUpdate,
} from "@cycle/protocol";
import type { z } from "zod";
import { INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "../errors.ts";
import { McpGateway } from "./gateway.ts";
import { type Fetch, hold, send } from "./http-proxy.ts";
import { OAuthBroker, secureUrl } from "./oauth.ts";
import { bunSpawn, type Spawn, StdioBridge } from "./stdio-bridge.ts";
import {
  type CatalogEntry,
  type ConnectorCatalog,
  type Credentials,
  type CredentialVault,
  FileConnectorCatalog,
  FileCredentialVault,
} from "./store.ts";

/** Where the files live: `$CYCLE_HOME/connectors/`, 0700. */
export const connectorsDir = (dataDir: string): string => join(dataDir, "connectors");

/**
 * What a stdio connector's process gets of the daemon's own environment: enough to find and run a
 * program, nothing that could be a key (AGENTS.md: environment only by explicit allowlist). The rest
 * is what the person gave the connector.
 */
export const STDIO_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"] as const;

/** Header names the gateway sets itself, or that would break the request. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);

type Runtime = { state: "needs_auth" } | { state: "error"; reason: ConnectorErrorReason };

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

const invalid = (message: string, reason: string, data: Record<string, unknown> = {}): RpcError =>
  new RpcError(INVALID_PARAMS, message, { ...data, reason });

/** A connector is fit to keep: its address is safe for a token, its names are usable. */
const checkTransport = (transport: ConnectorTransport, auth: ConnectorAuth): void => {
  if (transport.type === "http") {
    if (secureUrl(transport.url) === undefined) {
      throw invalid("The address must be https (or http to this machine)", "insecure_url");
    }
  } else {
    if (auth.type === "oauth")
      throw invalid("Signing in needs an http connector", "oauth_needs_http");
    if (transport.cwd !== undefined && !isAbsolute(transport.cwd)) {
      throw invalid("The folder must be an absolute path", "invalid_cwd");
    }
  }
};

const applySecrets = (
  credentials: Credentials,
  secrets: ConnectorSecrets | undefined,
): Credentials => {
  if (secrets === undefined) return credentials;
  const next = { ...credentials, headers: { ...credentials.headers }, env: { ...credentials.env } };
  for (const [name, value] of Object.entries(secrets.headers ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw invalid("That header is set by Cycle", "reserved_header", { header: name });
    }
    if (value === null) delete next.headers[name];
    else next.headers[name] = value;
  }
  for (const [name, value] of Object.entries(secrets.env ?? {})) {
    if (value === null) delete next.env[name];
    else next.env[name] = value;
  }
  return next;
};

/**
 * What a token is bound to: the server's address (or the command) and how it signs in. Scopes and
 * names are not part of it, so renaming a connector does not sign it out.
 */
const serverOf = (entry: CatalogEntry): string =>
  JSON.stringify([
    entry.transport.type === "http"
      ? entry.transport.url
      : [entry.transport.command, entry.transport.args, entry.transport.cwd ?? null],
    entry.auth.type,
    entry.auth.type === "oauth" ? (entry.auth.clientId ?? null) : null,
  ]);

/** The names a plugin's headers leave to the person: each `${NAME}` in them. */
const requiredBy = (headers: Record<string, string>): string[] => {
  const names = new Set<string>();
  for (const value of Object.values(headers)) {
    for (const match of value.matchAll(/\$\{([A-Za-z0-9_-]+)\}/g)) names.add(match[1] as string);
  }
  return [...names];
};

/** A plugin's headers with the person's values in. Undefined while one of them has none. */
const filled = (
  headers: Record<string, string>,
  values: Record<string, string>,
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    let missing = false;
    out[name] = template.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (_all, key: string) => {
      const value = values[key];
      if (value === undefined) missing = true;
      return value ?? "";
    });
    if (missing) return undefined;
  }
  return out;
};

/** A name for a plugin's server among the connectors: nobody types it, an agent never sees it. */
const slugFor = (pluginId: string, server: string, taken: ReadonlySet<string>): string => {
  const plugin = pluginId.split("@")[0] ?? pluginId;
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
  pluginId: string;
  /** Whether the plugin is switched on. */
  enabled: boolean;
  server: string;
  agentName: string;
  url: string;
  headers: Record<string, string>;
};

/** A session's connector processes, by connector. */
type SessionBridges = Map<string, StdioBridge>;

/**
 * Connectors as Cycle keeps them (docs/protocol.md §14, note
 * 2026-11-19-connectors-behind-a-daemon-gateway). The catalog, the vault and the sign-in are each
 * behind their own interface; the gateway is started when the first agent needs it.
 */
export class ConnectorService {
  readonly #catalog: ConnectorCatalog;
  readonly #vault: CredentialVault;
  readonly #broker: OAuthBroker;
  readonly #fetch: Fetch;
  readonly #spawn: Spawn;
  readonly #env: Record<string, string | undefined>;
  readonly #runtime = new Map<string, Runtime>();
  readonly #bridges = new Map<string, SessionBridges>();
  /** Each session's folder, for a stdio connector that runs in it. */
  readonly #cwds = new Map<string, string>();
  /** One refresh at a time for a connector: two would each spend the same refresh token. */
  readonly #refreshing = new Map<string, Promise<boolean>>();
  /** The last credential change queued for each connector (see #mutate). */
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #listeners = new Set<() => void>();
  /** One reconciliation of plugins' connectors at a time. */
  #syncing: Promise<unknown> = Promise.resolve();
  #gateway: McpGateway | undefined;

  constructor(options: ConnectorServiceOptions) {
    this.#catalog = options.catalog;
    this.#vault = options.vault;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#broker = new OAuthBroker({
      fetch: this.#fetch,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.#spawn = options.spawn ?? bunSpawn;
    this.#env = options.env ?? process.env;
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
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #setRuntime(id: string, runtime: Runtime | undefined): void {
    const before = JSON.stringify(this.#runtime.get(id));
    if (runtime === undefined) this.#runtime.delete(id);
    else this.#runtime.set(id, runtime);
    if (JSON.stringify(runtime) !== before) this.#changed();
  }

  async #entry(id: string): Promise<CatalogEntry> {
    const entry = await this.#catalog.get(id);
    if (entry === undefined) throw new RpcError(RESOURCE_NOT_FOUND, "No such connector", { id });
    return entry;
  }

  /**
   * Changes a connector's credentials, one change at a time for each connector, on what the vault
   * holds at that moment: a refresh or a sign-in that waited on the network never writes back a
   * snapshot older than a sign-out or an edit made meanwhile. `apply` returns undefined to leave
   * them as they are. A connector removed meanwhile is not brought back.
   */
  #mutate(id: string, apply: (current: Credentials) => Credentials | undefined): Promise<boolean> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const run = previous.then(async () => {
      if ((await this.#catalog.get(id)) === undefined) return false;
      const next = apply(await this.#vault.get(id));
      if (next === undefined) return false;
      await this.#vault.put(id, next);
      return true;
    });
    const settled = run.catch(() => undefined);
    this.#locks.set(id, settled);
    void settled.then(() => {
      if (this.#locks.get(id) === settled) this.#locks.delete(id);
    });
    return run;
  }

  async #view(entry: CatalogEntry): Promise<Connector> {
    const credentials = await this.#vault.get(entry.id);
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
              server: entry.origin.server,
            },
          }
        : {}),
      ...(requires.length > 0 ? { requires } : {}),
    };
  }

  async list(): Promise<Connector[]> {
    return Promise.all((await this.#catalog.list()).map((entry) => this.#view(entry)));
  }

  async #nameFree(name: string, except?: string): Promise<void> {
    const taken = (await this.#catalog.list()).some((e) => e.name === name && e.id !== except);
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
    await this.#vault.put(entry.id, credentials);
    await this.#catalog.put(entry);
    this.#changed();
    return this.#view(entry);
  }

  async update(params: UpdateParams): Promise<Connector> {
    const before = await this.#entry(params.id);
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
    if (!sameServer) {
      this.#broker.forget(entry.id);
      await this.#broker.revoke(await this.#vault.get(entry.id));
    }
    await this.#mutate(entry.id, (current) => {
      const next = applySecrets(current, params.secrets);
      if (sameServer) return next;
      const { oauth: _gone, ...rest } = next;
      return rest;
    });
    await this.#catalog.put(entry);
    if (!sameServer) this.#runtime.delete(entry.id);
    // A process started with the old command, values or switch does not go on with them.
    if (!sameServer || params.secrets?.env !== undefined || !entry.enabled) {
      this.#stopBridges(entry.id);
    }
    this.#changed();
    return this.#view(entry);
  }

  async remove(id: string): Promise<void> {
    const entry = await this.#entry(id);
    if (entry.origin !== undefined) {
      throw invalid("This connector is removed with its plugin", "managed");
    }
    await this.#drop(entry);
    this.#changed();
  }

  async #drop(entry: CatalogEntry): Promise<void> {
    const id = entry.id;
    this.#broker.forget(id);
    this.#stopBridges(id);
    await this.#broker.revoke(await this.#vault.get(id));
    await this.#catalog.remove(entry.id);
    // After the queued changes: none of them can write the credentials back.
    await (this.#locks.get(id) ?? Promise.resolve());
    await this.#vault.remove(entry.id);
    this.#runtime.delete(id);
  }

  // ---- what plugins bring ----

  /**
   * Makes the connectors of one agent's plugins what `servers` says (docs/protocol.md §15): a new one for a server
   * not seen before, the address and headers of one that changed, none for a server that is gone. Returns which
   * connector stands for which server (`pluginId`, then server name); a server whose address would not be safe for
   * a token has none and is left to the agent.
   */
  async syncPlugins(
    agentId: string,
    servers: readonly PluginServerSpec[],
  ): Promise<Map<string, Map<string, string>>> {
    const run = this.#syncing.then(() => this.#syncPlugins(agentId, servers));
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  async #syncPlugins(
    agentId: string,
    servers: readonly PluginServerSpec[],
  ): Promise<Map<string, Map<string, string>>> {
    const all = await this.#catalog.list();
    const mine = new Map<string, CatalogEntry>();
    for (const entry of all) {
      if (entry.origin?.agentId === agentId) {
        mine.set(JSON.stringify([entry.origin.pluginId, entry.origin.server]), entry);
      }
    }
    const names = new Set(all.map((entry) => entry.name));
    const made = new Map<string, Map<string, string>>();
    let changed = false;
    for (const spec of servers) {
      if (secureUrl(spec.url) === undefined) continue;
      const key = JSON.stringify([spec.pluginId, spec.server]);
      const before = mine.get(key);
      mine.delete(key);
      const origin: NonNullable<CatalogEntry["origin"]> = {
        type: "plugin",
        agentId,
        pluginId: spec.pluginId,
        server: spec.server,
        agentName: spec.agentName,
        headers: spec.headers,
      };
      let entry: CatalogEntry;
      if (before === undefined) {
        const name = slugFor(spec.pluginId, spec.server, names);
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
        await this.#vault.put(entry.id, { headers: {}, env: {} });
        await this.#catalog.put(entry);
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
            // A token belongs to the address it was given at: an update of the plugin that moves it signs it out.
            this.#broker.forget(entry.id);
            await this.#broker.revoke(await this.#vault.get(entry.id));
            await this.#mutate(entry.id, ({ oauth: _gone, ...rest }) => rest);
            this.#runtime.delete(entry.id);
          }
          await this.#catalog.put(entry);
          changed = true;
          if (moved && spec.enabled) void this.#probe(entry.id);
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
    if (changed) this.#changed();
    return made;
  }

  /** A plugin's server signs in when it answers 401 to a request with no token: what MCP's authorization says it does. */
  async #needsSignIn(id: string): Promise<void> {
    const entry = await this.#catalog.get(id);
    if (entry?.origin === undefined || entry.auth.type !== "none") return;
    // A header the plugin itself sets as the credential is the person's key being wrong, not a sign-in.
    const own = Object.keys(entry.origin.headers).some(
      (name) => name.toLowerCase() === "authorization",
    );
    if (own) return;
    await this.#catalog.put({ ...entry, auth: { type: "oauth" } });
    this.#runtime.delete(id);
    this.#changed();
  }

  /** Asks a plugin's server once, as an agent would begin, whether it wants a sign-in. */
  async #probe(id: string): Promise<void> {
    try {
      const entry = await this.#catalog.get(id);
      if (entry?.origin === undefined || entry.transport.type !== "http") return;
      const headers = filled(entry.origin.headers, (await this.#vault.get(id)).env);
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
      if (response.status === 401) await this.#needsSignIn(id);
    } catch {
      // Not reachable now: it is asked again by the first request an agent makes.
    }
  }

  async authStart(
    id: string,
    redirectUri: string,
  ): Promise<{ flowId: string; authorizationUrl: string }> {
    const entry = await this.#entry(id);
    if (entry.auth.type !== "oauth" || entry.transport.type !== "http") {
      throw invalid("This connector does not sign in", "oauth_needs_http");
    }
    const begun = await this.#broker.begin({
      connectorId: id,
      serverUrl: entry.transport.url,
      redirectUri,
      ...(entry.auth.clientId !== undefined ? { clientId: entry.auth.clientId } : {}),
      ...(entry.auth.scopes !== undefined ? { scopes: entry.auth.scopes } : {}),
      credentials: await this.#vault.get(id),
    });
    const { tokens: _old, ...found } = begun.credentials.oauth ?? ({} as never);
    await this.#mutate(id, (current) => ({
      ...current,
      oauth: {
        ...found,
        // Tokens from before stay usable until this sign-in succeeds; whatever they are now.
        ...(current.oauth?.tokens !== undefined ? { tokens: current.oauth.tokens } : {}),
      },
    }));
    return { flowId: begun.flowId, authorizationUrl: begun.authorizationUrl };
  }

  async authFinish(params: {
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
    const entry = await this.#entry(flow.connectorId);
    const exchanged = await this.#broker.exchange(
      flow,
      params.code,
      await this.#vault.get(entry.id),
    );
    await this.#mutate(entry.id, (current) => ({
      ...current,
      oauth: {
        ...(exchanged.oauth as NonNullable<Credentials["oauth"]>),
        ...(current.oauth ?? {}),
        tokens: exchanged.oauth?.tokens,
      },
    }));
    this.#runtime.delete(entry.id);
    this.#changed();
    return this.#view(entry);
  }

  async authClear(id: string): Promise<Connector> {
    const entry = await this.#entry(id);
    this.#broker.forget(id);
    await this.#broker.revoke(await this.#vault.get(id));
    await this.#mutate(id, (current) => {
      const { oauth: _gone, ...rest } = current;
      return rest;
    });
    this.#runtime.delete(id);
    this.#changed();
    return this.#view(entry);
  }

  // ---- what agents get ----

  /**
   * The connectors a session's agent is given as it starts: each enabled one as an http server at
   * the gateway, with a key of this session's own. `taken`: names the session already has (its own
   * `mcpServers`), which keep theirs. A plugin's server goes to its own agent only, under the name that agent knows
   * it by, so that it stands in for the one the plugin declares; signed in or not, or the agent would go and sign in
   * by itself.
   */
  async serversFor(
    sessionId: string,
    cwd: string,
    taken: ReadonlySet<string>,
    agentId?: string,
  ): Promise<McpServer[]> {
    const nameOf = (e: CatalogEntry): string => e.origin?.agentName ?? e.name;
    const entries = (await this.#catalog.list()).filter(
      (e) =>
        e.enabled &&
        !taken.has(nameOf(e)) &&
        (e.origin === undefined || e.origin.agentId === agentId),
    );
    this.release(sessionId);
    if (entries.length === 0) return [];
    this.#gateway ??= McpGateway.start((session, connector, request) =>
      this.#forward(session, connector, request),
    );
    this.#cwds.set(sessionId, cwd);
    const key = this.#gateway.grant(
      sessionId,
      entries.map((e) => e.id),
    );
    const gateway = this.#gateway;
    return entries.map(
      (e) =>
        ({
          type: "http",
          name: nameOf(e),
          url: gateway.endpoint(e.id),
          headers: [{ name: "Authorization", value: `Bearer ${key}` }],
        }) as McpServer,
    );
  }

  /** The session's agent is gone: its key stops working and its connector processes end. */
  release(sessionId: string): void {
    this.#gateway?.revoke(sessionId);
    const bridges = this.#bridges.get(sessionId);
    this.#bridges.delete(sessionId);
    this.#cwds.delete(sessionId);
    for (const bridge of bridges?.values() ?? []) bridge.stop();
  }

  close(): void {
    for (const sessionId of [...this.#bridges.keys()]) this.release(sessionId);
    this.#gateway?.stop();
    this.#gateway = undefined;
  }

  #stopBridges(connectorId: string): void {
    for (const bridges of this.#bridges.values()) {
      bridges.get(connectorId)?.stop();
      bridges.delete(connectorId);
    }
  }

  async #forward(sessionId: string, connectorId: string, request: Request): Promise<Response> {
    const entry = await this.#catalog.get(connectorId);
    if (entry === undefined || !entry.enabled) return new Response("Not found", { status: 404 });
    if (entry.transport.type === "stdio") return this.#stdio(sessionId, entry, request);
    const url = entry.transport.url;
    const held = await hold(request);
    const origin = entry.origin;
    const credentialsOf = (c: Credentials): Record<string, string> => ({
      ...(origin !== undefined ? filled(origin.headers, c.env) : {}),
      ...c.headers,
      ...(c.oauth?.tokens !== undefined
        ? { Authorization: `Bearer ${c.oauth.tokens.accessToken}` }
        : {}),
    });
    let credentials = await this.#vault.get(entry.id);
    if (origin !== undefined && filled(origin.headers, credentials.env) === undefined) {
      // Not sent with a hole where the person's key goes.
      return new Response("Set this connector's values in Cycle", { status: 401 });
    }
    let response: Response;
    try {
      response = await send(this.#fetch, url, held, credentialsOf(credentials));
      if (response.status === 401 && entry.auth.type === "oauth") {
        await response.body?.cancel().catch(() => undefined);
        if (await this.#refresh(entry.id, credentials)) {
          credentials = await this.#vault.get(entry.id);
          response = await send(this.#fetch, url, held, credentialsOf(credentials));
        } else {
          // Its body is spent; the agent is told no, without the server's invitation to sign in.
          response = new Response("Sign in to this connector in Cycle", { status: 401 });
        }
      }
    } catch {
      if (!held.signal.aborted)
        this.#setRuntime(entry.id, { state: "error", reason: "unreachable" });
      return new Response("The connector could not be reached", { status: 502 });
    }
    if (response.status === 401 && origin !== undefined && entry.auth.type === "none") {
      await this.#needsSignIn(entry.id);
    }
    if (response.status === 401 || response.status === 403) {
      this.#setRuntime(
        entry.id,
        entry.auth.type === "oauth"
          ? { state: "needs_auth" }
          : { state: "error", reason: "auth_failed" },
      );
    } else if (response.status < 500) {
      this.#setRuntime(entry.id, undefined);
    }
    return response;
  }

  /** Refreshes once for everyone waiting on the same expired token. */
  #refresh(connectorId: string, stale: Credentials): Promise<boolean> {
    const running = this.#refreshing.get(connectorId);
    if (running !== undefined) return running;
    const run = (async () => {
      const current = await this.#vault.get(connectorId);
      // Someone else already refreshed since the token that failed was read.
      if (current.oauth?.tokens?.accessToken !== stale.oauth?.tokens?.accessToken) return true;
      const refreshed = await this.#broker.refresh(current);
      const tokens = refreshed?.oauth?.tokens;
      if (tokens === undefined) return false;
      // Only onto the tokens it replaces: a sign-out or a new sign-in meanwhile wins.
      return this.#mutate(connectorId, (now) =>
        now.oauth !== undefined &&
        now.oauth.tokens?.accessToken === stale.oauth?.tokens?.accessToken
          ? { ...now, oauth: { ...now.oauth, tokens } }
          : undefined,
      );
    })().finally(() => this.#refreshing.delete(connectorId));
    this.#refreshing.set(connectorId, run);
    return run;
  }

  async #stdio(sessionId: string, entry: CatalogEntry, request: Request): Promise<Response> {
    if (entry.transport.type !== "stdio") return new Response(null, { status: 404 });
    let bridges = this.#bridges.get(sessionId);
    if (bridges === undefined) {
      bridges = new Map();
      this.#bridges.set(sessionId, bridges);
    }
    let bridge = bridges.get(entry.id);
    if (bridge === undefined) {
      const credentials = await this.#vault.get(entry.id);
      const env: Record<string, string> = {};
      for (const name of STDIO_ENV_ALLOWLIST) {
        const value = this.#env[name];
        if (value !== undefined) env[name] = value;
      }
      Object.assign(env, credentials.env);
      const cwd = entry.transport.cwd ?? this.#cwds.get(sessionId) ?? this.#env.HOME ?? "/";
      let spawned: ReturnType<Spawn>;
      try {
        spawned = this.#spawn([entry.transport.command, ...entry.transport.args], { cwd, env });
      } catch {
        this.#setRuntime(entry.id, { state: "error", reason: "spawn_failed" });
        return new Response("The connector could not be started", { status: 502 });
      }
      const mine = bridges;
      const started = new StdioBridge(spawned, (failed) => {
        if (mine.get(entry.id) === started) mine.delete(entry.id);
        if (failed) this.#setRuntime(entry.id, { state: "error", reason: "spawn_failed" });
      });
      bridge = started;
      bridges.set(entry.id, bridge);
    }
    const response = await bridge.handle(request);
    if (response.ok) this.#setRuntime(entry.id, undefined);
    return response;
  }
}
