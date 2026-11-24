import type { McpServer } from "@agentclientprotocol/sdk/experimental/v2";
import { McpGateway } from "./gateway.ts";
import { type Fetch, hold, send } from "./http-proxy.ts";
import type { PluginConnectors } from "./plugin-connectors.ts";
import { filled, serverOf } from "./rules.ts";
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

type StdioStartResult =
  | { ok: true; bridge: StdioBridge }
  | { ok: false; status: number; message: string };

/** One active session's stdio connector processes, pending starts, and working folder. */
type SessionSlot = {
  cwd: string;
  bridges: Map<string, StdioBridge>;
  starting: Map<string, Promise<StdioStartResult>>;
  active: boolean;
};

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
  readonly #sessions = new Map<string, SessionSlot>();
  /** Moved on by `stopBridges` so an in-flight stdio start never spawns after a change, disable, or removal. */
  readonly #bridgeEpochs = new Map<string, number>();
  /** Connectors currently updating or being removed: no new stdio process may spawn until the transition finishes. */
  readonly #stopping = new Map<string, number>();
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
    this.#sessions.set(sessionId, {
      cwd,
      bridges: new Map(),
      starting: new Map(),
      active: true,
    });
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
    const slot = this.#sessions.get(sessionId);
    if (slot === undefined) return;
    slot.active = false;
    this.#sessions.delete(sessionId);
    slot.starting.clear();
    for (const bridge of slot.bridges.values()) bridge.stop();
    slot.bridges.clear();
  }

  close(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.release(sessionId);
    this.#gateway?.stop();
    this.#gateway = undefined;
  }

  #bridgeEpoch(connectorId: string): number {
    return this.#bridgeEpochs.get(connectorId) ?? 0;
  }

  stopBridges(connectorId: string): void {
    this.#bridgeEpochs.set(connectorId, this.#bridgeEpoch(connectorId) + 1);
    for (const slot of this.#sessions.values()) {
      slot.starting.delete(connectorId);
      slot.bridges.get(connectorId)?.stop();
      slot.bridges.delete(connectorId);
    }
  }

  /**
   * Stops running and starting stdio bridges for `connectorId` and keeps any new one from spawning
   * until the returned release callback runs after catalog, vault, and generation updates finish.
   */
  holdBridges(connectorId: string): () => void {
    this.#stopping.set(connectorId, (this.#stopping.get(connectorId) ?? 0) + 1);
    this.stopBridges(connectorId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#stopping.get(connectorId) ?? 1) - 1;
      if (left <= 0) this.#stopping.delete(connectorId);
      else this.#stopping.set(connectorId, left);
      this.stopBridges(connectorId);
    };
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
    if (this.#state.generation(entry.id) !== generation) {
      return new Response("The connector changed", { status: 502 });
    }
    if (origin !== undefined && filled(origin.headers, credentials.env) === undefined) {
      // Not sent with a hole where the person's key goes.
      return new Response("Set this connector's values in Cycle", { status: 401 });
    }
    let response: Response;
    try {
      response = await send(this.#fetch, url, held, credentialsOf(credentials));
      if (response.status === 401 && entry.auth.type === "oauth") {
        await response.body?.cancel().catch(() => undefined);
        if (
          (await this.#signIn.refresh(entry.id, credentials)) &&
          this.#state.generation(entry.id) === generation
        ) {
          credentials = await this.#state.vault.get(entry.id);
          if (this.#state.generation(entry.id) === generation) {
            response = await send(this.#fetch, url, held, credentialsOf(credentials));
          } else {
            response = new Response("Sign in to this connector in Cycle", { status: 401 });
          }
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
      await this.#plugins.needsSignIn(entry.id, generation, serverOf(entry));
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

  #startStdio(
    slot: SessionSlot,
    connectorId: string,
    transport: StdioTransport,
    generation: number,
  ): Promise<StdioStartResult> {
    const existing = slot.starting.get(connectorId);
    if (existing !== undefined) return existing;
    if ((this.#stopping.get(connectorId) ?? 0) > 0) {
      return Promise.resolve({
        ok: false,
        status: 502,
        message: "The connector changed while starting",
      });
    }
    const bridgeEpoch = this.#bridgeEpoch(connectorId);
    const pending = (async (): Promise<StdioStartResult> => {
      const credentials = await this.#state.vault.get(connectorId);
      const current = await this.#state.catalog.get(connectorId);
      if (!slot.active) return { ok: false, status: 401, message: "Unauthorized" };
      if (current === undefined || !current.enabled || current.transport.type !== "stdio") {
        return { ok: false, status: 404, message: "Not found" };
      }
      if (
        (this.#stopping.get(connectorId) ?? 0) > 0 ||
        this.#state.generation(connectorId) !== generation ||
        this.#bridgeEpoch(connectorId) !== bridgeEpoch
      ) {
        return { ok: false, status: 502, message: "The connector changed while starting" };
      }
      const env: Record<string, string> = {};
      for (const name of STDIO_ENV_ALLOWLIST) {
        const value = this.#env[name];
        if (value !== undefined) env[name] = value;
      }
      Object.assign(env, credentials.env);
      const cwd = transport.cwd ?? slot.cwd;
      let spawned: ReturnType<Spawn>;
      try {
        spawned = this.#spawn([transport.command, ...transport.args], { cwd, env });
      } catch {
        this.#state.setRuntime(connectorId, generation, { state: "error", reason: "spawn_failed" });
        return { ok: false, status: 502, message: "The connector could not be started" };
      }
      const started = new StdioBridge(spawned, (failed) => {
        if (slot.bridges.get(connectorId) === started) slot.bridges.delete(connectorId);
        // Said under the settings it was started with: a change stops it and starts afresh.
        if (failed) {
          this.#state.setRuntime(connectorId, generation, {
            state: "error",
            reason: "spawn_failed",
          });
        }
      });
      slot.bridges.set(connectorId, started);
      return { ok: true, bridge: started };
    })().finally(() => {
      if (slot.starting.get(connectorId) === pending) slot.starting.delete(connectorId);
    });
    slot.starting.set(connectorId, pending);
    return pending;
  }

  async #stdio(
    sessionId: string,
    entry: CatalogEntry,
    transport: StdioTransport,
    generation: number,
    request: Request,
  ): Promise<Response> {
    const slot = this.#sessions.get(sessionId);
    if (slot === undefined || !slot.active) return new Response("Unauthorized", { status: 401 });
    let bridge = slot.bridges.get(entry.id);
    if (bridge === undefined) {
      const started = await this.#startStdio(slot, entry.id, transport, generation);
      if (!started.ok) return new Response(started.message, { status: started.status });
      bridge = started.bridge;
    }
    const response = await bridge.handle(request);
    if (response.ok) this.#state.setRuntime(entry.id, generation, undefined);
    return response;
  }
}
