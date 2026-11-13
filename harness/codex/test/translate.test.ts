import { expect, test } from "bun:test";
import type { McpServerInput } from "@cycle/protocol";
import {
  mcpServerEdits,
  modePolicy,
  toCatalog,
  toItem,
  toMcpServers,
  toTurn,
} from "../src/index.ts";

test.each([
  [
    {
      type: "userMessage",
      id: "u",
      content: [
        { type: "text", text: "hi " },
        { type: "image", url: "data:x" },
      ],
    },
    { id: "u", kind: "userMessage", text: "hi ", images: ["data:x"] },
  ],
  [
    { type: "reasoning", id: "r", summary: ["a", "b"], content: ["raw"] },
    { id: "r", kind: "reasoning", text: "a\n\nb" },
  ],
  [
    {
      type: "commandExecution",
      id: "c",
      command: "cat x",
      cwd: "/p",
      status: "completed",
      commandActions: [{ type: "read", command: "cat x", name: "x", path: "/p/x" }],
      aggregatedOutput: "body",
      exitCode: 0,
      durationMs: 12,
    },
    {
      id: "c",
      kind: "command",
      command: "cat x",
      cwd: "/p",
      output: "body",
      exitCode: 0,
      durationMs: 12,
      actions: [{ type: "read", path: "/p/x" }],
      status: "completed",
    },
  ],
  [
    {
      type: "fileChange",
      id: "f",
      status: "inProgress",
      changes: [{ path: "a.ts", kind: { type: "update", move_path: "b.ts" }, diff: "@@" }],
    },
    {
      id: "f",
      kind: "fileChange",
      status: "running",
      changes: [{ path: "a.ts", change: "update", movePath: "b.ts", diff: "@@" }],
    },
  ],
  [
    {
      type: "mcpToolCall",
      id: "m",
      server: "docs",
      tool: "search",
      status: "failed",
      arguments: { q: "x" },
      result: null,
      error: { message: "nope" },
      durationMs: null,
    },
    {
      id: "m",
      kind: "toolCall",
      server: "docs",
      tool: "search",
      args: '{\n  "q": "x"\n}',
      result: null,
      error: "nope",
      durationMs: null,
      status: "failed",
    },
  ],
  [
    { type: "somethingNew", id: "n" },
    { id: "n", kind: "other", type: "somethingNew" },
  ],
])("an item is translated: %#", (raw, expected) => {
  expect(toItem(raw as Parameters<typeof toItem>[0])).toEqual(
    expected as ReturnType<typeof toItem>,
  );
});

test("a turn keeps its timing in milliseconds", () => {
  const turn = toTurn({
    id: "t",
    items: [],
    status: "inProgress",
    error: null,
    startedAt: 10,
    durationMs: null,
  });
  expect(turn).toMatchObject({ status: "running", startedAt: 10_000 });
});

test("only full access goes without asking or a sandbox", () => {
  expect(modePolicy("readOnly")).toMatchObject({
    approvalPolicy: "on-request",
    sandbox: "read-only",
  });
  expect(modePolicy("auto")).toMatchObject({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  expect(modePolicy("fullAccess")).toMatchObject({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
});

test("servers are the configured ones and what each reports, by name", () => {
  const servers = toMcpServers(
    {
      web: { url: "https://mcp.example.com/v1", bearer_token_env_var: "WEB_TOKEN" },
      local: { command: "npx", args: ["-y", "pkg"], env: { B: "2", A: "1" } },
      off: { command: "x", enabled: false },
    },
    [
      {
        name: "local",
        runtimeStatus: null,
        serverInfo: { name: "local" },
        tools: { echo: { description: "Echoes" } },
        toolsError: null,
        authStatus: "unsupported",
      },
      { name: "web", runtimeStatus: null, tools: {}, toolsError: null, authStatus: "notLoggedIn" },
      { name: "off", runtimeStatus: null, tools: {}, toolsError: null, authStatus: "unsupported" },
      {
        name: "brought",
        runtimeStatus: null,
        pluginId: "p@m",
        tools: {},
        toolsError: "it would not start",
        authStatus: "oAuth",
      },
    ],
  );
  expect(servers.map((server) => [server.name, server.status, server.auth])).toEqual([
    ["brought", "failed", "signedIn"],
    ["local", "connected", "none"],
    ["off", "disabled", "none"],
    ["web", "needsAuth", "signedOut"],
  ]);
  // A variable's value never leaves the harness: only its name does.
  expect(servers[1]?.transport).toEqual({
    kind: "stdio",
    command: "npx",
    args: ["-y", "pkg"],
    env: ["A", "B"],
  });
  expect(servers[0]).toMatchObject({ transport: null, pluginId: "p@m" });
  expect(servers[3]?.transport).toEqual({
    kind: "http",
    url: "https://mcp.example.com/v1",
    bearerTokenEnvVar: "WEB_TOKEN",
  });
});

test("an edit writes only what Cycle shows and keeps a value it was not given", () => {
  const edits = mcpServerEdits(
    {
      name: "local",
      transport: { kind: "stdio", command: " npx ", args: ["pkg"], env: { KEY: null, NEW: "v" } },
    },
    { command: "old", env: { KEY: "secret", GONE: "x" } },
  );
  expect(Object.fromEntries(edits.map((edit) => [edit.keyPath, edit.value]))).toEqual({
    "mcp_servers.local.command": "npx",
    "mcp_servers.local.args": ["pkg"],
    "mcp_servers.local.env": { KEY: "secret", NEW: "v" },
    "mcp_servers.local.url": null,
    "mcp_servers.local.bearer_token_env_var": null,
  });
  const http = mcpServerEdits(
    { name: "web", transport: { kind: "http", url: "https://x.dev/mcp", bearerTokenEnvVar: "" } },
    undefined,
  );
  expect(http.find((edit) => edit.keyPath.endsWith(".command"))?.value).toBeNull();
  expect(http.find((edit) => edit.keyPath.endsWith(".bearer_token_env_var"))?.value).toBeNull();
});

test.each<[string, McpServerInput, string]>([
  [
    "a name with a dot",
    { name: "a.b", transport: { kind: "http", url: "https://x", bearerTokenEnvVar: null } },
    "name is letters",
  ],
  [
    "no command",
    { name: "a", transport: { kind: "stdio", command: " ", args: [], env: {} } },
    "command is needed",
  ],
  [
    "a file URL",
    { name: "a", transport: { kind: "http", url: "file:///etc", bearerTokenEnvVar: null } },
    "http or https",
  ],
  [
    "a bad variable",
    { name: "a", transport: { kind: "stdio", command: "x", args: [], env: { "A B": "1" } } },
    "not a variable name",
  ],
  [
    "a variable with no value",
    { name: "a", transport: { kind: "stdio", command: "x", args: [], env: { A: null } } },
    "A has no value",
  ],
  [
    "arguments that are not words",
    {
      name: "a",
      transport: { kind: "stdio", command: "x", args: "y", env: {} },
    } as unknown as McpServerInput,
    "list of words",
  ],
  [
    "a value that is not text",
    {
      name: "a",
      transport: { kind: "stdio", command: "x", args: [], env: { A: 1 } },
    } as unknown as McpServerInput,
    "A has no value",
  ],
  [
    "a variable every object has",
    { name: "a", transport: { kind: "stdio", command: "x", args: [], env: { constructor: null } } },
    "constructor has no value",
  ],
  [
    "no way to reach it",
    { name: "a", transport: { kind: "pipe" } } as unknown as McpServerInput,
    "a command or an address",
  ],
])("a server with %s is refused", (_name, input, message) => {
  expect(() => mcpServerEdits(input, undefined)).toThrow(message);
});

test("a catalog names each plugin and says why one cannot be installed", () => {
  const plugin = {
    id: "hello@demo",
    name: "hello",
    version: null,
    localVersion: "1.0.0",
    installed: true,
    enabled: false,
    availability: "AVAILABLE",
    installPolicy: "AVAILABLE",
    disabledReason: null,
    interface: null,
  };
  const catalog = toCatalog({
    marketplaces: [
      {
        name: "demo",
        path: "/m/marketplace.json",
        interface: { displayName: "Demo" },
        plugins: [
          plugin,
          {
            ...plugin,
            id: "x@demo",
            availability: "DISABLED_BY_ADMIN",
            disabledReason: "disabled_by_admin",
          },
        ],
      },
    ],
    marketplaceLoadErrors: [{ marketplacePath: "/bad", message: "not JSON" }],
  });
  expect(catalog.marketplaces[0]).toMatchObject({ displayName: "Demo" });
  expect(catalog.marketplaces[0]?.plugins).toMatchObject([
    { displayName: "hello", version: "1.0.0", installed: true, enabled: false, available: true },
    { available: false, unavailable: "Turned off by your organization." },
  ]);
  expect(catalog.errors).toEqual(["/bad: not JSON"]);
});
