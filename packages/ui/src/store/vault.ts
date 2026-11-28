// Each location's vault (docs/protocol.md §6 "环境"): the keys of its `secrets.env`. Only names are read; a value is on
// its way to the daemon when it is set and nothing here keeps one.
import type { VaultAnswer } from "../api.ts";
import { answered, messageOf, type StoreKit } from "./core.ts";

const sorted = (keys: readonly string[]): string[] => [...keys].sort();

export class VaultSlice {
  readonly #kit: StoreKit;

  constructor(kit: StoreKit) {
    this.#kit = kit;
  }

  /** Reads the location's keys into the state; why it could not is kept there too. */
  load = async (locationId: string): Promise<void> => {
    try {
      const keys = sorted(await this.#kit.bridge.listVault(locationId));
      this.#kit.set((s) => ({ vault: { ...s.vault, [locationId]: { keys } } }));
    } catch (error) {
      this.#kit.set((s) => ({
        vault: {
          ...s.vault,
          // What was read before stays on screen under the error: it is still the last that is known.
          [locationId]: { ...s.vault[locationId], error: messageOf(error) },
        },
      }));
    }
  };

  /** Adds the key or replaces its value. */
  set = async (locationId: string, key: string, value: string): Promise<VaultAnswer> => {
    const answer = await answered(this.#kit.bridge.setVaultItem(locationId, key, value));
    if ("done" in answer)
      this.#kit.set((s) => {
        const keys = s.vault[locationId]?.keys;
        if (keys === undefined || keys.includes(key)) return {};
        return { vault: { ...s.vault, [locationId]: { keys: sorted([...keys, key]) } } };
      });
    return answer;
  };

  /** Removes the key and its value. The page has asked the person first. */
  remove = async (locationId: string, key: string): Promise<VaultAnswer> => {
    const answer = await answered(this.#kit.bridge.removeVaultItem(locationId, key));
    if ("done" in answer)
      this.#kit.set((s) => {
        const keys = s.vault[locationId]?.keys;
        if (keys === undefined) return {};
        return { vault: { ...s.vault, [locationId]: { keys: keys.filter((k) => k !== key) } } };
      });
    return answer;
  };
}
