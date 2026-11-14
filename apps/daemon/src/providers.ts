import {
  catalogModels,
  isProviderKind,
  modelInfos,
  type ProviderConfig,
  providerKinds,
} from "@cycle/gateway";
import {
  CUSTOM_PROVIDER_KIND,
  type ModelInfo,
  type ModelProvider,
  type ModelProviderDraft,
  PROVIDER_APIS,
  type ProviderKind,
  type ProviderModel,
} from "@cycle/protocol";
import type { JsonStore } from "./store.ts";

/** `providers.json`: the owner's model providers, keys included, so the file is the owner's alone. */
export interface ProvidersFile {
  providers: ProviderConfig[];
}

export class ProviderError extends Error {}

const MAX_MODELS = 200;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/** An address a provider can be asked at: http or https, with no credentials in it. */
function cleanUrl(value: string | null): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProviderError("The address is not a URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("The address must begin with http:// or https://.");
  }
  if (url.username || url.password) {
    throw new ProviderError("Put the key in its own field, not in the address.");
  }
  return trimmed;
}

function cleanModels(kind: string, models: ProviderModel[]): ProviderModel[] {
  if (!Array.isArray(models)) throw new ProviderError("Choose at least one model.");
  const known = new Map(catalogModels(kind).map((model) => [model.id, model]));
  const seen = new Set<string>();
  const clean: ProviderModel[] = [];
  for (const model of models.slice(0, MAX_MODELS)) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (kind !== CUSTOM_PROVIDER_KIND) {
      // What a known service's model can do is the catalog's to say, not the page's. One the
      // catalog no longer has is let go, so a provider chosen before it left can still be saved.
      const entry = known.get(id);
      if (entry) clean.push(entry);
      continue;
    }
    clean.push({
      id,
      name: (typeof model.name === "string" && model.name.trim()) || id,
      reasoning: model.reasoning === true,
      images: model.images === true,
      contextWindow: positive(model.contextWindow, DEFAULT_CONTEXT_WINDOW),
      maxTokens: positive(model.maxTokens, DEFAULT_MAX_TOKENS),
    });
  }
  if (!clean.length) throw new ProviderError("Choose at least one model.");
  return clean;
}

function toView(config: ProviderConfig): ModelProvider {
  const { apiKey, ...shown } = config;
  return { ...shown, hasKey: Boolean(apiKey) };
}

/**
 * The owner's model providers. A key comes in once and never goes back out:
 * the page sees only whether there is one.
 */
export class Providers {
  private readonly store: JsonStore<ProvidersFile>;
  private readonly changed: (providers: ModelProvider[]) => void;

  constructor(store: JsonStore<ProvidersFile>, changed: (providers: ModelProvider[]) => void) {
    this.store = store;
    this.changed = changed;
  }

  list(): ModelProvider[] {
    return this.store.value.providers.map(toView);
  }

  kinds(): ProviderKind[] {
    return providerKinds();
  }

  catalog(kind: string): ProviderModel[] {
    return catalogModels(kind);
  }

  /** Every model the owner chose, as a session can choose it. */
  models(): Omit<ModelInfo, "harness" | "sandbox">[] {
    return this.store.value.providers.flatMap(modelInfos);
  }

  /** The stored providers, keys included. For the gateway alone. */
  configs(): readonly ProviderConfig[] {
    return this.store.value.providers;
  }

  save(draft: ModelProviderDraft): ModelProvider {
    const existing = draft.id
      ? this.store.value.providers.find((provider) => provider.id === draft.id)
      : undefined;
    if (draft.id && !existing) throw new ProviderError("That provider is gone.");
    const kind = existing?.kind ?? draft.kind;
    if (!isProviderKind(kind)) throw new ProviderError("That kind of provider is not known.");
    const custom = kind === CUSTOM_PROVIDER_KIND;
    const baseUrl = cleanUrl(draft.baseUrl);
    if (custom && !baseUrl) throw new ProviderError("A custom provider needs an address.");
    if (custom && !PROVIDER_APIS.includes(draft.api as (typeof PROVIDER_APIS)[number])) {
      throw new ProviderError("Choose the protocol the endpoint speaks.");
    }
    const name =
      (typeof draft.name === "string" && draft.name.trim().slice(0, 60)) ||
      this.kinds().find((known) => known.id === kind)?.name ||
      "Custom";
    const key = typeof draft.apiKey === "string" ? draft.apiKey.trim() : undefined;
    const config: ProviderConfig = {
      id: existing?.id ?? this.newId(custom ? name : kind),
      name,
      kind,
      api: custom ? draft.api : null,
      baseUrl,
      // A key was given for one address. At another it must be given again, or whoever can
      // reach the daemon could have it sent wherever they like.
      apiKey:
        key === undefined
          ? existing && existing.baseUrl === baseUrl
            ? existing.apiKey
            : null
          : key || null,
      models: cleanModels(kind, draft.models),
    };
    this.store.update((file) => {
      const index = file.providers.findIndex((provider) => provider.id === config.id);
      if (index === -1) file.providers.push(config);
      else file.providers[index] = config;
    });
    this.changed(this.list());
    return toView(config);
  }

  remove(id: string): void {
    this.store.update((file) => {
      file.providers = file.providers.filter((provider) => provider.id !== id);
    });
    this.changed(this.list());
  }

  /** An id no provider has: it names the provider in every model id, so it never changes. */
  private newId(from: string): string {
    const base = slug(from) || "provider";
    const taken = new Set(this.store.value.providers.map((provider) => provider.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }
}
