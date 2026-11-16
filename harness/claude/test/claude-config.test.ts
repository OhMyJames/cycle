import { expect, test } from "bun:test";
import { ClaudeHarness } from "../src/index.ts";
import { type ClaudeConfig, emptyConfig } from "../src/config.ts";
import type { PluginCli } from "../src/plugins.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const SECRET = "value-of-the-key";
const installed = {
  installed: [{ id: "lint@market", version: "1.0.0", installPath: "/cycle/claude/plugins/lint" }],
};

/** A harness with Cycle's configuration in memory, its settings files and plugin command faked. */
function setup(withConfig = true) {
  const sdk = new FakeSdk();
  let config: ClaudeConfig = emptyConfig();
  const settings: string[] = [];
  const cli: PluginCli = {
    run: async (args) => ({
      code: 0,
      stdout: args.join(" ").startsWith("plugin list")
        ? JSON.stringify(installed)
        : args.join(" ") === "plugin marketplace list --json"
          ? "[]"
          : "",
      stderr: "",
    }),
  };
  let ids = 0;
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude", WEB_TOKEN: "t0k" },
    tools: { name: "cycle", url: "http://127.0.0.1:1/mcp", key: "tools-key" },
    schedule: (run, ms) => {
      if (ms < 1000) queueMicrotask(run);
      return () => {};
    },
    newId: () => `id${++ids}`,
    ...(withConfig
      ? {
          config: {
            book: {
              read: () => config,
              write: async (next) => {
                config = next;
              },
            },
            dir: "/cycle/claude",
            writeSettings: async (text) => {
              settings.push(text);
              return `/cycle/claude/settings-${settings.length}.json`;
            },
            cli,
          },
        }
      : {}),
  });
  return { sdk, harness, settings, config: () => config };
}

const auto = { mode: "auto" as const, model: "claude-sonnet-5-5" };
const done = { type: "result", subtype: "success", is_error: false, duration_ms: 1 } as const;

async function turn(harness: ClaudeHarness, sdk: FakeSdk, sessionId: string) {
  await harness.send(sessionId, { text: "hello", images: [] }, auto);
  const query = sdk.queries.at(-1);
  query?.say(done);
  await settle();
  return query;
}

test("a process gets Cycle's configuration by a file's path and over its pipe, never inline", async () => {
  const { sdk, harness, settings } = setup();
  await harness.putMcpServer({
    name: "docs",
    transport: { kind: "stdio", command: "npx", args: ["docs"], env: { API_KEY: SECRET } },
  });
  await harness.enableMcpServer("github", false);
  const session = await harness.createSession({ cwd: "/project", model: auto.model });
  const query = await turn(harness, sdk, session.id);
  const options = query?.options;
  expect(options?.settings).toMatch(/^\/cycle\/claude\/settings-\d+\.json$/);
  // The SDK takes no settings file beside its own sandbox option: the mode's goes into the file.
  expect(options?.sandbox).toBeUndefined();
  const written = JSON.parse(settings.at(-1) ?? "{}");
  expect(written.sandbox).toEqual({
    enabled: true,
    autoAllowBashIfSandboxed: true,
    failIfUnavailable: true,
  });
  expect(written.deniedMcpServers).toEqual([{ serverName: "github" }]);
  expect(options?.plugins).toEqual([{ type: "local", path: "/cycle/claude/plugins/lint" }]);
  expect(options?.pluginDelivery).toBe("initialize");
  // Nothing the SDK puts on the command line holds a value.
  expect(JSON.stringify(options)).not.toContain(SECRET);
  expect(settings.join("")).not.toContain(SECRET);
  expect(Object.keys(query?.servers ?? {})).toEqual(["docs", "cycle"]);
  expect(JSON.stringify(query?.servers)).toContain(SECRET);
});

test("a change reaches a running process over its pipe, without waiting on its turn", async () => {
  const { sdk, harness } = setup();
  const session = await harness.createSession({ cwd: "/project", model: auto.model });
  const query = await turn(harness, sdk, session.id);
  await harness.putMcpServer({
    name: "web",
    transport: { kind: "http", url: "https://web.test/mcp", bearerTokenEnvVar: "WEB_TOKEN" },
  });
  expect(query?.servers?.["web"]).toEqual({
    type: "http",
    url: "https://web.test/mcp",
    headers: { Authorization: "Bearer t0k" },
  });
  expect(query?.flags.at(-1)?.["deniedMcpServers"]).toEqual([]);
  await harness.enablePlugin("fmt@theirs", false);
  await settle();
  expect(query?.flags.at(-1)?.["enabledPlugins"]).toEqual({ "fmt@theirs": false });
  // Loading plugins again waits for a turn: the owner's are read of a process started for it.
  await harness.listPlugins();
  expect(query?.reloads).toBe(0);
  expect(sdk.queries.at(-1)?.reloads).toBe(1);
});

test("two asks of a session at once start one process, whatever the configuration", async () => {
  const { sdk, harness } = setup();
  const session = await harness.createSession({ cwd: "/project", model: auto.model });
  const before = sdk.queries.length;
  await Promise.allSettled([
    harness.send(session.id, { text: "one", images: [] }, auto),
    harness.send(session.id, { text: "two", images: [] }, auto),
  ]);
  const started = sdk.queries
    .slice(before)
    .filter((query) => query.options.sessionId === session.id);
  expect(started).toHaveLength(1);
});

test("a server of the owner's given back starts the process again at its next prompt", async () => {
  const { sdk, harness } = setup();
  await harness.enableMcpServer("github", false);
  const session = await harness.createSession({ cwd: "/project", model: auto.model });
  const first = await turn(harness, sdk, session.id);
  await harness.enableMcpServer("github", true);
  const again = await turn(harness, sdk, session.id);
  expect(again).not.toBe(first);
  expect(first?.closed).toBe(true);
});

test("what only a start takes waits for the next prompt, which starts the process again", async () => {
  const { sdk, harness } = setup();
  const session = await harness.createSession({ cwd: "/project", model: auto.model });
  await turn(harness, sdk, session.id);
  const before = sdk.queries.length;
  await turn(harness, sdk, session.id);
  expect(sdk.queries).toHaveLength(before);
  await harness.enableMcpTool("docs", "search", false);
  const again = await turn(harness, sdk, session.id);
  expect(sdk.queries).toHaveLength(before + 1);
  expect(again?.options.disallowedTools).toEqual(["mcp__docs__search"]);
});

test("without the owner's own settings, the user layer is not read", async () => {
  const { sdk, harness, config } = setup();
  await harness.setHooks({ hooks: [], ownerHooks: true, ownerSettings: false, revision: 0 });
  expect(config().ownerSettings).toBe(false);
  const session = await harness.createSession({ cwd: "/project", model: auto.model });
  const query = await turn(harness, sdk, session.id);
  expect(query?.options.settingSources).toEqual(["project", "local"]);
});

test("with no configuration kept, the Connector only reads and a process starts as before", async () => {
  const { sdk, harness } = setup(false);
  expect(harness.capabilities.connector).toBe("read");
  expect(harness.capabilities.hooks).toBe(false);
  const session = await harness.createSession({ cwd: "/project", model: auto.model });
  const query = await turn(harness, sdk, session.id);
  expect(query?.options.settings).toBeUndefined();
  expect(query?.options.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true });
  expect(query?.options.settingSources).toEqual(["user", "project", "local"]);
  expect(Object.keys(query?.servers ?? {})).toEqual(["cycle"]);
  await expect(harness.enableSkill("x", false)).rejects.toThrow("no configuration");
});
