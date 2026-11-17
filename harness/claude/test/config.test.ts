import { expect, test } from "bun:test";
import type { McpServerInfo } from "@cycle/protocol";
import {
  type ClaudeConfig,
  ConfigError,
  disallowedTools,
  emptyConfig,
  enablePlugin,
  enableServer,
  enableTool,
  flagSettings,
  ownServers,
  putServer,
  readConfig,
  removeServer,
  setHooks,
  shownServers,
  startKey,
} from "../src/config.ts";

const stdio = (env: Record<string, string | null>) => ({
  name: "docs",
  transport: { kind: "stdio" as const, command: "npx", args: ["docs"], env },
});

test("a file that is not there, or kept before a key existed, reads as empty", () => {
  expect(readConfig(undefined)).toEqual(emptyConfig());
  expect(readConfig({ skillsOff: ["x"] })).toEqual({ ...emptyConfig(), skillsOff: ["x"] });
});

test("a server's environment value is kept when the page sends its name alone", () => {
  const first = putServer(emptyConfig(), stdio({ API_KEY: "secret" }), []);
  const again = putServer(first, stdio({ API_KEY: null, MORE: "two" }), []);
  expect(again.mcpServers["docs"]?.transport).toEqual({
    kind: "stdio",
    command: "npx",
    args: ["docs"],
    env: { API_KEY: "secret", MORE: "two" },
  });
  expect(() => putServer(emptyConfig(), stdio({ NEW: null }), [])).toThrow(ConfigError);
});

test("a server is not given a name one of the owner's has: the owner's switch goes by name", () => {
  expect(() => putServer(emptyConfig(), stdio({}), ["docs"])).toThrow("already a server");
  expect(() =>
    putServer(emptyConfig(), { name: "../x", transport: stdio({}).transport }, []),
  ).toThrow(ConfigError);
});

test("the owner's servers are turned off by name, never removed", () => {
  const off = enableServer(emptyConfig(), "github", false);
  expect(off.ownerServersOff).toEqual(["github"]);
  expect(enableServer(off, "github", true).ownerServersOff).toEqual([]);
  expect(() => removeServer(off, "github")).toThrow("Claude Code's own");
  expect(() => enableServer(off, "plugin:x:y", false)).toThrow("its plugin");
});

test("removing one of Cycle's servers forgets its tools turned off", () => {
  let config = putServer(emptyConfig(), stdio({}), []);
  config = enableTool(config, "docs", "search", false);
  config = enableTool(config, "other", "read", false);
  expect(removeServer(config, "docs").toolsOff).toEqual([{ server: "other", tool: "read" }]);
});

test("the flag layer says what is on as plainly as what is off, since a running one merges it", () => {
  let config = enableServer(emptyConfig(), "github", false);
  config = {
    ...config,
    run: { fallbackModel: null, maxTurns: null, maxBudgetUsd: null },
    ownerHooks: false,
    plugins: { "a@m": false },
    skillsOff: ["review"],
  };
  config = setHooks(
    config,
    {
      hooks: [
        { id: "", event: "PreToolUse", matcher: "Bash", command: " echo hi ", timeout: 5 },
        { id: "h2", event: "PreToolUse", matcher: "", command: "true", timeout: null },
      ],
      run: { fallbackModel: null, maxTurns: null, maxBudgetUsd: null },
      ownerHooks: false,
      ownerSettings: true,
      revision: 0,
    },
    () => "new",
  );
  expect(flagSettings(config, { enabled: true, autoAllowBashIfSandboxed: true })).toEqual({
    disableAllHooks: true,
    deniedMcpServers: [{ serverName: "github" }],
    enabledPlugins: { "a@m": false },
    skillOverrides: { review: "off" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo hi", timeout: 5 }] },
        { hooks: [{ type: "command", command: "true" }] },
      ],
    },
    // As the SDK merges its own `sandbox` option.
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: true },
  });
  expect(config.hooks.map((hook) => hook.id)).toEqual(["new", "h2"]);
  expect(flagSettings(emptyConfig())["disableAllHooks"]).toBe(false);
  expect(disallowedTools(config)).toEqual(["Skill(review)"]);
});

test("a hook is refused on an event Claude Code has none of, or with no command", () => {
  const hook = { id: "", event: "PreToolUse", matcher: "", command: "true", timeout: null };
  const set = (patch: object) =>
    setHooks(
      emptyConfig(),
      {
        hooks: [{ ...hook, ...patch }],
        run: { fallbackModel: null, maxTurns: null, maxBudgetUsd: null },
        ownerHooks: true,
        ownerSettings: true,
        revision: 0,
      },
      () => "id",
    );
  expect(() => set({ event: "Whenever" })).toThrow(ConfigError);
  expect(() => set({ command: "  " })).toThrow(ConfigError);
  expect(() => set({ timeout: 0 })).toThrow(ConfigError);
});

test("servers go to a process on, with an http token read from the daemon's environment", () => {
  let config = putServer(emptyConfig(), stdio({ API_KEY: "secret" }), []);
  config = putServer(
    config,
    {
      name: "web",
      transport: { kind: "http", url: "https://x.test/mcp", bearerTokenEnvVar: "TOKEN" },
    },
    [],
  );
  config = putServer(config, { ...stdio({}), name: "quiet" }, []);
  config = enableServer(config, "quiet", false);
  expect(ownServers(config, { TOKEN: "t0k" })).toEqual({
    docs: { type: "stdio", command: "npx", args: ["docs"], env: { API_KEY: "secret" } },
    web: { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer t0k" } },
  });
});

test("the page sees Cycle's servers by their variables' names, and what is off is still listed", () => {
  let config = putServer(emptyConfig(), stdio({ API_KEY: "secret" }), []);
  config = putServer(config, { ...stdio({}), name: "quiet" }, []);
  config = enableServer(config, "quiet", false);
  config = enableServer(config, "github", false);
  config = enableTool(config, "docs", "search", false);
  const listed: McpServerInfo = {
    name: "docs",
    enabled: true,
    origin: "owner",
    transport: null,
    pluginId: null,
    status: "connected",
    auth: "none",
    tools: [{ name: "search", description: "", enabled: true, tokens: null }],
    error: null,
  };
  const shown = shownServers(config, [listed, { ...listed, name: "plugin:p:s", tools: [] }]);
  expect(shown.map((server) => [server.name, server.origin, server.enabled])).toEqual([
    ["docs", "config", true],
    ["github", "owner", false],
    ["plugin:p:s", "plugin", true],
    ["quiet", "config", false],
  ]);
  expect(shown[0]?.transport).toEqual({
    kind: "stdio",
    command: "npx",
    args: ["docs"],
    env: ["API_KEY"],
  });
  expect(shown[0]?.tools[0]?.enabled).toBe(false);
  expect(JSON.stringify(shown)).not.toContain("secret");
});

test("removing a server forgets its own tools only, not those of one whose name begins the same", () => {
  let config = putServer(emptyConfig(), { ...stdio({}), name: "a" }, []);
  config = enableTool(config, "a", "x", false);
  config = enableTool(config, "a_", "x", false);
  config = enableTool(config, "a", "_x", false);
  expect(removeServer(config, "a").toolsOff).toEqual([{ server: "a_", tool: "x" }]);
  expect(disallowedTools(config)).toContain("mcp__a___x");
});

test("a name the owner turned off, or Cycle's tools have, is not given to a server of Cycle's", () => {
  const off = enableServer(emptyConfig(), "github", false);
  expect(() => putServer(off, { ...stdio({}), name: "github" }, [])).toThrow("already a server");
  expect(() => putServer(emptyConfig(), { ...stdio({}), name: "cycle" }, ["cycle"])).toThrow(
    "already a server",
  );
});

test("hooks read before another change are refused, not written over it", () => {
  const settings = {
    hooks: [],
    run: { fallbackModel: null, maxTurns: null, maxBudgetUsd: null },
    ownerHooks: false,
    ownerSettings: true,
    revision: 0,
  };
  const once = setHooks(emptyConfig(), settings, () => "id");
  expect(once.hooksRevision).toBe(1);
  expect(() => setHooks(once, settings, () => "id")).toThrow("changed elsewhere");
  expect(setHooks(once, { ...settings, revision: 1 }, () => "id").hooksRevision).toBe(2);
});

const key = (config: ClaudeConfig) => startKey(config, []);

test("a server or a plugin given back needs a new start: a running process does not take it back", () => {
  const off = enableServer(emptyConfig(), "github", false);
  expect(key(off)).not.toBe(key(emptyConfig()));
  expect(key(enablePlugin(emptyConfig(), "p@m", false))).not.toBe(key(emptyConfig()));
  // The owner's hooks switch reaches a running process both ways.
  expect(
    key({
      ...emptyConfig(),
      run: { fallbackModel: null, maxTurns: null, maxBudgetUsd: null },
      ownerHooks: false,
    }),
  ).toBe(key(emptyConfig()));
});
