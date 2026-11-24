// A session's settings (an agent's `configOptions`): what is checked before they are given to an agent, and how
// they are read back from it. Used where a session is made (src/facing/sessions.ts) and where it is resumed (daemon).
import { CycleErrorCode, META } from "@cycle/protocol";
import type { AgentDefinition } from "./agents.ts";
import { RpcError } from "./errors.ts";

/** The value each of an agent's `configOptions` has now, as a configuration. */
export const currentValues = (options: unknown): Record<string, string> => {
  const config: Record<string, string> = {};
  if (Array.isArray(options)) {
    for (const option of options as { configId?: unknown; currentValue?: unknown }[]) {
      if (typeof option?.configId === "string" && typeof option.currentValue === "string") {
        config[option.configId] = option.currentValue;
      }
    }
  }
  return config;
};

/** Keeps existing config order while ensuring `model` is applied before model-dependent `effort`. */
export const orderedConfigEntries = (config: Record<string, string>): [string, string][] => {
  const entries = Object.entries(config);
  const effortIndex = entries.findIndex(([key]) => key === "effort");
  const modelIndex = entries.findIndex(([key]) => key === "model");
  if (effortIndex === -1 || modelIndex === -1 || effortIndex > modelIndex) return entries;
  const [effort] = entries.splice(effortIndex, 1);
  if (effort !== undefined) entries.splice(modelIndex, 0, effort);
  return entries;
};

/**
 * The values a `configSchema` property allows when it lists them and takes no others: its `enum`, or
 * the `const` of each `oneOf` entry. Undefined for a property that lists none, or says it is open.
 */
const closedChoices = (property: unknown): unknown[] | undefined => {
  if (typeof property !== "object" || property === null) return undefined;
  const {
    enum: values,
    oneOf,
    _meta,
  } = property as {
    enum?: unknown;
    oneOf?: unknown;
    _meta?: Record<string, unknown>;
  };
  if (_meta?.[META.open] === true) return undefined;
  if (Array.isArray(values)) return values;
  if (Array.isArray(oneOf)) {
    const consts = oneOf.map((entry) => (entry as { const?: unknown } | null)?.const);
    return consts.every((value) => value !== undefined) ? consts : undefined;
  }
  return undefined;
};

/** The same declared choices apply to saved defaults and explicit creation overrides. */
export const checkedConfig = (agent: AgentDefinition, raw: unknown): Record<string, string> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new RpcError(CycleErrorCode.InvalidConfig, "Expected a configuration object", {
      agent: agent.id,
    });
  const properties = agent.configSchema.properties as Record<string, unknown> | undefined;
  const entries = Object.entries(raw);
  for (const [configId, value] of entries) {
    const field = { agent: agent.id, configId };
    if (properties !== undefined && !Object.hasOwn(properties, configId))
      throw new RpcError(CycleErrorCode.InvalidConfig, `Unknown setting: ${configId}`, field);
    if (typeof value !== "string")
      throw new RpcError(CycleErrorCode.InvalidConfig, `Expected a string for ${configId}`, field);
    const allowed = closedChoices(properties?.[configId]);
    if (allowed && !allowed.includes(value))
      throw new RpcError(CycleErrorCode.InvalidConfig, `Unsupported value for ${configId}`, {
        ...field,
        value,
        allowed,
      });
  }
  return raw as Record<string, string>;
};
