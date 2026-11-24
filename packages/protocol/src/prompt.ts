import { z } from "zod";

/** What a prompt may carry (docs/protocol.md §8, decision 0010). Decoded bytes, not base64. */
export const PROMPT_LIMITS = {
  blockBytes: 5 * 1024 * 1024,
  promptBytes: 12 * 1024 * 1024,
  blocks: 32,
} as const;

/** The image types every Claude-class model takes. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** What an agent takes in a prompt beyond text and links: ACP's `PromptCapabilities`. */
export const PromptCapabilitiesSchema = z.object({
  image: z.object({}).loose().nullish(),
  audio: z.object({}).loose().nullish(),
  embeddedContext: z.object({}).loose().nullish(),
});
export type PromptCapabilities = z.infer<typeof PromptCapabilitiesSchema>;

/** Why a prompt was refused. Short codes: a client may act on them, never parse the message. */
export type PromptProblemReason =
  | "empty"
  | "too_many_blocks"
  | "unsupported_block"
  | "malformed_block"
  | "unsupported_media_type"
  | "block_too_large"
  | "prompt_too_large"
  | "invalid_base64";

export type PromptProblem = { reason: PromptProblemReason; index?: number };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Bytes a base64 string decodes to, or undefined if it is not base64. */
export const base64Bytes = (data: string): number | undefined => {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

type Block = { type?: unknown; [key: string]: unknown };

/**
 * A block of a prompt, as an adapter needs it once the prompt is checked: one shape for each thing a prompt can carry.
 * `link`: a `resource_link` (a mention). `file`: an embedded resource of text. `pdf`: an embedded PDF.
 */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "link"; name: string; uri: string }
  | { type: "image"; mimeType: (typeof IMAGE_TYPES)[number]; data: string }
  | { type: "file"; uri: string; text: string }
  | { type: "pdf"; uri: string; data: string };

export type NormalizedPrompt =
  | { ok: true; blocks: PromptBlock[] }
  | { ok: false; problem: PromptProblem };

/** What else a prompt is held to: the sizes in PROMPT_LIMITS (by default), and whether an agent takes a PDF. */
export type PromptRules = {
  /**
   * False for an adapter: the daemon holds a prompt to the sizes as it is sent, and then may make it larger (a session
   * it mentions, put in as a transcript) before an agent gets it.
   */
  limits?: boolean;
  /** False for an agent that takes embedded text but no PDF (ACP's capabilities cannot tell them apart). */
  pdf?: boolean;
};

const encoder = new TextEncoder();

/**
 * A prompt checked and in typed blocks, or the first thing wrong with it for an agent with `capabilities`, in the
 * order of its blocks. Nothing is dropped: a prompt is taken whole or refused. The daemon checks what a client sends
 * with it; an adapter reads its blocks from here, so that it only knows what each becomes for its agent.
 */
export const normalizePrompt = (
  prompt: readonly unknown[],
  capabilities: PromptCapabilities | undefined,
  rules: PromptRules = {},
): NormalizedPrompt => {
  const limits = rules.limits ?? true;
  const refuse = (reason: PromptProblemReason, index?: number): NormalizedPrompt => ({
    ok: false,
    problem: index === undefined ? { reason } : { reason, index },
  });
  if (prompt.length === 0) return refuse("empty");
  if (limits && prompt.length > PROMPT_LIMITS.blocks) return refuse("too_many_blocks");
  const blocks: PromptBlock[] = [];
  let total = 0;
  for (const [index, raw] of prompt.entries()) {
    const block = (typeof raw === "object" && raw !== null ? raw : {}) as Block;
    let bytes = 0;
    if (block.type === "text") {
      if (typeof block.text !== "string") return refuse("malformed_block", index);
      // Text counts too: a pasted file of text is as large on the wire as an image of the same size.
      if (limits) bytes = encoder.encode(block.text).length;
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "resource_link") {
      if (typeof block.name !== "string" || typeof block.uri !== "string") {
        return refuse("malformed_block", index);
      }
      // A link has no content, but a long name or uri is as large on the wire as any text.
      if (limits) bytes = encoder.encode(block.name + block.uri).length;
      blocks.push({ type: "link", name: block.name, uri: block.uri });
    } else if (block.type === "image") {
      if (capabilities?.image == null) return refuse("unsupported_block", index);
      const mimeType = IMAGE_TYPES.find((type) => type === block.mimeType);
      if (mimeType === undefined) return refuse("unsupported_media_type", index);
      const decoded = typeof block.data === "string" ? base64Bytes(block.data) : undefined;
      // An image of no bytes is not an image.
      if (decoded === undefined || decoded === 0) return refuse("invalid_base64", index);
      bytes = decoded;
      blocks.push({ type: "image", mimeType, data: block.data as string });
    } else if (block.type === "resource") {
      if (capabilities?.embeddedContext == null) return refuse("unsupported_block", index);
      const resource = (block.resource ?? {}) as Record<string, unknown>;
      if (typeof resource.uri !== "string") return refuse("malformed_block", index);
      if (typeof resource.text === "string") {
        if (limits) bytes = encoder.encode(resource.text).length;
        blocks.push({ type: "file", uri: resource.uri, text: resource.text });
      } else if (typeof resource.blob === "string") {
        if (resource.mimeType !== "application/pdf" || rules.pdf === false) {
          return refuse("unsupported_media_type", index);
        }
        const decoded = base64Bytes(resource.blob);
        if (decoded === undefined || decoded === 0) return refuse("invalid_base64", index);
        bytes = decoded;
        blocks.push({ type: "pdf", uri: resource.uri, data: resource.blob });
      } else {
        return refuse("unsupported_block", index);
      }
    } else {
      return refuse("unsupported_block", index);
    }
    if (!limits) continue;
    if (bytes > PROMPT_LIMITS.blockBytes) return refuse("block_too_large", index);
    total += bytes;
    if (total > PROMPT_LIMITS.promptBytes) return refuse("prompt_too_large", index);
  }
  return { ok: true, blocks };
};

/**
 * The first thing wrong with a prompt, or undefined if it is acceptable to an agent with
 * `capabilities`. The daemon enforces this; a client can call it before sending.
 */
export const checkPrompt = (
  prompt: readonly unknown[],
  capabilities: PromptCapabilities | undefined,
): PromptProblem | undefined => {
  const normalized = normalizePrompt(prompt, capabilities);
  return normalized.ok ? undefined : normalized.problem;
};

/** A problem in words, for an adapter's refusal: the reason and index go with it as data, for a client to act on. */
export const describePromptProblem = (problem: PromptProblem): string =>
  ({
    empty: "A prompt needs content",
    too_many_blocks: "The prompt has too many blocks",
    unsupported_block: "Unsupported content block",
    malformed_block: "A content block is malformed",
    unsupported_media_type: "Unsupported media type",
    block_too_large: "A content block is too large",
    prompt_too_large: "The prompt is too large",
    invalid_base64: "A content block's data is not base64",
  })[problem.reason];
