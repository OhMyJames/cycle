// Each agent's plugins on a location (docs/protocol.md §15): as connectors, the page says what went wrong beside
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
  changed(locationId: string, agentId: string): void {
    if (this.#kit.state().plugins[pluginsKey(locationId, agentId)] !== undefined)
      void this.load(locationId, agentId);
  }

  /** Reads an agent's installed plugins and their sources into the state; why it could not is kept there too. */
  load = async (locationId: string, agentId: string): Promise<void> => {
    const key = pluginsKey(locationId, agentId);
    try {
      const { sources, plugins } = await this.#kit.bridge.listPlugins(locationId, agentId);
      this.#kit.set((s) => ({ plugins: { ...s.plugins, [key]: { sources, list: plugins } } }));
    } catch (error) {
      this.#kit.set((s) => ({
        plugins: { ...s.plugins, [key]: { ...s.plugins[key], error: messageOf(error) } },
      }));
    }
  };

  /** What can be installed, a page at a time. Not kept: whoever asks shows it. */
  available = (
    locationId: string,
    query: { agentId: string; sourceId?: string; query?: string; cursor?: string; limit?: number },
  ): Promise<{ plugins: PluginInfo[]; nextCursor?: string | undefined; total: number }> =>
    this.#kit.bridge.availablePlugins(locationId, query);

  /** After a change: what is installed, and the connectors plugins bring, are read again without waiting to be told. */
  async #answer<T extends object>(
    locationId: string,
    agentId: string,
    answer: Promise<T>,
  ): Promise<T | PluginFailure> {
    const result = await answer.catch(
      (error: unknown): PluginFailure => ({ problem: "failed", message: messageOf(error) }),
    );
    if (!("problem" in result)) {
      await this.load(locationId, agentId);
      if (this.#kit.state().connectors[locationId] !== undefined)
        await this.#connectors.load(locationId);
    }
    return result;
  }

  /** The page has asked the person first: a plugin can run code on the location's machine. */
  install = (locationId: string, agentId: string, id: string) =>
    this.#answer(locationId, agentId, this.#kit.bridge.installPlugin(locationId, agentId, id));

  /** The page has asked the person first. */
  uninstall = (locationId: string, agentId: string, id: string) =>
    this.#answer(locationId, agentId, this.#kit.bridge.uninstallPlugin(locationId, agentId, id));

  update = (locationId: string, agentId: string, id: string) =>
    this.#answer(locationId, agentId, this.#kit.bridge.updatePlugin(locationId, agentId, id));

  setEnabled = (locationId: string, agentId: string, id: string, enabled: boolean) =>
    this.#answer(
      locationId,
      agentId,
      this.#kit.bridge.setPluginEnabled(locationId, agentId, id, enabled),
    );

  /** The page has asked the person first. */
  addSource = (locationId: string, agentId: string, location: string) =>
    this.#answer(
      locationId,
      agentId,
      this.#kit.bridge.addPluginSource(locationId, agentId, location),
    );

  removeSource = (locationId: string, agentId: string, id: string) =>
    this.#answer(locationId, agentId, this.#kit.bridge.removePluginSource(locationId, agentId, id));

  refreshSources = (locationId: string, agentId: string) =>
    this.#answer(locationId, agentId, this.#kit.bridge.refreshPluginSources(locationId, agentId));
}
