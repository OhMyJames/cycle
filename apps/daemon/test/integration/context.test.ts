import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import {
  type Daemon,
  type OpenProviders,
  diskFile,
  openProviders,
  startDaemon,
} from "../../src/index.ts";
import { type MockModel, type MockReply, startMockModel } from "./mock-model.ts";
import { connect, type WireClient } from "./wire-client.ts";

// What goes into a request: the owner's MCP tools wait behind a search on their providers'
// models, and a tool or subagents turned off are left out of it.

let model: MockModel;
let daemon: Daemon;
let root: string;
let project: string;
let providers: OpenProviders;
let script: (body: string) => MockReply = () => ({ text: ["Done"] });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-context-"));
  project = join(root, "project");
  mkdirSync(join(root, "codex"));
  mkdirSync(project);
  model = startMockModel((_index, body) => script(JSON.stringify(body)));
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  daemon = await startDaemon({
    harness: new CodexHarness({
      config: model.codexConfig,
      env: { CODEX_HOME: join(root, "codex") },
      provider: providers.provider,
    }),
    providers: providers.store,
    home: join(root, "home"),
  });
});

afterAll(async () => {
  await daemon?.stop();
  providers?.stop();
  model?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** The names of the tools a request to the model offered, namespaces flattened as pi-ai's are. */
function toolNames(request: unknown): string[] {
  const tools = (request as { tools?: { name?: string; type: string; tools?: unknown[] }[] }).tools;
  return (tools ?? []).flatMap((tool) =>
    tool.type === "namespace"
      ? (tool.tools as { name: string }[]).map((inner) => `${tool.name}__${inner.name}`)
      : [tool.name ?? tool.type],
  );
}

async function turn(client: WireClient, modelId: string | undefined, text: string) {
  const session = await client.call("session.create", {
    cwd: project,
    mode: "fullAccess",
    ...(modelId ? { model: modelId } : {}),
  });
  await client.call("session.open", { sessionId: session.id });
  const done = () =>
    client
      .events()
      .some((event) => event.type === "turn.completed" && event.sessionId === session.id);
  await client.call("session.send", { sessionId: session.id, text });
  await client.until(done);
  return client
    .events()
    .flatMap((event) =>
      event.type === "item.completed" && event.sessionId === session.id ? [event.item] : [],
    );
}

test("a provider's model finds an MCP tool by searching for it, and calls it", async () => {
  const client = connect(daemon.url);
  await client.opened;
  await client.call("mcp.put", {
    server: {
      name: "demo",
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [join(import.meta.dir, "mcp-server.ts")],
        env: {},
      },
    },
  });
  await client.call("providers.save", {
    name: "My endpoint",
    kind: "custom",
    api: "openai-responses",
    baseUrl: model.url,
    apiKey: "secret-key",
    models: [
      {
        id: "mock-model",
        name: "Mock",
        reasoning: false,
        images: false,
        contextWindow: 64_000,
        maxTokens: 4_000,
      },
    ],
  });
  await client.until(() => client.pushes.some((push) => push.type === "models.changed"));

  const steps: MockReply[] = [
    { call: { name: "tool_search", arguments: { query: "echo" } } },
    { call: { name: "mcp__demo__echo", arguments: { text: "hi" } } },
    { text: ["Echoed"] },
  ];
  script = () => steps.shift() ?? { text: ["Done"] };
  const before = model.requests.length;
  const items = await turn(client, "my-endpoint/mock-model", "PROMPT:echo hi");
  const asked = model.requests.slice(before);
  // The server's tool waits behind the search, and joins the tools once found.
  expect(toolNames(asked[0])).toContain("tool_search");
  expect(toolNames(asked[0])).not.toContain("mcp__demo__echo");
  expect(toolNames(asked[1])).toContain("mcp__demo__echo");
  expect(items).toContainEqual(
    expect.objectContaining({ kind: "toolCall", server: "demo", tool: "echo" }),
  );
  expect(items.at(-1)).toMatchObject({ kind: "agentMessage", text: "Echoed" });
  client.close();
}, 90_000);

test("a tool and subagents turned off leave every request, in both of codex's processes", async () => {
  const client = connect(daemon.url);
  await client.opened;
  script = () => ({ text: ["Done"] });
  // Codex's own model, which it does not know, gets every tool whole.
  let before = model.requests.length;
  await turn(client, undefined, "PROMPT:before");
  const whole = toolNames(model.requests[before]);
  expect(whole).toContain("mcp__demo__echo");
  expect(whole.some((name) => name.startsWith("multi_agent"))).toBe(true);

  const off = await client.call("mcp.enableTool", { name: "demo", tool: "echo", enabled: false });
  expect(off.servers[0]?.tools).toEqual([
    { name: "echo", description: "", enabled: false, tokens: null },
  ]);
  expect(await client.call("features.read", {})).toEqual({ subagents: true });
  expect(await client.call("features.set", { subagents: false })).toEqual({ subagents: false });
  expect(client.pushes).toContainEqual({
    type: "features.changed",
    features: { subagents: false },
  });
  const config = readFileSync(join(root, "codex", "config.toml"), "utf8");
  expect(config).toContain('disabled_tools = ["echo"]');
  expect(config).toContain("multi_agent = false");

  for (const id of [undefined, "my-endpoint/mock-model"]) {
    before = model.requests.length;
    await turn(client, id, "PROMPT:after");
    const names = toolNames(model.requests[before]);
    expect(names.some((name) => name.includes("echo") || name.includes("multi_agent"))).toBe(false);
  }

  // Back on, nothing of Cycle's is left in the owner's configuration.
  await client.call("mcp.enableTool", { name: "demo", tool: "echo", enabled: true });
  await client.call("features.set", { subagents: true });
  const after = readFileSync(join(root, "codex", "config.toml"), "utf8");
  expect(after).not.toContain("disabled_tools");
  expect(after).not.toContain("multi_agent");
  client.close();
}, 90_000);
