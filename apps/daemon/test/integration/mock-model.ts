/**
 * A stand-in for the OpenAI Responses API, so the whole stack
 * (codex app-server -> harness -> daemon -> client) can be exercised
 * end-to-end without credentials or network access.
 */

export type MockReply =
  /** The model answers in text, streamed chunk by chunk. */
  | { text: string[]; delayMs?: number }
  /** The model calls a tool. Codex runs it and asks again. */
  | { call: { name: string; arguments: Record<string, unknown> } };

export interface MockModel {
  url: string;
  /** Request bodies codex sent to POST /v1/responses. */
  requests: unknown[];
  /** `-c` overrides that point codex at this server. */
  codexConfig: Record<string, string | number | boolean>;
  stop(): void;
}

type SseEvent = Record<string, unknown> & { type: string };

function completed(index: number): SseEvent {
  return {
    type: "response.completed",
    response: {
      id: `resp_${index}`,
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 150,
      },
    },
  };
}

function eventsFor(index: number, reply: MockReply): SseEvent[] {
  const created: SseEvent = { type: "response.created", response: { id: `resp_${index}` } };
  if ("call" in reply) {
    const item = {
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name: reply.call.name,
      arguments: JSON.stringify(reply.call.arguments),
    };
    return [
      created,
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item },
      completed(index),
    ];
  }
  const id = `msg_${index}`;
  return [
    created,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id, role: "assistant", content: [] },
    },
    ...reply.text.map((delta) => ({
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id,
        role: "assistant",
        content: [{ type: "output_text", text: reply.text.join("") }],
      },
    },
    completed(index),
  ];
}

export function startMockModel(
  reply: (requestIndex: number, body: unknown) => MockReply,
): MockModel {
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST" || !pathname.endsWith("/responses")) {
        return new Response("not found", { status: 404 });
      }
      const body: unknown = await request.json();
      const index = requests.push(body) - 1;
      const answer = reply(index, body);
      const events = eventsFor(index, answer);
      const delayMs = "text" in answer ? (answer.delayMs ?? 0) : 0;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of events) {
            controller.enqueue(
              encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
            );
            if (delayMs && event.type === "response.output_text.delta") await Bun.sleep(delayMs);
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const url = `http://127.0.0.1:${server.port}/v1`;
  return {
    url,
    requests,
    codexConfig: {
      model: "mock-model",
      model_provider: "mock",
      "model_providers.mock.name": "mock",
      "model_providers.mock.base_url": url,
      "model_providers.mock.wire_api": "responses",
    },
    stop: () => void server.stop(true),
  };
}
