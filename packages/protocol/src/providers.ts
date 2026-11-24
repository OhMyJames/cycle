import { z } from "zod";
import { cycleMethod } from "./method.ts";

/** The protocols an endpoint of the owner's own may speak. */
export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/** The kind of a provider that is an endpoint the owner describes, not a known service. */
export const CUSTOM_PROVIDER_KIND = "custom";

export interface ProviderModel {
  id: string;
  name: string;
  /** Whether it can think before it answers. */
  reasoning: boolean;
  images: boolean;
  /** Tokens it can read, and the most it may write in one answer. */
  contextWindow: number;
  maxTokens: number;
}

/** A known service a provider can be for. */
export interface ProviderKind {
  id: string;
  name: string;
}

/** A model provider of the owner's. Its key stays in the daemon. */
export interface ModelProvider {
  id: string;
  name: string;
  /** A `ProviderKind` id, or `CUSTOM_PROVIDER_KIND`. */
  kind: string;
  /** What a custom endpoint speaks. Null for a known service. */
  api: ProviderApi | null;
  /** A custom endpoint's address, or another address for a known service. */
  baseUrl: string | null;
  hasKey: boolean;
  /** The models the owner chose to use. */
  models: ProviderModel[];
}

export const ProviderApiSchema = z.enum(PROVIDER_APIS);

export const ProviderModelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  reasoning: z.boolean(),
  images: z.boolean(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
});

export const ModelProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  api: ProviderApiSchema.nullable(),
  baseUrl: z.string().nullable(),
  hasKey: z.boolean(),
  models: z.array(ProviderModelSchema),
});

export const ModelProviderDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(200),
  kind: z.string().min(1).max(100),
  api: ProviderApiSchema.nullable(),
  baseUrl: z.string().max(2048).nullable(),
  apiKey: z.string().max(4096).optional(),
  models: z.array(ProviderModelSchema).max(200),
});

/** The owner's model providers, and the known services one can be made for. A key is never in an answer. */
export const providersList = cycleMethod(
  "_cycle/providers/list",
  z.object({}),
  z.object({
    providers: z.array(ModelProviderSchema),
    kinds: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
);

/** The models a known service is known to serve. */
export const providersCatalog = cycleMethod(
  "_cycle/providers/catalog",
  z.object({ kind: z.string().min(1).max(100) }),
  z.object({ models: z.array(ProviderModelSchema) }),
);

export const providersSave = cycleMethod(
  "_cycle/providers/save",
  z.object({ provider: ModelProviderDraftSchema }),
  z.object({ provider: ModelProviderSchema }),
);

export const providersRemove = cycleMethod(
  "_cycle/providers/remove",
  z.object({ id: z.string().min(1) }),
  z.object({}),
);

/** What the owner sends to add a provider, or to change the one with this id. */
export type ModelProviderDraft = z.input<typeof ModelProviderDraftSchema>;
