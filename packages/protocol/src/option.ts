import type { LegacyMode, ModeInfo, ModelInfo } from "./model.ts";

/**
 * A choice an agent offers and a session makes, as `docs/operations.md` says, and the note
 * `2026-11-18-options-are-one-declared-list.md`: `model`, `mode` and, under a model, `effort`. An
 * agent that offers a fourth declares it here and nowhere else.
 */
export interface Option {
  /** The agent's own id: `model`, `mode` and `effort` for the three that exist. */
  id: string;
  category: "mode" | "model" | "effort" | (string & Record<never, never>);
  name: string;
  description: string;
  values: OptionValue[];
}

export interface OptionValue {
  id: string;
  name: string;
  description: string;
  /** What a session starts with when the owner chose nothing: at most one value of an option. */
  default: boolean;
  /** Never asks, no sandbox. Never the default, never taken because the agent moved itself there. */
  dangerous: boolean;
  /** `mode` only: the agent plans and changes nothing until its plan is approved. */
  plan: boolean;
  /**
   * `mode` only: the mode of Cycle's own, from before agents named theirs, that this is.
   * shortcut: read while a daemon from before 2026-11-16 may have written a file; upgrade when two
   * releases have shipped.
   */
  replaces: LegacyMode | null;
  /** `model` only: the owner's provider that serves it; null when it is the agent's own. */
  provider: { id: string; name: string } | null;
  /** Options that exist only while this value is chosen: a model's efforts. */
  under: Option[];
}

/** What an agent says of a value: the rest is the same for every value. */
export type DeclaredValue = Partial<OptionValue> & Pick<OptionValue, "id" | "name">;

/** What an agent says of an option. */
export interface DeclaredOption extends Pick<Option, "id" | "category" | "name"> {
  description?: string;
  values: DeclaredValue[];
}

/**
 * An option from what an agent says of it, with the rest filled in. It throws on what no list may
 * be: a value that never asks as the default, or two defaults. Every agent's options go through it,
 * so those two rules are of the type and not of each list.
 */
export function defineOption(declared: DeclaredOption): Option {
  const values = declared.values.map((value): OptionValue => ({
    description: "",
    default: false,
    dangerous: false,
    plan: false,
    replaces: null,
    provider: null,
    under: [],
    ...value,
  }));
  const defaults = values.filter((value) => value.default);
  const risky = defaults.find((value) => value.dangerous);
  if (risky) {
    throw new Error(`Option ${declared.id} makes "${risky.id}" its default, which never asks.`);
  }
  if (defaults.length > 1) {
    const named = defaults.map((value) => `"${value.id}"`).join(" and ");
    throw new Error(`Option ${declared.id} has two defaults: ${named}.`);
  }
  return {
    id: declared.id,
    category: declared.category,
    name: declared.name,
    description: declared.description ?? "",
    values: values.map((value) => ({
      ...value,
      under: value.under.map((inner) => defineOption(inner)),
    })),
  };
}

/**
 * One agent's options from its two lists of before: its modes, and its models with their efforts
 * under them. An option with no value is left out.
 * shortcut: it goes with `ModeInfo` and `ModelInfo`; upgrade when every agent declares `options`
 * itself and the old lists are removed.
 */
export function optionsFromLegacy(
  agent: string,
  modes: readonly ModeInfo[],
  models: readonly ModelInfo[],
): Option[] {
  const options: Option[] = [];
  const own = models.filter((model) => model.harness === agent);
  if (own.length > 0) {
    options.push(
      defineOption({
        id: "model",
        category: "model",
        name: "Model",
        values: own.map((model) => ({
          id: model.id,
          name: model.name,
          description: model.description,
          default: model.isDefault,
          provider: model.provider,
          under:
            model.efforts.length > 0
              ? [
                  defineOption({
                    id: "effort",
                    category: "effort",
                    name: "Effort",
                    values: model.efforts.map((effort) => ({
                      id: effort.id,
                      name: effort.id,
                      description: effort.description,
                      default: effort.id === model.defaultEffort,
                    })),
                  }),
                ]
              : [],
        })),
      }),
    );
  }
  const theirs = modes.filter((mode) => mode.harness === agent);
  if (theirs.length > 0) {
    options.push(
      defineOption({
        id: "mode",
        category: "mode",
        name: "Permissions",
        description: "How much the agent may do unasked",
        values: theirs.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description,
          default: mode.isDefault,
          dangerous: mode.dangerous,
          plan: mode.plan,
          replaces: mode.replaces,
        })),
      }),
    );
  }
  return options;
}
