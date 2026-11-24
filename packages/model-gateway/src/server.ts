import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  createModels,
  createProvider,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CUSTOM_PI_PROVIDER, type Effort } from "./catalog.ts";
import {
  type CallSignatures,
  failure,
  type ResponseEvent,
  type ResponsesRequest,
  toContext,
  toResponseEvents,
} from "./responses.ts";

export interface StreamRequest {
  apiKey: string | null;
  effort: Effort | null;
  sessionId: string | null;
  signal: AbortSignal;
}

/** Asks a model. The real one is pi-ai; a test gives its own. */
export type ModelStream = (
  model: Model<Api>,
  context: Context,
  request: StreamRequest,
) => AsyncIterable<AssistantMessageEvent>;

export interface GatewayOptions {
  /** What the bearer of a request must be. */
  token: string;
  /** The model a request names and the key for it, or null when the owner offers no such model. */
  resolve(model: string): { model: Model<Api>; apiKey: string | null } | null;
  stream?: ModelStream;
  port?: number;
}

export interface Gateway {
  /** The address codex takes as a model provider's `base_url`. */
  readonly url: string;
  stop(): void;
}

let shared: Models | null = null;

/** Every service pi-ai knows, and one provider for the endpoints the owner describes. */
function piModels(): Models {
  if (shared) return shared;
  const models = createModels();
  for (const provider of builtinProviders()) models.setProvider(provider);
  models.setProvider(
    createProvider({
      id: CUSTOM_PI_PROVIDER,
      // The key comes with each request, and an endpoint on this machine may need none.
      auth: { apiKey: { name: "Custom endpoint", resolve: async () => ({ auth: {} }) } },
      models: [],
      api: {
        "openai-completions": openAICompletionsApi(),
        "openai-responses": openAIResponsesApi(),
        "anthropic-messages": anthropicMessagesApi(),
      },
    }),
  );
  shared = models;
  return models;
}

export const piStream: ModelStream = (model, context, request) =>
  piModels().streamSimple(model, context, {
    signal: request.signal,
    ...(request.apiKey ? { apiKey: request.apiKey } : {}),
    ...(request.effort && model.reasoning ? { reasoning: request.effort } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  });

/** How pi-ai begins a provider's answer that the same request would get again. */
const REFUSALS = /^(400|401|403|404|422)\b/;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function refuse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

/**
 * Holds back the answer until the model says something, so a request the
 * provider refuses outright (a bad key, an unknown model) is an HTTP error
 * codex reports once, instead of a stream it retries.
 */
async function firstEvents(
  events: AsyncGenerator<ResponseEvent>,
): Promise<{ head: ResponseEvent[]; refused: string | null }> {
  const head: ResponseEvent[] = [];
  for (;;) {
    const next = await events.next();
    if (next.done) return { head, refused: null };
    head.push(next.value);
    if (next.value.type === "response.failed") {
      const response = next.value.response as { error: { code: string; message: string } };
      // Only what asking again cannot mend is refused. The rest codex reads and retries, and
      // when the conversation is too long it makes room first.
      const final = REFUSALS.test(response.error.message);
      const overflow = response.error.code === "context_length_exceeded";
      return { head, refused: final && !overflow ? response.error.message : null };
    }
    if (next.value.type !== "response.created") return { head, refused: null };
  }
}

/**
 * A model provider for codex on loopback: it takes the Responses API requests
 * codex makes and answers them with whichever provider of the owner's the
 * model belongs to. It holds the owner's keys' reach, so it answers only the
 * bearer of its token.
 */
export function startGateway(options: GatewayOptions): Gateway {
  const stream = options.stream ?? piStream;
  const expected = digest(`Bearer ${options.token}`);
  const signatures: CallSignatures = new Map();
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    async fetch(request, bunServer) {
      const hosts = [`127.0.0.1:${bunServer.port}`, `localhost:${bunServer.port}`];
      if (!hosts.includes(request.headers.get("host") ?? "")) return refuse(403, "forbidden");
      if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), expected)) {
        return refuse(401, "unauthorized");
      }
      const { pathname } = new URL(request.url);
      if (request.method !== "POST" || !pathname.endsWith("/responses")) {
        return refuse(404, "not found");
      }
      let body: ResponsesRequest;
      try {
        body = (await request.json()) as ResponsesRequest;
      } catch {
        return refuse(400, "The request is not JSON.");
      }
      if (!Array.isArray(body?.input)) return refuse(400, "The request has no input.");
      const target = options.resolve(body.model);
      if (!target) {
        return refuse(
          400,
          `No provider in Cycle's settings offers the model "${body.model}". Choose another model.`,
        );
      }
      const responseId = `resp_${randomUUID()}`;
      const origin = {
        api: target.model.api,
        provider: target.model.provider,
        model: target.model.id,
        contextWindow: target.model.contextWindow,
      };
      const translated = toContext(body, Date.now(), origin, signatures);
      const events = toResponseEvents(
        stream(target.model, translated.context, {
          apiKey: target.apiKey,
          effort: translated.effort,
          sessionId: translated.sessionId,
          signal: request.signal,
        }),
        responseId,
        translated.names,
        origin,
        signatures,
      );
      let first: Awaited<ReturnType<typeof firstEvents>>;
      try {
        first = await firstEvents(events);
      } catch (error) {
        return refuse(502, error instanceof Error ? error.message : String(error));
      }
      if (first.refused !== null) return refuse(400, first.refused);
      const encoder = new TextEncoder();
      const frame = (event: ResponseEvent) =>
        encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const sse = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (const event of first.head) controller.enqueue(frame(event));
            for await (const event of events) controller.enqueue(frame(event));
          } catch (error) {
            controller.enqueue(
              frame(failure(responseId, error instanceof Error ? error.message : String(error))),
            );
          }
          controller.close();
        },
        cancel() {
          void events.return(undefined);
        },
      });
      return new Response(sse, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => void server.stop(true),
  };
}
