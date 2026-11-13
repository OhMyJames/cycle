import { expect, test } from "bun:test";
import type { McpServerInfo } from "@cycle/protocol";
import {
  serverDraft,
  serverInput,
  serverProblem,
  splitCommand,
  statusLabel,
  transportLabel,
} from "../src/lib/server-form.ts";

const server = (patch: Partial<McpServerInfo>): McpServerInfo => ({
  name: "docs",
  enabled: true,
  transport: { kind: "stdio", command: "npx", args: ["-y", "my server"], env: ["API_KEY"] },
  pluginId: null,
  status: "connected",
  auth: "none",
  tools: [],
  error: null,
  ...patch,
});

test("a command line splits as a shell would", () => {
  expect(splitCommand(`npx -y "my server" 'it''s' a\\ b ""`)).toEqual([
    "npx",
    "-y",
    "my server",
    "its",
    "a b",
    "",
  ]);
  expect(splitCommand("   ")).toEqual([]);
});

test("a stored value the page never saw is kept unless typed over", () => {
  const draft = serverDraft(server({}));
  expect(draft.command).toBe("npx -y 'my server'");
  expect(draft.env).toEqual([{ name: "API_KEY", value: "", kept: true }]);
  expect(serverInput(draft).transport).toEqual({
    kind: "stdio",
    command: "npx",
    args: ["-y", "my server"],
    env: { API_KEY: null },
  });
  const typed = {
    ...draft,
    env: [
      { name: "API_KEY", value: "new", kept: true },
      { name: "EMPTY", value: "", kept: false },
      { name: " ", value: "dropped", kept: false },
    ],
  };
  expect(serverInput(typed).transport).toMatchObject({ env: { API_KEY: "new", EMPTY: "" } });
});

test("an address is saved with its token variable, or none", () => {
  const draft = { ...serverDraft(null), name: " web ", kind: "http" as const };
  expect(serverProblem(draft, [])).toBe("Give its http or https address");
  const filled = { ...draft, url: " https://mcp.example.com/mcp " };
  expect(serverProblem(filled, [])).toBeNull();
  expect(serverInput(filled)).toEqual({
    name: "web",
    transport: { kind: "http", url: "https://mcp.example.com/mcp", bearerTokenEnvVar: null },
  });
  expect(serverProblem({ ...filled, bearerTokenEnvVar: "MY TOKEN" }, [])).not.toBeNull();
});

test.each([
  [{ name: "" }, "Name it"],
  [{ name: "has space" }, "Use letters, digits, - and _ in the name"],
  [{ name: "taken" }, "Another server has that name"],
  [{ name: "ok", command: " " }, "Say what command starts it"],
  [
    { name: "ok", command: "run", env: [{ name: "A=B", value: "", kept: false }] },
    "A variable's name has no spaces or =",
  ],
  [
    {
      name: "ok",
      command: "run",
      env: [
        { name: "A", value: "1", kept: false },
        { name: "A", value: "2", kept: false },
      ],
    },
    "A variable is set twice",
  ],
  [{ name: "ok", command: "run" }, null],
])("the form says what it lacks: %o", (patch, problem) => {
  expect(serverProblem({ ...serverDraft(null), ...patch }, ["taken"])).toBe(problem);
});

test("a row says what its server is doing and how it is reached", () => {
  const tools = [{ name: "search", description: "" }];
  expect(statusLabel(server({ tools }))).toBe("1 tool");
  expect(statusLabel(server({ status: "unknown" }))).toBe("Not started yet");
  expect(statusLabel(server({ status: "failed" }))).toBe("Failed to start");
  expect(statusLabel(server({ auth: "signedOut" }))).toBe("Needs sign-in");
  expect(statusLabel(server({ enabled: false, tools }))).toBe("Off");
  expect(transportLabel(server({}))).toBe("npx -y 'my server'");
  expect(transportLabel(server({ transport: null, pluginId: "kit@team" }))).toBe("From kit@team");
});
