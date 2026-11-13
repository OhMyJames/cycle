/** A minimal MCP server over stdio with one tool, for the connector's tests and the demo. */
interface McpRequest {
  id?: number;
  method: string;
  params?: { protocolVersion?: string };
}

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

function answer(request: McpRequest): void {
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "demo", version: "1.0.0" },
      },
    });
  } else if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "echo",
            description: `Echoes its input${process.env["DEMO_SUFFIX"] ?? ""}`,
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
        ],
      },
    });
  } else {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  }
}

async function serve(): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk);
    let end = buffered.indexOf("\n");
    while (end !== -1) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf("\n");
      if (line) answer(JSON.parse(line) as McpRequest);
    }
  }
}

void serve();
