import type { McpServer } from "@agentclientprotocol/sdk/experimental/v2";
import { McpGateway } from "./gateway.ts";
import { type Fetch, hold, send } from "./http-proxy.ts";
import type { PluginConnectors } from "./plugin-connectors.ts";
import { filled } from "./rules.ts";
import type { ConnectorSignIn } from "./sign-in.ts";
import type { ConnectorState } from "./state.ts";
import { type Spawn, StdioBridge } from "./stdio-bridge.ts";
import type { CatalogEntry, Credentials } from "./store.ts";

/**
 * What a stdio connector's process gets of the daemon's own environment: enough to find and run a
 * program, nothing that could be a key (AGENTS.md: environment only by explicit allowlist). The rest
 * is what the person gave the connector.
 */
export const STDIO_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"] as const;

type StdioTransport = Extract<CatalogEntry["transport"], { type: "stdio" }>;

/** A session's connector processes, by connector. */
type SessionBridges = Map<string, StdioBridge>;

/**
 * What agents get of the connectors: each as an address at the gateway (gateway.ts), and every request that comes to
 * it, sent on to the server with its credentials (http-proxy.ts) or to a process the daemon runs (stdio-bridge.ts).
 */
export class ConnectorTraffic {
  readonly #state: ConnectorState;
  readonly #signIn: ConnectorSignIn;
  readonly #plugins: PluginConnectors;
  readonly #fetch: Fetch;
  readonly #spawn: Spawn;
  readonly #env: Record<string, string | undefined>;
  readonly #bridges = new Map<string, SessionBridges>();
  /** Each session's folder, for a stdio connector that runs in it. */
  readonly #cwds = new Map<string, string>();
  #gateway: McpGateway | undefined;

  constructor(options: {
    state: ConnectorState;
    signIn: ConnectorSignIn;
    plugins: PluginConnectors;
    fetch: Fetch;
    spawn: Spawn;
    env: Record<string, string | undefined>;
  }) {
    this.#state = options.state;
    this.#signIn = options.signIn;
    this.#plugins = options.plugins;
    this.#fetch = options.fetch;
    this.#spawn = options.spawn;
    this.#env = options.env;
  }

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
    const entries = (await this.#state.catalog.list()).filter(
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

  stopBridges(connectorId: string): void {
    for (const bridges of this.#bridges.values()) {
      bridges.get(connectorId)?.stop();
      bridges.delete(connectorId);
    }
  }

  async #forward(sessionId: string, connectorId: string, request: Request): Promise<Response> {
    // Read with the entry, before anything is awaited: what this request learns is of these settings.
    const generation = this.#state.generation(connectorId);
    const entry = await this.#state.catalog.get(connectorId);
    if (entry === undefined || !entry.enabled) return new Response("Not found", { status: 404 });
    if (entry.transport.type === "stdio")
      return this.#stdio(sessionId, entry, entry.transport, generation, request);
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
    let credentials = await this.#state.vault.get(entry.id);
    if (origin !== undefined && filled(origin.headers, credentials.env) === undefined) {
      // Not sent with a hole where the person's key goes.
      return new Response("Set this connector's values in Cycle", { status: 401 });
    }
    let response: Response;
    try {
      response = await send(this.#fetch, url, held, credentialsOf(credentials));
      if (response.status === 401 && entry.auth.type === "oauth") {
        await response.body?.cancel().catch(() => undefined);
        if (await this.#signIn.refresh(entry.id, credentials)) {
          credentials = await this.#state.vault.get(entry.id);
          response = await send(this.#fetch, url, held, credentialsOf(credentials));
        } else {
          // Its body is spent; the agent is told no, without the server's invitation to sign in.
          response = new Response("Sign in to this connector in Cycle", { status: 401 });
        }
      }
    } catch {
      if (!held.signal.aborted)
        this.#state.setRuntime(entry.id, generation, { state: "error", reason: "unreachable" });
      return new Response("The connector could not be reached", { status: 502 });
    }
    if (response.status === 401 && origin !== undefined && entry.auth.type === "none") {
      await this.#plugins.needsSignIn(entry.id, generation);
    }
    if (response.status === 401 || response.status === 403) {
      this.#state.setRuntime(
        entry.id,
        generation,
        entry.auth.type === "oauth"
          ? { state: "needs_auth" }
          : { state: "error", reason: "auth_failed" },
      );
    } else if (response.status < 500) {
      this.#state.setRuntime(entry.id, generation, undefined);
    }
    return response;
  }

  async #stdio(
    sessionId: string,
    entry: CatalogEntry,
    transport: StdioTransport,
    generation: number,
    request: Request,
  ): Promise<Response> {
    let bridges = this.#bridges.get(sessionId);
    if (bridges === undefined) {
      bridges = new Map();
      this.#bridges.set(sessionId, bridges);
    }
    let bridge = bridges.get(entry.id);
    if (bridge === undefined) {
      const credentials = await this.#state.vault.get(entry.id);
      const env: Record<string, string> = {};
      for (const name of STDIO_ENV_ALLOWLIST) {
        const value = this.#env[name];
        if (value !== undefined) env[name] = value;
      }
      Object.assign(env, credentials.env);
      const cwd = transport.cwd ?? this.#cwds.get(sessionId) ?? this.#env.HOME ?? "/";
      let spawned: ReturnType<Spawn>;
      try {
        spawned = this.#spawn([transport.command, ...transport.args], { cwd, env });
      } catch {
        this.#state.setRuntime(entry.id, generation, { state: "error", reason: "spawn_failed" });
        return new Response("The connector could not be started", { status: 502 });
      }
      const mine = bridges;
      const started = new StdioBridge(spawned, (failed) => {
        if (mine.get(entry.id) === started) mine.delete(entry.id);
        // Said under the settings of now: a process is stopped when the ones it was started with change.
        if (failed) {
          this.#state.setRuntime(entry.id, this.#state.generation(entry.id), {
            state: "error",
            reason: "spawn_failed",
          });
        }
      });
      bridge = started;
      bridges.set(entry.id, bridge);
    }
    const response = await bridge.handle(request);
    if (response.ok) this.#state.setRuntime(entry.id, generation, undefined);
    return response;
  }
}
