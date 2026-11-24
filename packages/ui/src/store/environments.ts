// The environments (docs/desktop.md "环境"): what main keeps of them, the one each workspace starts with, and changing
// them. A variable's value is the person's and may be a secret: it is never put in an error, a notice or a report.
import type { Environment, EnvironmentProblem, EnvironmentsState } from "../api.ts";
import { messageOf, type StoreKit } from "./core.ts";
import type { AppState, BlankConversation } from "./state.ts";

/**
 * The environment a workspace starts with: its saved default, when that environment is still there. Undefined: none.
 * For `useAppState`.
 */
export const environmentDefaultOf = (
  state: AppState,
  locationId: string,
  cwd: string,
): Environment | undefined => {
  const id = state.environments?.defaults[locationId]?.[cwd];
  return id === undefined ? undefined : state.environments?.environments.find((e) => e.id === id);
};

/**
 * The environment a blank conversation starts with: its workspace's saved default when it has a folder and that has
 * one, else what was chosen on it (none until something is). For `useAppState`.
 */
export const blankEnvironmentOf = (
  state: AppState,
  blank: BlankConversation,
): Environment | undefined => {
  const cwd = blank.cwd.trim();
  const saved = cwd === "" ? undefined : environmentDefaultOf(state, blank.locationId, cwd);
  if (saved !== undefined) return saved;
  const chosen = blank.environment;
  return chosen == null ? undefined : state.environments?.environments.find((e) => e.id === chosen);
};

export class EnvironmentsSlice {
  readonly #kit: StoreKit;
  /** Counts the changes asked: an answer older than the last change made here is not applied over it. */
  #asked = 0;

  constructor(kit: StoreKit) {
    this.#kit = kit;
  }

  /** What main has. A file that cannot be read is said as any other failure. */
  load = async (): Promise<void> => {
    const asked = this.#asked;
    await this.#kit.attempt(async () => {
      const state = await this.#kit.bridge.environments();
      if (asked === this.#asked) this.#kit.set({ environments: state });
    });
  };

  #told(state: EnvironmentsState): void {
    this.#asked++;
    this.#kit.set({ environments: state });
  }

  /** Adds or replaces one. What is wrong with it comes back for the editor to say; nothing is kept then. */
  save = async (environment: Environment): Promise<EnvironmentProblem | undefined> => {
    let answer: Awaited<ReturnType<StoreKit["bridge"]["saveEnvironment"]>>;
    try {
      answer = await this.#kit.bridge.saveEnvironment(environment);
    } catch (error) {
      return { problem: "invalid", message: messageOf(error) };
    }
    if ("problem" in answer) return answer;
    this.#told(answer.state);
    return undefined;
  };

  /** After the person confirmed it. What went wrong comes back for the dialog to say. */
  remove = async (environmentId: string): Promise<string | undefined> => {
    try {
      this.#told(await this.#kit.bridge.removeEnvironment(environmentId));
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  };

  /**
   * The environment a workspace starts with from now on (null: none). Shown at once; if it cannot be kept, what main
   * has is read again and the failure is said.
   */
  setDefault = async (
    locationId: string,
    cwd: string,
    environmentId: string | null,
  ): Promise<void> => {
    const { set, bridge } = this.#kit;
    this.#asked++;
    set((s) => {
      if (s.environments === undefined) return {};
      const folders = { ...s.environments.defaults[locationId] };
      if (environmentId === null) delete folders[cwd];
      else folders[cwd] = environmentId;
      return {
        environments: {
          ...s.environments,
          defaults: { ...s.environments.defaults, [locationId]: folders },
        },
      };
    });
    try {
      this.#told(await bridge.setEnvironmentDefault(locationId, cwd, environmentId));
    } catch (error) {
      set({ error: messageOf(error) });
      this.#asked++;
      await this.load();
    }
  };
}
