import { afterEach, expect, test } from "bun:test";
import { McpGateway } from "../src/connectors/gateway.ts";

const gateways: McpGateway[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

/** A gateway whose one connector, `c 1`, answers with what it was asked for. */
const start = () => {
  const gateway = McpGateway.start(async (sessionId, connectorId) =>
    Response.json({ sessionId, connectorId }),
  );
  gateways.push(gateway);
  const key = gateway.grant("s1", ["c 1"]);
  const ask = (path: string) =>
    fetch(`http://127.0.0.1:${gateway.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
  return { gateway, ask };
};

test("a connector is reached at its escaped name", async () => {
  const { gateway, ask } = start();
  const response = await ask(new URL(gateway.endpoint("c 1")).pathname);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sessionId: "s1", connectorId: "c 1" });
});

test("a path whose escapes are not ones names no connector", async () => {
  const { ask } = start();
  for (const path of ["/mcp/%E0", "/mcp/%", "/mcp/%zz"]) {
    const response = await ask(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  }
});
