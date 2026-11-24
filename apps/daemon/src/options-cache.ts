import { META } from "@cycle/protocol";
import { z } from "zod";
import { JsonFile, readJsonFile } from "./json-file.ts";

const CachedChoiceSchema = z.object({
  const: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** A model's effort levels (`META.efforts`, docs/protocol.md §10): `[]` takes none; absent, not known. */
  efforts: z.array(z.string()).optional(),
});

export type CachedChoice = z.infer<typeof CachedChoiceSchema>;

const OptionsCacheSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), z.record(z.string(), z.array(CachedChoiceSchema))),
});

/**
 * Disk-backed cache of dynamically discovered agent choices (such as the model catalog reported by Claude's
 * `initializationResult().models`). Pure cache: a missing or corrupt file falls back to the static schema rather
 * than blocking daemon startup.
 */
export class AgentOptionsCache {
  readonly #file: JsonFile<ReadonlyMap<string, Record<string, CachedChoice[]>>>;

  private constructor(path: string, agents: Map<string, Record<string, CachedChoice[]>>) {
    this.#file = new JsonFile<ReadonlyMap<string, Record<string, CachedChoice[]>>>(
      path,
      agents,
      (value) => ({ version: 1, agents: Object.fromEntries(value) }),
    );
  }

  static async load(path: string): Promise<AgentOptionsCache> {
    // Only a cache: one that cannot be read is started again, not a reason to stop.
    const parsed = await readJsonFile(path, OptionsCacheSchema);
    return new AgentOptionsCache(path, new Map(Object.entries(parsed?.agents ?? {})));
  }

  /** Overlays cached dynamic choices onto an agent's static `configSchema`, preserving defaults and `_meta`. */
  apply(agent: string, schema: Record<string, unknown>): Record<string, unknown> {
    const cached = this.#file.value.get(agent);
    if (cached === undefined) return schema;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties === undefined || typeof properties !== "object") return schema;
    let changed = false;
    const nextProperties: Record<string, Record<string, unknown>> = { ...properties };
    for (const [configId, choices] of Object.entries(cached)) {
      const existing = properties[configId];
      if (existing === undefined || choices.length === 0) continue;
      const oneOf: Record<string, unknown>[] = choices.map((c) => ({
        const: c.const,
        title: c.title,
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.efforts !== undefined ? { _meta: { [META.efforts]: c.efforts } } : {}),
      }));
      // What a new session starts with stays a choice, though the agent's list folds it into another row (Claude lists
      // the model its `default` stands for as that row, not under its own alias): the static row for it is kept.
      const fallback = (existing.oneOf as Record<string, unknown>[] | undefined)?.find(
        (o) => o.const === existing.default,
      );
      if (fallback !== undefined && !choices.some((c) => c.const === existing.default))
        oneOf.push(fallback);
      nextProperties[configId] = { ...existing, oneOf };
      changed = true;
    }
    return changed ? { ...schema, properties: nextProperties } : schema;
  }

  update(agent: string, configId: string, choices: readonly CachedChoice[]): Promise<void> {
    if (choices.length === 0) return Promise.resolve();
    const normalized: CachedChoice[] = choices.map((c) => ({
      const: c.const,
      title: c.title,
      ...(c.description !== undefined && c.description !== ""
        ? { description: c.description }
        : {}),
      ...(c.efforts !== undefined ? { efforts: [...c.efforts] } : {}),
    }));
    return this.#file.change((agents) => {
      const previous = agents.get(agent);
      const current = previous?.[configId];
      // A list that does not say a model's effort levels (the adapter's fallback before the SDK's catalog
      // arrives) keeps what an earlier one said, rather than forgetting it.
      const next = normalized.map((choice) => {
        if (choice.efforts !== undefined) return choice;
        const known = current?.find((c) => c.const === choice.const)?.efforts;
        return known !== undefined ? { ...choice, efforts: known } : choice;
      });
      if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) {
        return { answer: undefined };
      }
      return {
        value: new Map(agents).set(agent, { ...(previous ?? {}), [configId]: next }),
        answer: undefined,
      };
    });
  }

  /** Waits for any in-flight cache writes to finish before daemon shutdown. */
  flush(): Promise<void> {
    return this.#file.flush();
  }
}

/** Extracts cacheable choice entries for a specific `configId` from an ACP `configOptions` array. */
export const choicesFromConfigOptions = (
  options: unknown,
  configId: string,
): CachedChoice[] | undefined => {
  if (!Array.isArray(options)) return undefined;
  const entry = options.find(
    (item): item is { configId?: unknown; options?: unknown } =>
      typeof item === "object" &&
      item !== null &&
      (item as { configId?: unknown }).configId === configId,
  );
  if (!Array.isArray(entry?.options)) return undefined;
  const out: CachedChoice[] = [];
  for (const choice of entry.options) {
    if (typeof choice !== "object" || choice === null) continue;
    const c = choice as {
      value?: unknown;
      name?: unknown;
      description?: unknown;
      _meta?: Record<string, unknown>;
    };
    if (c._meta?.["cycle/custom"] === true) continue;
    if (typeof c.value !== "string" || c.value === "") continue;
    const efforts = c._meta?.[META.efforts];
    out.push({
      const: c.value,
      title: typeof c.name === "string" && c.name !== "" ? c.name : c.value,
      ...(typeof c.description === "string" && c.description !== ""
        ? { description: c.description }
        : {}),
      ...(Array.isArray(efforts) && efforts.every((e) => typeof e === "string")
        ? { efforts: efforts as string[] }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
};
