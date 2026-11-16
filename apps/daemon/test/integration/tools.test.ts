/**
 * Cycle's own tools, end to end: the real `codex app-server` reaches the daemon's `cycle` MCP
 * server with the key it was given, and one session's agent reads another session through it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import {
  type Daemon,
  TOOLS_KEY_ENV,
  TOOLS_SERVER,
  type OpenProviders,
  type ToolsServer,
  diskFile,
  openProviders,
  Harnesses,
  startDaemon,
  startTools,
} from "../../src/index.ts";
import { type MockModel, type MockReply, startMockModel } from "./mock-model.ts";
import { connect } from "./wire-client.ts";

let daemon: Daemon;
let model: MockModel;
let tools: ToolsServer;
let providers: OpenProviders;
let root: string;
let script: (body: string) => MockReply;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-tools-"));
  mkdirSync(join(root, "project"));
  mkdirSync(join(root, "codex"));
  script = () => ({ text: ["ok"] });
  model = startMockModel((_index, body) => script(JSON.stringify(body)));
  tools = startTools("tools-key");
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  daemon = await startDaemon({
    tools,
    providers: providers.store,
    harness: new Harnesses(
      new CodexHarness({
        config: model.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
        tools: { name: TOOLS_SERVER, url: tools.url, keyEnv: TOOLS_KEY_ENV, key: tools.key },
      }),
      [],
    ),
    home: join(root, "home"),
  });
});

afterAll(async () => {
  await daemon?.stop();
  tools?.stop();
  providers?.stop();
  model?.stop();
  rmSync(root, { recursive: true, force: true });
});

const post = (headers: Record<string, string>) =>
  fetch(tools.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("the server answers only its key, on its own address", async () => {
  expect((await post({})).status).toBe(401);
  expect((await post({ authorization: `Bearer ${daemon.token}` })).status).toBe(401);
  expect((await post({ authorization: "Bearer tools-key", host: "evil.example" })).status).toBe(
    403,
  );
  const answer = await post({ authorization: "Bearer tools-key" });
  expect(answer.status).toBe(200);
  expect(JSON.stringify(await answer.json())).toContain("read_session");
});

test("an agent reads another session, and commands do not get the key", async () => {
  const client = connect(daemon.url);
  await client.opened;
  const cwd = join(root, "project");
  const turns = () => client.events().filter((event) => event.type === "turn.completed").length;

  script = () => ({ text: ["The answer is ", "forty-two."] });
  const first = await client.call("session.create", { cwd, mode: "fullAccess" });
  await client.call("session.open", { sessionId: first.id });
  await client.call("session.send", { sessionId: first.id, text: "PROMPT:what is the answer" });
  await client.until(() => turns() === 1);

  // Codex offers the model the server's tools under a namespace of the server's name.
  const read = { name: "read_session", namespace: `mcp__${TOOLS_SERVER}` };
  script = (body) =>
    body.includes("function_call_output")
      ? { text: ["done"] }
      : { call: { ...read, arguments: { session_id: first.id } } };
  const second = await client.call("session.create", { cwd, mode: "fullAccess" });
  await client.call("session.open", { sessionId: second.id });
  await client.call("session.send", { sessionId: second.id, text: "PROMPT:read the other one" });
  await client.until(() => turns() === 2);
  const outputs = JSON.stringify(model.requests.at(-1));
  expect(outputs).toContain("PROMPT:what is the answer");
  expect(outputs).toContain("The answer is forty-two.");

  // The key is codex's alone: a command the agent runs does not inherit it.
  script = (body) =>
    body.slice(body.lastIndexOf("PROMPT:print")).includes("function_call_output")
      ? { text: ["done"] }
      : { call: { name: "exec_command", arguments: { cmd: "env" } } };
  await client.call("session.send", { sessionId: second.id, text: "PROMPT:print the environment" });
  await client.until(() => turns() === 3);
  const printed = JSON.stringify(model.requests.at(-1));
  expect(printed).toContain("PATH=");
  expect(printed).not.toContain("tools-key");
  expect(printed).not.toContain(TOOLS_KEY_ENV);

  // The owner's Connector does not list Cycle's own server.
  const { servers } = await client.call("mcp.list", {});
  expect(servers.map((server) => server.name)).not.toContain(TOOLS_SERVER);
  client.close();
}, 90_000);
