import {
  CUSTOM_PROVIDER_KIND,
  type ModelProvider,
  type ProviderKind,
  type ProviderModel,
} from "@cycle/protocol";
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** A provider as the daemon stores it: what the owner sees, and the key. */
export interface ProviderConfig extends Omit<ModelProvider, "hasKey"> {
  apiKey: string | null;
}

/** The provider id pi-ai routes a custom endpoint's models by. */
export const CUSTOM_PI_PROVIDER = "cycle-custom";

/** Services that sign in some other way than a key the owner can paste, or need more than one. */
const NOT_BY_KEY = new Set(["amazon-bedrock", "github-copilot", "google-vertex", "radius"]);

/** The efforts codex can ask for that pi-ai has a thinking level of the same name for. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: unknown): value is Effort {
  return EFFORTS.includes(value as Effort);
}

let builtin: Map<string, Provider> | null = null;

/** The services pi-ai knows that need only a key and an address it already has. */
function services(): Map<string, Provider> {
  builtin ??= new Map(
    builtinProviders()
      .filter((provider) => {
        const models = provider.getModels();
        return (
          provider.auth.apiKey !== undefined &&
          !NOT_BY_KEY.has(provider.id) &&
          models.length > 0 &&
          models.every((model) => model.baseUrl && !model.baseUrl.includes("{"))
        );
      })
      .map((provider) => [provider.id, provider]),
  );
  return builtin;
}

function toProviderModel(model: Model<Api>): ProviderModel {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    images: model.input.includes("image"),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export function providerKinds(): ProviderKind[] {
  return [...services().values()]
    .map((provider) => ({ id: provider.id, name: provider.name }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function isProviderKind(kind: string): boolean {
  return kind === CUSTOM_PROVIDER_KIND || services().has(kind);
}

/** The models a service is known to serve. A custom endpoint has none: the owner names them. */
export function catalogModels(kind: string): ProviderModel[] {
  return (services().get(kind)?.getModels() ?? []).map(toProviderModel);
}

/** The pi-ai model a provider's model id means, or null when the provider does not offer it. */
export function piModel(config: ProviderConfig, modelId: string): Model<Api> | null {
  const chosen = config.models.find((model) => model.id === modelId);
  if (!chosen) return null;
  if (config.kind !== CUSTOM_PROVIDER_KIND) {
    const known = services()
      .get(config.kind)
      ?.getModels()
      .find((model) => model.id === modelId);
    if (!known) return null;
    return config.baseUrl ? { ...known, baseUrl: config.baseUrl } : known;
  }
  if (!config.api || !config.baseUrl) return null;
  return {
    id: chosen.id,
    name: chosen.name,
    api: config.api,
    provider: CUSTOM_PI_PROVIDER,
    baseUrl: config.baseUrl,
    reasoning: chosen.reasoning,
    input: chosen.images ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: chosen.contextWindow,
    maxTokens: chosen.maxTokens,
  };
}

/** The id the agent knows a provider's model by. A model id may itself hold a slash. */
export function modelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function splitModelRef(ref: string): { providerId: string; modelId: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** A provider's model as a session can choose it. */
export interface ProviderModelInfo {
  /** `<provider id>/<model id>`. */
  id: string;
  name: string;
  /** The provider's name. */
  description: string;
  efforts: { id: Effort; description: string }[];
  defaultEffort: Effort | null;
  images: boolean;
  /** Tokens the model can read. */
  contextWindow: number;
  provider: { id: string; name: string };
}

/** A provider's models as a session can choose them. */
export function modelInfos(config: ProviderConfig): ProviderModelInfo[] {
  return config.models.flatMap((chosen) => {
    const model = piModel(config, chosen.id);
    if (!model) return [];
    const levels = model.reasoning ? getSupportedThinkingLevels(model) : [];
    const efforts = EFFORTS.filter((effort) => levels.includes(effort));
    return [
      {
        id: modelRef(config.id, chosen.id),
        name: chosen.name || chosen.id,
        description: config.name,
        efforts: efforts.map((id) => ({ id, description: "" })),
        defaultEffort: efforts.includes("medium") ? "medium" : (efforts[0] ?? null),
        images: chosen.images,
        contextWindow: chosen.contextWindow,
        provider: { id: config.id, name: config.name },
      },
    ];
  });
}
