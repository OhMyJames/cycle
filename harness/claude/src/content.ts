import { type ContentBlock, RequestError } from "@agentclientprotocol/sdk/experimental/v2";
import { describePromptProblem, normalizePrompt } from "@cycle/protocol";

/** What the Claude SDK takes as the content of a user message. */
export type SdkContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
      title?: string;
    };

/** A value in a quoted attribute: it cannot end the quote or the tag. */
const attribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** A file's text cannot close the tag it is in: a `</file` inside it is written `<\/file`. */
const closing = (text: string): string => text.replace(/<\/file/gi, "<\\/file");

/** What Claude takes in a prompt beyond text and links. */
export const CLAUDE_PROMPT_CAPABILITIES = { image: {}, embeddedContext: {} } as const;

/**
 * A prompt as the SDK takes it. A prompt of only text and links stays a string. Every block is
 * either carried or the prompt is refused: nothing is dropped (decision 0010). Its blocks are read and checked by
 * the protocol's normalizePrompt; this only knows what each becomes for Claude.
 *
 * A `resource_link` is a mention, not content: the agent may read what it names if the path is on
 * its machine. It is written as a tag with the name and the address in attributes, which a model tells apart from the
 * words around it (.agents/notes/2026-11-18-mentions-are-resource-links.md). A text resource is put in as a tagged block
 * that names its uri.
 */
export const toSdkContent = (blocks: readonly ContentBlock[]): string | SdkContent[] => {
  const normalized = normalizePrompt(blocks, CLAUDE_PROMPT_CAPABILITIES, { limits: false });
  if (!normalized.ok) {
    throw new RequestError(-32602, describePromptProblem(normalized.problem), normalized.problem);
  }
  const parts: SdkContent[] = [];
  let plain = true;
  for (const block of normalized.blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "link") {
      parts.push({
        type: "text",
        text: `<mention name="${attribute(block.name)}" uri="${attribute(block.uri)}"/>`,
      });
    } else if (block.type === "image") {
      plain = false;
      parts.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
    } else if (block.type === "file") {
      plain = false;
      parts.push({
        type: "text",
        text: `<file uri="${attribute(block.uri)}">\n${closing(block.text)}\n</file>`,
      });
    } else if (block.type === "pdf") {
      plain = false;
      parts.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: block.data },
        title: block.uri,
      });
    } else {
      // Every kind of block is carried: a new one is a type error here, not one sent as something else.
      const unknown: never = block;
      throw new RequestError(-32602, "Unsupported content block", { block: unknown });
    }
  }
  if (plain) return parts.map((part) => (part as { text: string }).text).join("\n\n");
  return parts;
};
