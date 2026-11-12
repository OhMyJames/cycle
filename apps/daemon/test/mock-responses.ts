/**
 * A stand-in for the OpenAI Responses API, so the whole stack
 * (codex app-server -> harness -> daemon -> client) can be exercised
 * end-to-end without credentials or network access.
 */
export interface MockModel {
  url: string;
  /** Request bodies codex sent to POST /v1/responses. */
  requests: unknown[];
  /** `-c` overrides that point codex at this server. */
  codexConfig: Record<string, string | number | boolean>;
  stop(): void;
}

export function startMockModel(reply: (requestIndex: number) => string[]): MockModel {
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST" || !pathname.endsWith("/responses")) {
        return new Response("not found", { status: 404 });
      }
      const index = requests.push(await request.json()) - 1;
      const chunks = reply(index);
      const id = `msg_${index}`;
      const events: Record<string, unknown>[] = [
        { type: "response.created", response: { id: `resp_${index}` } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id, role: "assistant", content: [] },
        },
        ...chunks.map((delta) => ({
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
            content: [{ type: "output_text", text: chunks.join("") }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: `resp_${index}`,
            usage: {
              input_tokens: 1,
              input_tokens_details: null,
              output_tokens: 1,
              output_tokens_details: null,
              total_tokens: 2,
            },
          },
        },
      ];
      const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
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
