/** A model's answer: text, or a call of `exec_command` with `cmd`, or of another tool (`tool`, an MCP server's). */
export function response(
  call: boolean,
  cmd: string,
  tool?: { name: string; namespace?: string | undefined; args: unknown },
) {
  const item = call
    ? {
        type: "function_call",
        id: "fc_1",
        name: tool?.name ?? "exec_command",
        ...(tool?.namespace ? { namespace: tool.namespace } : {}),
        arguments: JSON.stringify(tool ? tool.args : { cmd, yield_time_ms: 10000 }),
        call_id: `call_${crypto.randomUUID()}`,
      }
    : {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "cycle reply" }],
      };
  const events = [
    { type: "response.created", response: { id: crypto.randomUUID(), status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: call ? { ...item, arguments: "" } : { ...item, content: [] },
    },
    ...(!call
      ? [
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: "cycle reply",
          },
        ]
      : []),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: crypto.randomUUID(),
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 },
      },
    },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}
