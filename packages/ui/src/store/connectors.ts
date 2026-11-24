// Each location's connectors: the page shows what went wrong itself, next to what it was about.
import type {
  ConnectorAnswer,
  ConnectorChange,
  ConnectorDraft,
  ConnectorInfo,
  ConnectorProblem,
} from "../api.ts";
import { messageOf, type StoreKit } from "./core.ts";

type Problem = { problem: ConnectorProblem; message?: string };

/** What main threw (it lost its connection, it is too old) as an answer the panel shows like the others. */
const answered = <T>(answer: Promise<T>): Promise<T | Problem> =>
  answer.catch((error: unknown) => ({ problem: "failed" as const, message: messageOf(error) }));

export class ConnectorsSlice {
  readonly #kit: StoreKit;

  constructor(kit: StoreKit) {
    this.#kit = kit;
  }

  /** A change there, here or elsewhere: read again, if the page has asked about them. */
  changed(locationId: string): void {
    if (this.#kit.state().connectors[locationId] !== undefined) void this.load(locationId);
  }

  /** Reads the location's connectors into the state; why it could not is kept there too. */
  load = async (locationId: string): Promise<void> => {
    try {
      const list = await this.#kit.bridge.listConnectors(locationId);
      this.#kit.set((s) => ({ connectors: { ...s.connectors, [locationId]: { list } } }));
    } catch (error) {
      this.#kit.set((s) => ({
        connectors: {
          ...s.connectors,
          // What was read before stays on screen under the error: it is still the last that is known.
          [locationId]: { ...s.connectors[locationId], error: messageOf(error) },
        },
      }));
    }
  };

  /** One connector as an answer gave it, in place: the list is right before the change event reads it again. */
  #put(locationId: string, connector: ConnectorInfo): void {
    this.#kit.set((s) => {
      const list = s.connectors[locationId]?.list;
      if (list === undefined) return {};
      const at = list.findIndex((c) => c.id === connector.id);
      const next = at < 0 ? [...list, connector] : list.map((c, i) => (i === at ? connector : c));
      return { connectors: { ...s.connectors, [locationId]: { list: next } } };
    });
  }

  async #answer<T extends object>(locationId: string, answer: Promise<T>): Promise<T | Problem> {
    const result = await answered(answer);
    if ("connector" in result) this.#put(locationId, result.connector as ConnectorInfo);
    return result;
  }

  add = (locationId: string, draft: ConnectorDraft): Promise<ConnectorAnswer> =>
    this.#answer(locationId, this.#kit.bridge.addConnector(locationId, draft));

  update = (locationId: string, id: string, change: ConnectorChange): Promise<ConnectorAnswer> =>
    this.#answer(locationId, this.#kit.bridge.updateConnector(locationId, id, change));

  /** Removes a connector and its credentials. The panel has asked the person first. */
  remove = async (locationId: string, id: string): Promise<{ removed: true } | Problem> => {
    const answer = await answered(this.#kit.bridge.removeConnector(locationId, id));
    if ("removed" in answer)
      this.#kit.set((s) => {
        const list = s.connectors[locationId]?.list;
        if (list === undefined) return {};
        return {
          connectors: {
            ...s.connectors,
            [locationId]: { list: list.filter((c) => c.id !== id) },
          },
        };
      });
    return answer;
  };

  authorize = (locationId: string, id: string): Promise<ConnectorAnswer | { cancelled: true }> =>
    this.#answer(locationId, this.#kit.bridge.authorizeConnector(locationId, id));

  cancelAuth = (): Promise<void> => this.#kit.bridge.cancelConnectorAuth().catch(() => undefined);

  signOut = (locationId: string, id: string): Promise<ConnectorAnswer> =>
    this.#answer(locationId, this.#kit.bridge.signOutConnector(locationId, id));
}
