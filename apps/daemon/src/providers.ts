// The owner's model providers (docs/adapters/codex.md "自带模型"): what is kept in `providers.json`, and the gateway that
// answers Codex for them. A key comes in once and never goes back out: a client sees only whether there is one.
import { randomBytes } from "node:crypto";
import {
  catalogModels,
  type Gateway,
  isProviderKind,
  modelInfos,
  type ProviderConfig,
  type ProviderModelInfo,
  piModel,
  providerKinds,
  splitModelRef,
  startGateway,
} from "@cycle/model-gateway";
import {
  CUSTOM_PROVIDER_KIND,
  META,
  type ModelProvider,
  type ModelProviderDraft,
  ModelProviderDraftSchema,
  PROVIDER_APIS,
  type ProviderKind,
  type ProviderModel,
  ProviderModelSchema,
} from "@cycle/protocol";
import { z } from "zod";
import { INVALID_PARAMS, RpcError } from "./errors.ts";
import { JsonFile, readJsonFile } from "./json-file.ts";

const FileSchema = z.object({
  version: z.literal(1),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      api: z.enum(PROVIDER_APIS).nullable(),
      baseUrl: z.string().nullable(),
      apiKey: z.string().nullable(),
      models: z.array(ProviderModelSchema),
    }),
  ),
});

/** `providers.json` is there but cannot be read. It is not replaced: it holds the owner's keys. */
export class ProvidersUnreadableError extends Error {
  constructor(path: string, detail: string) {
    super(
      `The model providers at ${path} cannot be read (${detail}). Fix or move it; it is not replaced.`,
    );
    this.name = "ProvidersUnreadableError";
  }
}

/** What the Codex adapter is given to run a session on one of the owner's models: where to ask, and what there is. */
export type AdapterProviders = {
  url: string;
  token: string;
  models: ProviderModelInfo[];
};

const MAX_MODELS = 200;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const refuse = (message: string): never => {
  throw new RpcError(INVALID_PARAMS, message);
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

const positive = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;

/** An address a provider can be asked at: http or https, with no credentials in it. */
const cleanUrl = (value: string | null): string | null => {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return refuse("The address is not a URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    refuse("The address must begin with http:// or https://.");
  if (url.username || url.password) refuse("Put the key in its own field, not in the address.");
  return trimmed;
};

const cleanModels = (kind: string, models: ProviderModel[]): ProviderModel[] => {
  const known = new Map(catalogModels(kind).map((model) => [model.id, model]));
  const seen = new Set<string>();
  const clean: ProviderModel[] = [];
  for (const model of models.slice(0, MAX_MODELS)) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (kind !== CUSTOM_PROVIDER_KIND) {
      // What a known service's model can do is the catalog's to say, not the client's. One the catalog no longer has
      // is let go, so a provider chosen before it left can still be saved.
      const entry = known.get(id);
      if (entry) clean.push(entry);
      continue;
    }
    clean.push({
      id,
      name: model.name.trim() || id,
      reasoning: model.reasoning,
      images: model.images,
      contextWindow: positive(model.contextWindow, DEFAULT_CONTEXT_WINDOW),
      maxTokens: positive(model.maxTokens, DEFAULT_MAX_TOKENS),
    });
  }
  if (!clean.length) refuse("Choose at least one model.");
  return clean;
};

const toView = (config: ProviderConfig): ModelProvider => {
  const { apiKey, ...shown } = config;
  return { ...shown, hasKey: Boolean(apiKey) };
};

export class ModelProviders {
  readonly #file: JsonFile<readonly ProviderConfig[]>;
  readonly #listeners = new Set<() => void>();
  #gateway: Gateway | undefined;
  #token: string | undefined;

  private constructor(path: string, providers: readonly ProviderConfig[]) {
    this.#file = new JsonFile(path, providers, (value) => ({ version: 1, providers: value }));
  }

  static async load(path: string): Promise<ModelProviders> {
    const parsed = await readJsonFile(
      path,
      FileSchema,
      (detail) => new ProvidersUnreadableError(path, detail),
    );
    return new ModelProviders(path, parsed?.providers ?? []);
  }

  /** Called after a provider is saved or removed. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): ModelProvider[] {
    return this.#file.value.map(toView);
  }

  kinds(): ProviderKind[] {
    return providerKinds();
  }

  catalog(kind: string): ProviderModel[] {
    return catalogModels(kind);
  }

  /** Every model the owner chose, as a session can choose it. */
  models(): ProviderModelInfo[] {
    return this.#file.value.flatMap(modelInfos);
  }

  async save(draftInput: ModelProviderDraft): Promise<ModelProvider> {
    const draft = ModelProviderDraftSchema.parse(draftInput);
    const saved = await this.#file.change((providers) => {
      const existing = draft.id
        ? providers.find((provider) => provider.id === draft.id)
        : undefined;
      if (draft.id && !existing) refuse("That provider is gone.");
      const kind = existing?.kind ?? draft.kind;
      if (!isProviderKind(kind)) refuse("That kind of provider is not known.");
      const custom = kind === CUSTOM_PROVIDER_KIND;
      const baseUrl = cleanUrl(draft.baseUrl);
      if (custom && !baseUrl) refuse("A custom provider needs an address.");
      if (custom && draft.api === null) refuse("Choose the protocol the endpoint speaks.");
      const name =
        draft.name.trim().slice(0, 60) ||
        this.kinds().find((known) => known.id === kind)?.name ||
        "Custom";
      const key = draft.apiKey?.trim();
      const config: ProviderConfig = {
        id: existing?.id ?? this.#newId(providers, custom ? name : kind),
        name,
        kind,
        api: custom ? draft.api : null,
        baseUrl,
        // A key was given for one address. At another it must be given again, or whoever can reach the daemon could
        // have it sent wherever they like.
        apiKey:
          key === undefined
            ? existing && existing.baseUrl === baseUrl
              ? existing.apiKey
              : null
            : key || null,
        models: cleanModels(kind, draft.models),
      };
      const next = existing
        ? providers.map((provider) => (provider.id === config.id ? config : provider))
        : [...providers, config];
      return { value: next, answer: config };
    });
    this.#changed();
    return toView(saved);
  }

  async remove(id: string): Promise<void> {
    await this.#file.change((providers) =>
      providers.some((provider) => provider.id === id)
        ? { value: providers.filter((provider) => provider.id !== id), answer: undefined }
        : { answer: undefined },
    );
    this.#changed();
  }

  /**
   * What an adapter needs to serve a session on the owner's models, or undefined when there are none. The gateway is
   * started by the first call: nothing listens until an owner has a provider and a session asks.
   */
  adapterConfig(): AdapterProviders | undefined {
    const models = this.models();
    if (!models.length) return undefined;
    this.#token ??= randomBytes(32).toString("base64url");
    const token = this.#token;
    this.#gateway ??= startGateway({
      token,
      resolve: (ref) => {
        const parts = splitModelRef(ref);
        const config = parts && this.#file.value.find(({ id }) => id === parts.providerId);
        const model = config && parts ? piModel(config, parts.modelId) : null;
        return config && model ? { model, apiKey: config.apiKey } : null;
      },
    });
    return { url: this.#gateway.url, token, models };
  }

  async close(): Promise<void> {
    this.#gateway?.stop();
    this.#gateway = undefined;
    await this.#file.flush();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** An id no provider has: it names the provider in every model id, so it never changes. */
  #newId(providers: readonly ProviderConfig[], from: string): string {
    const base = slug(from) || "provider";
    const taken = new Set(providers.map((provider) => provider.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }
}

/**
 * An agent's `configSchema` with the owner's models added to its `model` choices, each marked with the provider that
 * serves it (`META.provider`). A schema with no `model` choices is left as it is.
 */
export const withProviderModels = (
  schema: Record<string, unknown>,
  models: readonly ProviderModelInfo[],
): Record<string, unknown> => {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const model = properties?.model;
  if (models.length === 0 || model === undefined || !Array.isArray(model.oneOf)) return schema;
  const added = models.map((info) => ({
    const: info.id,
    title: info.name,
    description: info.description,
    _meta: {
      [META.efforts]: info.efforts.map((effort) => effort.id),
      [META.provider]: info.provider,
    },
  }));
  return {
    ...schema,
    properties: { ...properties, model: { ...model, oneOf: [...model.oneOf, ...added] } },
  };
};
