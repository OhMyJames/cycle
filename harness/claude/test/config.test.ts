import { expect, test } from "bun:test";
import type { McpServerInfo } from "@cycle/protocol";
import {
  ConfigError,
  disallowedTools,
  emptyConfig,
  enableServer,
  enableTool,
  flagSettings,
  ownServers,
  putServer,
  readConfig,
  removeServer,
  setHooks,
  shownServers,
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
  expect(() => putServer(emptyConfig(), stdio({}), ["docs"])).toThrow("already has");
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
  expect(removeServer(config, "docs").toolsOff).toEqual(["mcp__other__read"]);
});

test("the flag layer says what is on as plainly as what is off, since a running one merges it", () => {
  let config = enableServer(emptyConfig(), "github", false);
  config = { ...config, ownerHooks: false, plugins: { "a@m": false }, skillsOff: ["review"] };
  config = setHooks(
    config,
    {
      hooks: [
        { id: "", event: "PreToolUse", matcher: "Bash", command: " echo hi ", timeout: 5 },
        { id: "h2", event: "PreToolUse", matcher: "", command: "true", timeout: null },
      ],
      ownerHooks: false,
      ownerSettings: true,
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
      { hooks: [{ ...hook, ...patch }], ownerHooks: true, ownerSettings: true },
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
