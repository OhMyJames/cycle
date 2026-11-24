import {
  CycleErrorCode,
  PLUGINS_PAGE_DEFAULT,
  type Plugin,
  type PluginFailureReason,
  PluginFailureReasonSchema,
  type PluginSource,
} from "@cycle/protocol";
import type { ConnectorService, PluginServerSpec } from "./connectors/service.ts";
import { RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";

/**
 * Plugins (docs/protocol.md §15, note 2026-11-23-plugins-are-the-agents-their-mcp-is-cycles). They are each agent's
 * own: an agent that has them gives a `PluginProvider`, which is that agent's machinery in words any agent's plugins
 * can be said in. The daemon keeps no list of its own: it asks, remembers the answer for a while, and makes the
 * connectors that stand for the http servers plugins bring.
 */

export type ProviderSource = Omit<PluginSource, "agentId">;

export type ProviderServer = {
  /** As the plugin names it. */
  name: string;
  /** As the agent's sessions name it: what a server given to a session is called to stand in for it. */
  agentName: string;
  /** Present when it is a plain http server, which Cycle's gateway can serve in the agent's place. */
  http?: { url: string; headers: Record<string, string> };
};

export type ProviderPlugin = Omit<Plugin, "agentId" | "servers" | "builtin" | "icon"> & {
  servers?: ProviderServer[];
};

/**
 * What ships with Cycle (packages/clawdot-plugins): a marketplace `root` of plugins, each in its own `dir` and in
 * Claude's layout, which Claude and Codex read as they are and agy converts as it installs.
 */
export type BuiltinBundle = {
  root: string;
  marketplace: string;
  plugins: { name: string; version: string; dir: string; icon?: string }[];
};

export type ProviderSnapshot = {
  sources: ProviderSource[];
  installed: ProviderPlugin[];
  /** What can be installed, the installed ones among them. */
  available: ProviderPlugin[];
};

/**
 * An agent's plugin machinery. A method that fails throws an error with a `reason` (one of protocol.md §15's words)
 * and, for a person, a `detail`.
 */
export interface PluginProvider {
  snapshot(): Promise<ProviderSnapshot>;
  /** What is installed only, without asking any source: quick enough to ask as an agent starts. */
  installed(): Promise<ProviderPlugin[]>;
  install(id: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  update(id: string): Promise<{ updated: boolean }>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Returns the id of the source added. */
  addSource(location: string): Promise<string>;
  removeSource(id: string): Promise<void>;
  refreshSource(id?: string): Promise<void>;
  /**
   * Makes what ships with Cycle installed, and newer when Cycle is: nothing the person turned off is turned on, and
   * what is there already is not asked again. Absent: the agent has none.
   */
  ensureBuiltin?(bundle: BuiltinBundle): Promise<void>;
}

/** How long an agent's answer is believed before it is asked again. Every change made here asks again at once. */
const SNAPSHOT_MS = 60_000;

type View = { sources: PluginSource[]; installed: Plugin[]; available: Plugin[] };

const failure = (error: unknown): RpcError => {
  if (error instanceof RpcError) return error;
  const given = (error as { reason?: unknown; detail?: unknown } | null) ?? {};
  const parsed = PluginFailureReasonSchema.safeParse(given.reason);
  const reason: PluginFailureReason = parsed.success ? parsed.data : "failed";
  const detail = typeof given.detail === "string" && given.detail !== "" ? given.detail : undefined;
  return new RpcError(CycleErrorCode.PluginFailed, "The agent's plugins could not do that", {
    reason,
    ...(detail !== undefined ? { detail } : {}),
  });
};

export class PluginService {
  readonly #providers: ReadonlyMap<string, PluginProvider>;
  readonly #connectors: ConnectorService;
  readonly #onChanged: (agentId: string) => void;
  readonly #now: () => number;
  readonly #builtin: BuiltinBundle | undefined;
  readonly #warn: ((agentId: string, error: unknown) => void) | undefined;
  /** Each agent's last making-it-so that worked or is under way. */
  readonly #builtins = new Map<string, Promise<void>>();
  readonly #views = new Map<string, { at: number; view: Promise<View> }>();
  /** When each agent's connectors were last made what is installed, apart from a view being read. */
  readonly #syncedAt = new Map<string, number>();
  /** The last change queued for each agent: its machinery writes its own files, one writer at a time. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: {
    providers: ReadonlyMap<string, PluginProvider>;
    connectors: ConnectorService;
    onChanged: (agentId: string) => void;
    now?: () => number;
    /** What ships with Cycle, installed for every agent that can without being asked. */
    builtin?: BuiltinBundle;
    /** Told when making it so failed: it is tried again before the agent next starts. */
    warn?: (agentId: string, error: unknown) => void;
  }) {
    this.#builtin = options.builtin;
    this.#warn = options.warn;
    this.#providers = options.providers;
    this.#connectors = options.connectors;
    this.#onChanged = options.onChanged;
    this.#now = options.now ?? Date.now;
  }

  /** The agents that have plugins. */
  agents(): string[] {
    return [...this.#providers.keys()];
  }

  #provider(agentId: string): PluginProvider {
    const provider = this.#providers.get(agentId);
    if (provider === undefined) {
      throw new RpcError(RESOURCE_NOT_FOUND, "This agent has no plugins", { agentId });
    }
    return provider;
  }

  /** The http servers of what is installed become connectors, switched as their plugin is. */
  #sync(agentId: string, installed: readonly ProviderPlugin[]) {
    const specs: PluginServerSpec[] = [];
    for (const plugin of installed) {
      for (const server of plugin.servers ?? []) {
        if (server.http === undefined) continue;
        specs.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          enabled: plugin.enabled === true,
          server: server.name,
          agentName: server.agentName,
          url: server.http.url,
          headers: server.http.headers,
        });
      }
    }
    return this.#connectors.syncPlugins(agentId, specs);
  }

  /**
   * What ships with Cycle is installed for each agent that has plugins: quietly, as one change among the agent's
   * others. Once done it is not done again until the daemon restarts; a failure (the agent not installed yet, no
   * network) is not kept, so the next call tries again. It is never an error for the caller.
   */
  ensureBuiltin(agentId: string): Promise<void> {
    const bundle = this.#builtin;
    const provider = this.#providers.get(agentId);
    if (bundle === undefined || provider?.ensureBuiltin === undefined) return Promise.resolve();
    const held = this.#builtins.get(agentId);
    if (held !== undefined) return held;
    const run = this.#change(agentId, (p) => p.ensureBuiltin?.(bundle) ?? Promise.resolve()).catch(
      (error) => {
        this.#builtins.delete(agentId);
        this.#warn?.(agentId, error);
      },
    );
    this.#builtins.set(agentId, run);
    return run;
  }

  /** Every agent's, in the background. */
  ensureBuiltins(): Promise<void> {
    return Promise.all(this.agents().map((agentId) => this.ensureBuiltin(agentId))).then(
      () => undefined,
    );
  }

  /**
   * Before an agent starts: its plugins' connectors are made what is installed now, since a plugin can change without
   * anyone having looked (the agent updating one itself, a change made outside Cycle). Not asked again when the answer
   * is fresh; never in the way of the agent starting (it gives up after `withinMs`, and a failure is not one of the
   * session's).
   */
  async beforeAgentStarts(agentId: string, withinMs = 3_000): Promise<void> {
    const provider = this.#providers.get(agentId);
    if (provider === undefined) return;
    // Not waited for beyond `withinMs` like the rest: an agent is never kept from starting by it.
    const built = this.ensureBuiltin(agentId);
    const held = this.#views.get(agentId);
    const fresh = Math.max(
      held?.at ?? Number.NEGATIVE_INFINITY,
      this.#syncedAt.get(agentId) ?? Number.NEGATIVE_INFINITY,
    );
    if (this.#now() - fresh < SNAPSHOT_MS) return;
    const run = (async () => {
      await built;
      const installed = await provider.installed();
      await this.#sync(agentId, installed);
      this.#syncedAt.set(agentId, this.#now());
    })().catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, withinMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * The shipped plugin this is, if it is one: by its id (`name@marketplace` in an agent with marketplaces, the name in
   * one without), so a plugin of the same name from another source is not taken for it.
   */
  #shipped(plugin: { id: string; name: string }): BuiltinBundle["plugins"][number] | undefined {
    const bundle = this.#builtin;
    return bundle?.plugins.find(
      (p) => plugin.id === p.name || plugin.id === `${p.name}@${bundle.marketplace}`,
    );
  }

  async #load(agentId: string): Promise<View> {
    let snapshot: ProviderSnapshot;
    try {
      snapshot = await this.#provider(agentId).snapshot();
    } catch (error) {
      throw failure(error);
    }
    const made = await this.#sync(agentId, snapshot.installed);
    const view = (plugin: ProviderPlugin): Plugin => {
      const { servers, ...rest } = plugin;
      const shipped = this.#shipped(plugin);
      const builtin =
        shipped !== undefined
          ? {
              builtin: true as const,
              ...(shipped.icon !== undefined ? { icon: shipped.icon } : {}),
            }
          : {};
      if (servers === undefined) return { ...rest, ...builtin, agentId };
      return {
        ...rest,
        ...builtin,
        agentId,
        servers: servers.map((server) => {
          const connectorId = made.get(plugin.id)?.get(server.name);
          return connectorId !== undefined
            ? { name: server.name, by: "cycle" as const, connectorId }
            : { name: server.name, by: "agent" as const };
        }),
      };
    };
    const order = new Map(snapshot.sources.map((source, at) => [source.id, at]));
    const available = snapshot.available.map(view).sort((a, b) => {
      const bySource = (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0);
      return bySource !== 0 ? bySource : a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
    return {
      sources: snapshot.sources.map((source) => ({ ...source, agentId })),
      installed: snapshot.installed.map(view).sort((a, b) => a.name.localeCompare(b.name)),
      available,
    };
  }

  #view(agentId: string): Promise<View> {
    const held = this.#views.get(agentId);
    if (held !== undefined && this.#now() - held.at < SNAPSHOT_MS) return held.view;
    const view = this.#load(agentId);
    const entry = { at: this.#now(), view };
    this.#views.set(agentId, entry);
    // An answer that failed is not kept.
    view.catch(() => {
      if (this.#views.get(agentId) === entry) this.#views.delete(agentId);
    });
    return view;
  }

  /** One change at a time for an agent; then what it has is asked again and everyone is told. */
  #change<T>(agentId: string, run: (provider: PluginProvider) => Promise<T>): Promise<T> {
    const provider = this.#provider(agentId);
    const previous = this.#queues.get(agentId) ?? Promise.resolve();
    const result = previous.then(async () => {
      try {
        return await run(provider);
      } catch (error) {
        throw failure(error);
      } finally {
        // Asked again whether it worked or not: a change that failed halfway is seen as it is.
        this.#views.delete(agentId);
      }
    });
    const again = () => this.#view(agentId).catch(() => undefined);
    const settled = result.then(again, again);
    this.#queues.set(agentId, settled);
    void settled.then(() => {
      if (this.#queues.get(agentId) === settled) this.#queues.delete(agentId);
    });
    // Told once what it has was asked again, whether the change worked or not: one that failed halfway (a timeout
    // after the agent had already written it) is seen as it is, and its connectors are there.
    void settled.then(() => this.#onChanged(agentId));
    return result;
  }

  async #installed(agentId: string, id: string): Promise<Plugin> {
    const plugin = (await this.#view(agentId)).installed.find((p) => p.id === id);
    if (plugin === undefined) throw new RpcError(RESOURCE_NOT_FOUND, "No such plugin", { id });
    return plugin;
  }

  async list(agentId: string): Promise<{ sources: PluginSource[]; plugins: Plugin[] }> {
    const view = await this.#view(agentId);
    return { sources: view.sources, plugins: view.installed };
  }

  async available(params: {
    agentId: string;
    sourceId?: string | undefined;
    query?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ plugins: Plugin[]; nextCursor?: string; total: number }> {
    const view = await this.#view(params.agentId);
    const query = params.query?.trim().toLowerCase() ?? "";
    const found = view.available.filter(
      (plugin) =>
        (params.sourceId === undefined || plugin.sourceId === params.sourceId) &&
        (query === "" ||
          plugin.name.toLowerCase().includes(query) ||
          (plugin.description?.toLowerCase().includes(query) ?? false)),
    );
    const parsed = Number.parseInt(params.cursor ?? "0", 10);
    const from = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
    const to = from + (params.limit ?? PLUGINS_PAGE_DEFAULT);
    return {
      plugins: found.slice(from, to),
      ...(to < found.length ? { nextCursor: String(to) } : {}),
      total: found.length,
    };
  }

  async install(agentId: string, id: string): Promise<Plugin> {
    await this.#change(agentId, (provider) => provider.install(id));
    return this.#installed(agentId, id);
  }

  async uninstall(agentId: string, id: string): Promise<void> {
    // Refused only for what is known to ship with Cycle: anything else goes to the agent, as it always did.
    const known = (await this.#view(agentId).catch(() => undefined))?.installed.find(
      (plugin) => plugin.id === id,
    );
    if (known?.builtin === true) {
      throw new RpcError(CycleErrorCode.PluginFailed, "The agent's plugins could not do that", {
        reason: "failed",
        detail: "A plugin that comes with Cycle can be turned off, not uninstalled",
      });
    }
    await this.#change(agentId, (provider) => provider.uninstall(id));
    // Its connectors go with it: asked again now, not when someone next looks.
    await this.#view(agentId).catch(() => undefined);
  }

  async update(agentId: string, id: string): Promise<{ plugin: Plugin; updated: boolean }> {
    const { updated } = await this.#change(agentId, (provider) => provider.update(id));
    return { plugin: await this.#installed(agentId, id), updated };
  }

  async setEnabled(agentId: string, id: string, enabled: boolean): Promise<Plugin> {
    await this.#change(agentId, (provider) => provider.setEnabled(id, enabled));
    return this.#installed(agentId, id);
  }

  async addSource(agentId: string, location: string): Promise<PluginSource> {
    const id = await this.#change(agentId, (provider) => provider.addSource(location));
    const source = (await this.#view(agentId)).sources.find((s) => s.id === id);
    if (source === undefined) throw new RpcError(RESOURCE_NOT_FOUND, "No such source", { id });
    return source;
  }

  async removeSource(agentId: string, id: string): Promise<void> {
    await this.#change(agentId, (provider) => provider.removeSource(id));
    // It may have been the one the built-in plugins come from: they are made so again as the agent next starts.
    this.#builtins.delete(agentId);
  }

  async refreshSource(agentId: string, id?: string): Promise<void> {
    await this.#change(agentId, (provider) => provider.refreshSource(id));
  }
}
