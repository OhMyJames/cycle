// Each agent's plugins on an environment (docs/protocol.md §15): as connectors, the page says what went wrong beside
// what it was about.
import type { PluginFailure, PluginInfo } from "../api.ts";
import type { ConnectorsSlice } from "./connectors.ts";
import { messageOf, type StoreKit } from "./core.ts";
import { pluginsKey } from "./state.ts";

export class PluginsSlice {
  readonly #kit: StoreKit;
  readonly #connectors: ConnectorsSlice;

  constructor(kit: StoreKit, connectors: ConnectorsSlice) {
    this.#kit = kit;
    this.#connectors = connectors;
  }

  /** A change there, here or elsewhere: read again, if the page has asked about them. */
  changed(environmentId: string, agentId: string): void {
    if (this.#kit.state().plugins[pluginsKey(environmentId, agentId)] !== undefined)
      void this.load(environmentId, agentId);
  }

  /** Reads an agent's installed plugins and their sources into the state; why it could not is kept there too. */
  load = async (environmentId: string, agentId: string): Promise<void> => {
    const key = pluginsKey(environmentId, agentId);
    try {
      const { sources, plugins } = await this.#kit.bridge.listPlugins(environmentId, agentId);
      this.#kit.set((s) => ({ plugins: { ...s.plugins, [key]: { sources, list: plugins } } }));
    } catch (error) {
      this.#kit.set((s) => ({
        plugins: { ...s.plugins, [key]: { ...s.plugins[key], error: messageOf(error) } },
      }));
    }
  };

  /** What can be installed, a page at a time. Not kept: whoever asks shows it. */
  available = (
    environmentId: string,
    query: { agentId: string; sourceId?: string; query?: string; cursor?: string; limit?: number },
  ): Promise<{ plugins: PluginInfo[]; nextCursor?: string | undefined; total: number }> =>
    this.#kit.bridge.availablePlugins(environmentId, query);

  /** After a change: what is installed, and the connectors plugins bring, are read again without waiting to be told. */
  async #answer<T extends object>(
    environmentId: string,
    agentId: string,
    answer: Promise<T>,
  ): Promise<T | PluginFailure> {
    const result = await answer.catch(
      (error: unknown): PluginFailure => ({ problem: "failed", message: messageOf(error) }),
    );
    if (!("problem" in result)) {
      await this.load(environmentId, agentId);
      if (this.#kit.state().connectors[environmentId] !== undefined)
        await this.#connectors.load(environmentId);
    }
    return result;
  }

  /** The page has asked the person first: a plugin can run code on the environment's machine. */
  install = (environmentId: string, agentId: string, id: string) =>
    this.#answer(
      environmentId,
      agentId,
      this.#kit.bridge.installPlugin(environmentId, agentId, id),
    );

  /** The page has asked the person first. */
  uninstall = (environmentId: string, agentId: string, id: string) =>
    this.#answer(
      environmentId,
      agentId,
      this.#kit.bridge.uninstallPlugin(environmentId, agentId, id),
    );

  update = (environmentId: string, agentId: string, id: string) =>
    this.#answer(environmentId, agentId, this.#kit.bridge.updatePlugin(environmentId, agentId, id));

  setEnabled = (environmentId: string, agentId: string, id: string, enabled: boolean) =>
    this.#answer(
      environmentId,
      agentId,
      this.#kit.bridge.setPluginEnabled(environmentId, agentId, id, enabled),
    );

  /** The page has asked the person first. */
  addSource = (environmentId: string, agentId: string, location: string) =>
    this.#answer(
      environmentId,
      agentId,
      this.#kit.bridge.addPluginSource(environmentId, agentId, location),
    );

  removeSource = (environmentId: string, agentId: string, id: string) =>
    this.#answer(
      environmentId,
      agentId,
      this.#kit.bridge.removePluginSource(environmentId, agentId, id),
    );

  refreshSources = (environmentId: string, agentId: string) =>
    this.#answer(
      environmentId,
      agentId,
      this.#kit.bridge.refreshPluginSources(environmentId, agentId),
    );
}
