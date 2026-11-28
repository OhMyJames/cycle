// Each location's model providers (docs/protocol.md §10 "自带模型"): the page shows what went wrong itself, next to what
// it was about. A key is only ever on its way to the daemon: nothing here keeps one.
import type {
  ProviderAnswer,
  ProviderDraft,
  ProviderModel,
  ProviderProblem,
  ProvidersRead,
} from "../api.ts";
import { answered, messageOf, type StoreKit } from "./core.ts";

type Problem = { problem: ProviderProblem; message?: string };

export class ProvidersSlice {
  readonly #kit: StoreKit;
  /** The agents' menus carry the owner's models: when the providers change they are read again. */
  readonly #reloadAgents: (locationId: string) => Promise<void>;

  constructor(kit: StoreKit, reloadAgents: (locationId: string) => Promise<void>) {
    this.#kit = kit;
    this.#reloadAgents = reloadAgents;
  }

  /** A change there, here or elsewhere: the providers are read again if the page asked about them, the agents always. */
  changed(locationId: string): void {
    if (this.#kit.state().providers[locationId] !== undefined) void this.load(locationId);
    void this.#reloadAgents(locationId);
  }

  /** Reads the location's providers into the state; why it could not is kept there too. */
  load = async (locationId: string): Promise<void> => {
    try {
      const read: ProvidersRead = await this.#kit.bridge.listProviders(locationId);
      this.#kit.set((s) => ({ providers: { ...s.providers, [locationId]: { read } } }));
    } catch (error) {
      this.#kit.set((s) => ({
        providers: {
          ...s.providers,
          // What was read before stays on screen under the error: it is still the last that is known.
          [locationId]: { ...s.providers[locationId], error: messageOf(error) },
        },
      }));
    }
  };

  /** The models a known service serves, or why that is not known. */
  catalog = async (
    locationId: string,
    kind: string,
  ): Promise<{ models: ProviderModel[] } | Problem> => {
    const answer = await answered(
      this.#kit.bridge.providerCatalog(locationId, kind).then((models) => ({ models })),
    );
    return answer;
  };

  save = async (locationId: string, draft: ProviderDraft): Promise<ProviderAnswer> => {
    const answer = await answered(this.#kit.bridge.saveProvider(locationId, draft));
    if ("provider" in answer) {
      const saved = answer.provider;
      this.#kit.set((s) => {
        const read = s.providers[locationId]?.read;
        if (read === undefined) return {};
        const at = read.providers.findIndex((p) => p.id === saved.id);
        const providers =
          at < 0
            ? [...read.providers, saved]
            : read.providers.map((p, i) => (i === at ? saved : p));
        return { providers: { ...s.providers, [locationId]: { read: { ...read, providers } } } };
      });
    }
    return answer;
  };

  /** Removes a provider and its key. The page has asked the person first. */
  remove = async (locationId: string, id: string): Promise<{ removed: true } | Problem> => {
    const answer = await answered(this.#kit.bridge.removeProvider(locationId, id));
    if ("removed" in answer)
      this.#kit.set((s) => {
        const read = s.providers[locationId]?.read;
        if (read === undefined) return {};
        const providers = read.providers.filter((p) => p.id !== id);
        return { providers: { ...s.providers, [locationId]: { read: { ...read, providers } } } };
      });
    return answer;
  };
}
