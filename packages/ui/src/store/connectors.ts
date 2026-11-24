// Each environment's connectors: the page shows what went wrong itself, next to what it was about.
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
  changed(environmentId: string): void {
    if (this.#kit.state().connectors[environmentId] !== undefined) void this.load(environmentId);
  }

  /** Reads the environment's connectors into the state; why it could not is kept there too. */
  load = async (environmentId: string): Promise<void> => {
    try {
      const list = await this.#kit.bridge.listConnectors(environmentId);
      this.#kit.set((s) => ({ connectors: { ...s.connectors, [environmentId]: { list } } }));
    } catch (error) {
      this.#kit.set((s) => ({
        connectors: {
          ...s.connectors,
          // What was read before stays on screen under the error: it is still the last that is known.
          [environmentId]: { ...s.connectors[environmentId], error: messageOf(error) },
        },
      }));
    }
  };

  /** One connector as an answer gave it, in place: the list is right before the change event reads it again. */
  #put(environmentId: string, connector: ConnectorInfo): void {
    this.#kit.set((s) => {
      const list = s.connectors[environmentId]?.list;
      if (list === undefined) return {};
      const at = list.findIndex((c) => c.id === connector.id);
      const next = at < 0 ? [...list, connector] : list.map((c, i) => (i === at ? connector : c));
      return { connectors: { ...s.connectors, [environmentId]: { list: next } } };
    });
  }

  async #answer<T extends object>(environmentId: string, answer: Promise<T>): Promise<T | Problem> {
    const result = await answered(answer);
    if ("connector" in result) this.#put(environmentId, result.connector as ConnectorInfo);
    return result;
  }

  add = (environmentId: string, draft: ConnectorDraft): Promise<ConnectorAnswer> =>
    this.#answer(environmentId, this.#kit.bridge.addConnector(environmentId, draft));

  update = (environmentId: string, id: string, change: ConnectorChange): Promise<ConnectorAnswer> =>
    this.#answer(environmentId, this.#kit.bridge.updateConnector(environmentId, id, change));

  /** Removes a connector and its credentials. The panel has asked the person first. */
  remove = async (environmentId: string, id: string): Promise<{ removed: true } | Problem> => {
    const answer = await answered(this.#kit.bridge.removeConnector(environmentId, id));
    if ("removed" in answer)
      this.#kit.set((s) => {
        const list = s.connectors[environmentId]?.list;
        if (list === undefined) return {};
        return {
          connectors: {
            ...s.connectors,
            [environmentId]: { list: list.filter((c) => c.id !== id) },
          },
        };
      });
    return answer;
  };

  authorize = (environmentId: string, id: string): Promise<ConnectorAnswer | { cancelled: true }> =>
    this.#answer(environmentId, this.#kit.bridge.authorizeConnector(environmentId, id));

  cancelAuth = (): Promise<void> => this.#kit.bridge.cancelConnectorAuth().catch(() => undefined);

  signOut = (environmentId: string, id: string): Promise<ConnectorAnswer> =>
    this.#answer(environmentId, this.#kit.bridge.signOutConnector(environmentId, id));
}
