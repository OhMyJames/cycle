import type { SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import { DEFAULT_TOOL_PERMISSION, TOOL_PERMISSIONS, type ToolPermission } from "./permissions.ts";
import type { V1ConfigOption, V1ModelInfo } from "./v1.ts";

export const AGY_MODES = [
  {
    value: "auto",
    name: "Auto",
    description: "Approve edits and safe commands; ask before irreversible actions.",
    _meta: { [META.recommended]: true },
  },
  {
    value: "default",
    name: "Default",
    description: "Ask before edits and commands, per your permission settings.",
  },
  {
    value: "accept-edits",
    name: "Accept edits",
    description: "Approve file edits in the workspace without asking.",
  },
  {
    value: "plan",
    name: "Plan",
    description: "Plan carefully before executing a task.",
  },
] as const;

export type AgyMode = (typeof AGY_MODES)[number]["value"];
export const DEFAULT_AGY_MODE: AgyMode = "auto";

export const AGY_EFFORT_LEVELS = [
  { value: "default", name: "Default", description: "Use the model's default thinking level." },
  { value: "low", name: "Low", description: "Fast responses with light reasoning." },
  { value: "medium", name: "Medium", description: "Balanced reasoning depth and speed." },
  { value: "high", name: "High", description: "Deep reasoning for complex tasks." },
  { value: "xhigh", name: "Extra", description: "Maximum reasoning depth (supported models)." },
] as const;

const KNOWN_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** Static config schema for `_cycle/agents/list` before any live session populates the model cache. */
export const AGY_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      title: "Permission mode",
      default: DEFAULT_AGY_MODE,
      // agy reads the mode when a turn starts: a change made during one asks as before until it ends (measured on
      // agy 1.5.x with a real model, 2026-11-24).
      _meta: { [META.nextTurn]: true },
      oneOf: AGY_MODES.map(({ value, name, ...rest }) => ({
        const: value,
        title: name,
        ...rest,
      })),
    },
    model: {
      type: "string",
      title: "Model",
      default: "default",
      _meta: { [META.open]: true },
      oneOf: [{ const: "default", title: "Default" }],
    },
    toolPermission: {
      type: "string",
      title: "Approvals",
      default: DEFAULT_TOOL_PERMISSION,
      oneOf: TOOL_PERMISSIONS.map(({ value, name, ...rest }) => ({
        const: value,
        title: name,
        ...rest,
      })),
    },
    effort: {
      type: "string",
      title: "Effort",
      default: "default",
      oneOf: AGY_EFFORT_LEVELS.map(({ value, name, description }) => ({
        const: value,
        title: name,
        description,
      })),
    },
  },
} as const;

/**
 * Derive per-model supported efforts from agy's expanded `models.availableModels` list
 * (e.g. `gemini-4-neon-low`, `gemini-4-neon-xhigh` -> `["low", "medium", "high", "xhigh"]`).
 */
export const modelEffortsFromCatalog = (
  baseModelIds: readonly string[],
  availableModels: readonly V1ModelInfo[] = [],
): Map<string, string[]> => {
  const result = new Map<string, string[]>();
  const availableIds = new Set(availableModels.map((m) => m.modelId));
  for (const base of baseModelIds) {
    const supported = KNOWN_EFFORTS.filter((level) => availableIds.has(`${base}-${level}`));
    result.set(base, [...supported]);
  }
  return result;
};

export type ConfigSelectionState = {
  defaultModel?: string | undefined;
  requestedModel?: string | undefined;
  requestedEffort?: string | undefined;
  /** agy does not report its tool permission; the adapter keeps the one it started the session's worker with. */
  toolPermission?: ToolPermission | undefined;
};

/** Translate agy ACP v1 `configOptions` (where effort is `thought_level`) into Cycle ACP v2 `SessionConfigOption[]`. */
export const toV2ConfigOptions = (
  v1Options: readonly V1ConfigOption[] | undefined,
  availableModels: readonly V1ModelInfo[] = [],
  selection?: ConfigSelectionState,
): SessionConfigOption[] => {
  const opts = v1Options ?? [];
  const modelOpt = opts.find((o) => o.id === "model" || o.category === "model");
  const thoughtOpt = opts.find((o) => o.id === "thought_level" || o.category === "thought_level");
  const modeOpt = opts.find((o) => o.id === "mode" || o.category === "mode");

  const baseModels = (modelOpt?.options ?? []).map((o) => o.value);
  const effortsByModel = modelEffortsFromCatalog(baseModels, availableModels);
  if (modelOpt) {
    // Live `thought_level` options (or absence thereof) are authoritative for the currently active model.
    effortsByModel.set(
      modelOpt.currentValue,
      (thoughtOpt?.options ?? []).map((o) => o.value),
    );
  }

  const out: SessionConfigOption[] = [];

  if (modeOpt) {
    out.push({
      configId: "mode",
      name: "Permission mode",
      type: "select",
      currentValue: modeOpt.currentValue,
      options: (modeOpt.options ?? []).map((choice) => ({
        value: choice.value,
        name: choice.name,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
        ...(choice.value === DEFAULT_AGY_MODE ? { _meta: { [META.recommended]: true } } : {}),
      })),
    });
  }

  if (modelOpt) {
    const defaultModel = selection?.defaultModel ?? modelOpt.currentValue;
    const defaultEfforts = effortsByModel.get(defaultModel);
    const isDefaultModelSelected =
      (selection?.requestedModel === undefined || selection.requestedModel === "default") &&
      modelOpt.currentValue === defaultModel;
    out.push({
      configId: "model",
      name: "Model",
      type: "select",
      currentValue: isDefaultModelSelected ? "default" : modelOpt.currentValue,
      options: [
        {
          value: "default",
          name: "Default",
          _meta: {
            [META.open]: true,
            ...(defaultEfforts !== undefined ? { [META.efforts]: defaultEfforts } : {}),
          },
        },
        ...(modelOpt.options ?? []).map((choice) => {
          const efforts = effortsByModel.get(choice.value);
          return {
            value: choice.value,
            name: choice.name,
            ...(choice.description !== undefined ? { description: choice.description } : {}),
            ...(efforts !== undefined ? { _meta: { [META.efforts]: efforts } } : {}),
          };
        }),
      ],
    });
  }

  if (selection?.toolPermission !== undefined) {
    out.push({
      configId: "toolPermission",
      name: "Approvals",
      type: "select",
      currentValue: selection.toolPermission,
      options: TOOL_PERMISSIONS.map(({ value, name, description, ...rest }) => ({
        value,
        name,
        description,
        ...("_meta" in rest ? { _meta: rest._meta } : {}),
      })),
    });
  }

  const currentEfforts = thoughtOpt?.options ?? [];
  const currentEffortValue =
    currentEfforts.length === 0
      ? "default"
      : selection?.requestedEffort === undefined || selection.requestedEffort === "default"
        ? "default"
        : (thoughtOpt?.currentValue ?? "default");
  out.push({
    configId: "effort",
    name: "Effort",
    type: "select",
    currentValue: currentEffortValue,
    options: [
      { value: "default", name: "Default" },
      ...currentEfforts.map((choice) => ({
        value: choice.value,
        name: choice.name,
        ...(choice.description !== undefined ? { description: choice.description } : {}),
      })),
    ],
  });

  return out;
};
