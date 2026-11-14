/**
 * A stand-in for the Anthropic Messages API, so the whole stack
 * (Claude Code -> Claude Agent SDK -> harness -> daemon -> client) can be
 * exercised end-to-end without an account or network access.
 */
import { join } from "node:path";

export type ClaudeReply =
  /** The model answers in text, streamed chunk by chunk. */
  | { text: string[]; delayMs?: number }
  /** The model calls a tool. Claude Code runs it and asks again. */
  | { call: { name: string; input: Record<string, unknown> } };

export interface MockClaude {
  url: string;
  /** Request bodies Claude Code sent to POST /v1/messages. */
  requests: unknown[];
  /** What points Claude Code at this server, and at a home of its own under `root`. */
  env: Record<string, string>;
  stop(): void;
}

interface Block {
  type: string;
  text?: string;
}

interface Body {
  model?: string;
  stream?: boolean;
  tools?: unknown[];
  messages?: { role: string; content: string | Block[] }[];
}

/** The latest prompt of the owner's, and how many tool results have come back since it. */
function progress(body: Body): { prompt: string; results: number } {
  let prompt = "";
  let results = 0;
  for (const message of body.messages ?? []) {
    if (message.role !== "user") continue;
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    for (const block of blocks) {
      if (block.type === "tool_result") results++;
      // What Claude Code adds for itself is in tags; a prompt is not.
      else if (block.type === "text" && block.text && !block.text.trimStart().startsWith("<")) {
        prompt = block.text;
        results = 0;
      }
    }
  }
  return { prompt, results };
}

type SseEvent = Record<string, unknown> & { type: string };

function eventsFor(index: number, model: string, reply: ClaudeReply): SseEvent[] {
  const usage = { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 };
  const events: SseEvent[] = [
    {
      type: "message_start",
      message: {
        id: `msg_${index}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    },
  ];
  if ("call" in reply) {
    const block = { type: "tool_use", id: `toolu_${index}`, name: reply.call.name, input: {} };
    const delta = { type: "input_json_delta", partial_json: JSON.stringify(reply.call.input) };
    events.push(
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_delta", index: 0, delta },
    );
  } else {
    events.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    for (const text of reply.text) {
      events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    }
  }
  events.push(
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "call" in reply ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 30 },
    },
    { type: "message_stop" },
  );
  return events;
}

/**
 * `root` is a folder of the caller's: Claude Code's home is made under it,
 * never the owner's real one. The SDK reads stored sessions in this process,
 * so this process is pointed at the same home.
 */
export function startMockClaude(
  root: string,
  reply: (prompt: string, results: number, body: unknown) => ClaudeReply,
): MockClaude {
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST" || !pathname.endsWith("/messages")) {
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: pathname } },
          { status: 404 },
        );
      }
      const body = (await request.json()) as Body;
      const index = requests.push(body) - 1;
      const { prompt, results } = progress(body);
      // A request with no tools is one Claude Code makes for itself, as to name a session.
      const answer: ClaudeReply = body.tools?.length
        ? reply(prompt, results, body)
        : { text: ["ok"] };
      const model = body.model ?? "mock";
      if (!body.stream) {
        return Response.json({
          id: `msg_${index}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "text" in answer ? answer.text.join("") : "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 30 },
        });
      }
      const delayMs = "text" in answer ? (answer.delayMs ?? 0) : 0;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of eventsFor(index, model, answer)) {
            controller.enqueue(
              encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
            );
            if (delayMs && event.type === "content_block_delta") await Bun.sleep(delayMs);
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const home = join(root, "claude");
  process.env["CLAUDE_CONFIG_DIR"] = home;
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    requests,
    env: {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "sk-ant-mock",
      CLAUDE_CONFIG_DIR: home,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    stop: () => void server.stop(true),
  };
}
