import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type ImageContent,
  type JsonObject,
  type Message,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type Usage,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import { type Effort, isEffort } from "./catalog.ts";

/**
 * The OpenAI Responses API as codex speaks it, to and from pi-ai's own model
 * of a conversation. Pure: no network, no clock but the one passed in.
 *
 * Only what codex sends is read. An item or a tool of a kind not known here
 * is left out, so a newer codex degrades instead of failing.
 */

type Json = Record<string, unknown>;

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: Json[];
  tools?: Json[];
  reasoning?: { effort?: string | null } | null;
  prompt_cache_key?: string;
}

/** How a tool codex named reaches the model, and how its call goes back. */
interface ToolNames {
  /** A flattened name, to the namespace and name codex knows the tool by. */
  namespaced: Map<string, { namespace: string; name: string }>;
  /** Tools that take free text instead of JSON arguments. */
  freeform: Set<string>;
}

/** The model an answer came from. Thinking is only ever sent back to the model that did it. */
export interface Origin {
  api: string;
  provider: string;
  model: string;
}

/**
 * What a model signed on a tool call, by the call's id. The Responses API has no field to
 * carry it, and some models (Gemini) refuse a call sent back without it.
 */
export type CallSignatures = Map<string, { signature: string; origin: Origin }>;

/** shortcut: signatures are forgotten when the daemon stops; upgrade when codex returns a call's own id. */
const MAX_SIGNATURES = 4000;

export interface Translated {
  context: Context;
  effort: Effort | null;
  sessionId: string | null;
  names: ToolNames;
}

/** Marks reasoning this gateway wrote, so reasoning another provider encrypted is left alone. */
const REASONING_MARK = "cycle:";

const NO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flatName(namespace: string, name: string): string {
  return `${namespace}__${name}`;
}

function parseArguments(raw: unknown): JsonObject {
  try {
    const parsed: unknown = JSON.parse(text(raw) || "{}");
    return isJson(parsed) ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

/** `data:image/png;base64,...` as pi-ai carries an image. Any other address is not readable here. */
function toImage(url: unknown): ImageContent | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(text(url));
  return match?.[1] && match[2] ? { type: "image", mimeType: match[1], data: match[2] } : null;
}

function toParts(content: unknown): (TextContent | ImageContent)[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (!isJson(part)) continue;
    if (part["type"] === "input_image") {
      const image = toImage(part["image_url"]);
      parts.push(image ?? { type: "text", text: "[an image that could not be attached]" });
    } else if (typeof part["text"] === "string" && part["text"]) {
      parts.push({ type: "text", text: part["text"] });
    }
  }
  return parts;
}

function partsText(content: unknown): string {
  return toParts(content)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function toTools(raw: Json[], names: ToolNames): Tool[] {
  const tools: Tool[] = [];
  const add = (tool: Json, namespace: string | null) => {
    const name = text(tool["name"]);
    if (!name) return;
    if (tool["type"] === "function") {
      const exposed = namespace ? flatName(namespace, name) : name;
      if (namespace) names.namespaced.set(exposed, { namespace, name });
      tools.push({
        name: exposed,
        description: text(tool["description"]),
        parameters: isJson(tool["parameters"])
          ? tool["parameters"]
          : { type: "object", properties: {} },
      });
    } else if (tool["type"] === "custom") {
      names.freeform.add(name);
      tools.push({
        name,
        description: text(tool["description"]),
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "The tool's input, as text." } },
          required: ["input"],
          additionalProperties: false,
        },
      });
    }
  };
  for (const tool of raw) {
    if (tool["type"] === "namespace" && Array.isArray(tool["tools"])) {
      for (const inner of tool["tools"]) if (isJson(inner)) add(inner, text(tool["name"]));
    } else {
      add(tool, null);
    }
  }
  return tools;
}

function sameOrigin(a: Origin, b: Origin): boolean {
  return a.api === b.api && a.provider === b.provider && a.model === b.model;
}

function toThinking(item: Json): { block: ThinkingContent; origin: Origin } | null {
  const sealed = text(item["encrypted_content"]);
  if (!sealed.startsWith(REASONING_MARK)) return null;
  try {
    const opened: unknown = JSON.parse(
      Buffer.from(sealed.slice(REASONING_MARK.length), "base64").toString("utf8"),
    );
    if (!isJson(opened) || !isJson(opened["block"]) || !isJson(opened["origin"])) return null;
    if (opened["block"]["type"] !== "thinking") return null;
    return {
      block: opened["block"] as unknown as ThinkingContent,
      origin: opened["origin"] as unknown as Origin,
    };
  } catch {
    return null;
  }
}

/** What codex asks of the model, as pi-ai takes it. */
export function toContext(
  request: ResponsesRequest,
  now: number,
  target: Origin,
  signatures: CallSignatures = new Map(),
): Translated {
  const names: ToolNames = { namespaced: new Map(), freeform: new Set() };
  const tools = toTools(request.tools ?? [], names);
  const system: string[] = request.instructions ? [request.instructions] : [];
  const messages: Message[] = [];
  /** The assistant's turn being gathered: codex sends its text, thinking and calls as separate items. */
  let assistant: AssistantMessage | null = null;
  const toolNames = new Map<string, string>();

  const say = (block: AssistantMessage["content"][number]) => {
    if (!assistant) {
      assistant = {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "cycle",
        model: request.model,
        usage: NO_USAGE,
        stopReason: "stop",
        timestamp: now,
      };
      messages.push(assistant);
    }
    assistant.content.push(block);
    if (block.type === "toolCall") assistant.stopReason = "toolUse";
  };
  const call = (id: string, name: string, args: JsonObject) => {
    toolNames.set(id, name);
    const signed = signatures.get(id);
    const own = signed && sameOrigin(signed.origin, target);
    say({
      type: "toolCall",
      id,
      name,
      arguments: args,
      ...(own ? { thoughtSignature: signed.signature } : {}),
    });
    if (own) Object.assign(assistant ?? {}, target);
  };
  const result = (id: string, output: unknown) => {
    assistant = null;
    const content = toParts(output);
    messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: toolNames.get(id) ?? "",
      content: content.length ? content : [{ type: "text", text: "" }],
      isError: false,
      timestamp: now,
    });
  };

  for (const item of request.input) {
    switch (item["type"]) {
      case "message": {
        const role = item["role"];
        if (role === "assistant") {
          const said = partsText(item["content"]);
          if (said) say({ type: "text", text: said });
        } else if (role === "user") {
          assistant = null;
          const content = toParts(item["content"]);
          if (content.length) messages.push({ role: "user", content, timestamp: now });
        } else {
          // Instructions before the conversation are its system prompt; later ones stay in place.
          const said = partsText(item["content"]);
          if (!said) break;
          if (messages.length === 0) system.push(said);
          else {
            assistant = null;
            messages.push({ role: "system", content: said, timestamp: now });
          }
        }
        break;
      }
      case "reasoning": {
        // pi-ai sends thinking back only within an answer of the model now asked, so an answer
        // is marked as that model's when its thinking says so. Any other stays a stranger's,
        // and pi-ai makes its call ids fit and leaves its thinking out.
        const thinking = toThinking(item);
        if (!thinking || !sameOrigin(thinking.origin, target)) break;
        say(thinking.block);
        Object.assign(assistant ?? {}, target);
        break;
      }
      case "function_call": {
        const namespace = text(item["namespace"]);
        const name = text(item["name"]);
        call(
          text(item["call_id"]),
          namespace ? flatName(namespace, name) : name,
          parseArguments(item["arguments"]),
        );
        break;
      }
      case "custom_tool_call":
        call(text(item["call_id"]), text(item["name"]), { input: text(item["input"]) });
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        result(text(item["call_id"]), item["output"]);
        break;
      default:
        break;
    }
  }

  const effort = request.reasoning?.effort;
  return {
    context: {
      ...(system.length ? { systemPrompt: system.join("\n\n") } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
    },
    effort: isEffort(effort) ? effort : null,
    sessionId: request.prompt_cache_key ?? null,
    names,
  };
}

export type ResponseEvent = Json & { type: string };

function usageOf(message: AssistantMessage): Json {
  const { usage } = message;
  // OpenAI counts what was read from the cache as input; pi-ai counts it apart.
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
    total_tokens: input + usage.output,
  };
}

function reasoningItem(id: string, block: ThinkingContent, origin: Origin): Json {
  return {
    type: "reasoning",
    id,
    summary: block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
    // The whole block goes back to its model next turn, signature included.
    encrypted_content:
      REASONING_MARK + Buffer.from(JSON.stringify({ block, origin }), "utf8").toString("base64"),
  };
}

function callItem(id: string, call: ToolCall, names: ToolNames): Json {
  if (names.freeform.has(call.name)) {
    const input = call.arguments["input"];
    return {
      type: "custom_tool_call",
      id,
      call_id: call.id,
      name: call.name,
      input: typeof input === "string" ? input : JSON.stringify(call.arguments),
    };
  }
  const namespaced = names.namespaced.get(call.name);
  return {
    type: "function_call",
    id,
    call_id: call.id,
    name: namespaced?.name ?? call.name,
    ...(namespaced ? { namespace: namespaced.namespace } : {}),
    arguments: JSON.stringify(call.arguments),
  };
}

/** `overflow` says the conversation no longer fits the model: codex makes room and asks again. */
export function failure(responseId: string, message: string, overflow = false): ResponseEvent {
  return {
    type: "response.failed",
    response: {
      id: responseId,
      status: "failed",
      error: { code: overflow ? "context_length_exceeded" : "server_error", message },
    },
  };
}

/** What the model answers, as the events codex reads. */
export async function* toResponseEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  responseId: string,
  names: ToolNames,
  origin: Origin & { contextWindow: number },
  signatures: CallSignatures = new Map(),
): AsyncGenerator<ResponseEvent> {
  yield { type: "response.created", response: { id: responseId } };
  // One output item per block of the answer, in the order the blocks began.
  const ids = new Map<number, string>();
  const idOf = (index: number, prefix: string): string => {
    let id = ids.get(index);
    if (!id) {
      id = `${prefix}_${responseId}_${index}`;
      ids.set(index, id);
    }
    return id;
  };
  for await (const event of events) {
    switch (event.type) {
      case "text_start":
        yield {
          type: "response.output_item.added",
          output_index: event.contentIndex,
          item: {
            type: "message",
            id: idOf(event.contentIndex, "msg"),
            role: "assistant",
            content: [],
          },
        };
        break;
      case "text_delta":
        yield {
          type: "response.output_text.delta",
          item_id: idOf(event.contentIndex, "msg"),
          output_index: event.contentIndex,
          content_index: 0,
          delta: event.delta,
        };
        break;
      case "text_end":
        yield {
          type: "response.output_item.done",
          output_index: event.contentIndex,
          item: {
            type: "message",
            id: idOf(event.contentIndex, "msg"),
            role: "assistant",
            content: [{ type: "output_text", text: event.content }],
          },
        };
        break;
      case "thinking_start": {
        const id = idOf(event.contentIndex, "rs");
        yield {
          type: "response.output_item.added",
          output_index: event.contentIndex,
          item: { type: "reasoning", id, summary: [] },
        };
        yield {
          type: "response.reasoning_summary_part.added",
          item_id: id,
          output_index: event.contentIndex,
          summary_index: 0,
        };
        break;
      }
      case "thinking_delta":
        yield {
          type: "response.reasoning_summary_text.delta",
          item_id: idOf(event.contentIndex, "rs"),
          output_index: event.contentIndex,
          summary_index: 0,
          delta: event.delta,
        };
        break;
      case "thinking_end": {
        const block = event.partial.content[event.contentIndex];
        if (block?.type !== "thinking") break;
        yield {
          type: "response.output_item.done",
          output_index: event.contentIndex,
          item: reasoningItem(idOf(event.contentIndex, "rs"), block, {
            api: origin.api,
            provider: origin.provider,
            model: origin.model,
          }),
        };
        break;
      }
      case "toolcall_end":
        if (event.toolCall.thoughtSignature) {
          signatures.set(event.toolCall.id, {
            signature: event.toolCall.thoughtSignature,
            origin: { api: origin.api, provider: origin.provider, model: origin.model },
          });
          for (const oldest of signatures.keys()) {
            if (signatures.size <= MAX_SIGNATURES) break;
            signatures.delete(oldest);
          }
        }
        yield {
          type: "response.output_item.done",
          output_index: event.contentIndex,
          item: callItem(idOf(event.contentIndex, "fc"), event.toolCall, names),
        };
        break;
      case "done":
        yield {
          type: "response.completed",
          response: { id: responseId, usage: usageOf(event.message) },
        };
        return;
      case "error":
        // A stopped request has nobody left to tell.
        if (event.reason === "aborted") return;
        yield failure(
          responseId,
          event.error.errorMessage || "The provider failed to answer.",
          isContextOverflow(event.error, origin.contextWindow),
        );
        return;
      default:
        break;
    }
  }
}
