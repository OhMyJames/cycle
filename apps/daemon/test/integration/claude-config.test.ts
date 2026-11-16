/**
 * Cycle's own configuration of Claude Code, end to end: the real Claude Code, driven by the SDK
 * against a scripted model, with a Claude Code home of the test's own that holds the owner's hook
 * and MCP server. Nothing is written to that home's settings by Cycle.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaudeConfig, ClaudeHarness, emptyConfig } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Item, SessionEvent } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  JsonStore,
  type OpenProviders,
  TOOLS_KEY_ENV,
  TOOLS_SERVER,
  type ToolsServer,
  claudeConfigBook,
  diskFile,
  openProviders,
  startDaemon,
  startTools,
} from "../../src/index.ts";
import { type ClaudeReply, type MockClaude, startMockClaude } from "./mock-claude.ts";
import { type MockModel, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

const SONNET = "claude-sonnet-5-5";
const SECRET = "cycle-config-secret-value";
const CLAUDE = { harness: "claude" };
const mcpServer = join(import.meta.dir, "mcp-server.ts");

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let tools: ToolsServer;
let providers: OpenProviders;
let root: string;
let project: string;
let hookLog: string;
let ownerFiles: () => string;
let client: WireClient;
let script: (prompt: string, results: number) => ClaudeReply;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-claude-config-"));
  project = join(root, "project");
  hookLog = join(root, "hooks.log");
  mkdirSync(project);
  mkdirSync(join(root, "codex"));
  script = () => ({ text: ["ok"] });
  codexModel = startMockModel(() => ({ text: ["Hello", " from codex"] }));
  claude = startMockClaude(root, (prompt, results) => script(prompt, results));
  // The owner's own Claude Code: a hook and an MCP server, in the test's home.
  const home = claude.env["CLAUDE_CONFIG_DIR"] ?? "";
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo owner >> ${hookLog}` }] }],
      },
    }),
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { "owner-mcp": { type: "stdio", command: process.execPath, args: [mcpServer] } },
    }),
  );
  ownerFiles = () =>
    readFileSync(join(home, "settings.json"), "utf8") +
    JSON.stringify(
      (JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { projects?: unknown })
        .projects ?? null,
    );
  tools = startTools("claude-config-tools-key");
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  const store = await JsonStore.open<ClaudeConfig>(
    diskFile(join(root, "home", "claude.json")),
    emptyConfig(),
  );
  daemon = await startDaemon({
    tools,
    providers: providers.store,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
        tools: { name: TOOLS_SERVER, url: tools.url, keyEnv: TOOLS_KEY_ENV, key: tools.key },
      }),
      [
        new ClaudeHarness({
          env: claude.env,
          tools: { name: TOOLS_SERVER, url: tools.url, key: tools.key },
          config: { book: claudeConfigBook(store), dir: join(root, "home", "claude") },
          ...(process.env["CYCLE_DEBUG"]
            ? { onLog: (line: string) => console.error(`[claude] ${line}`) }
            : {}),
        }),
      ],
    ),
    home: join(root, "home"),
  });
  client = connect(daemon.url);
  await client.opened;
});

afterAll(async () => {
  client?.close();
  await daemon?.stop();
  tools?.stop();
  providers?.stop();
  codexModel?.stop();
  claude?.stop();
  rmSync(root, { recursive: true, force: true });
});

const of = (sessionId: string) => client.events().filter((event) => event.sessionId === sessionId);
const items = (events: SessionEvent[]): Item[] =>
  events.flatMap((event) => (event.type === "item.completed" ? [event.item] : []));
const hooksRun = () => (existsSync(hookLog) ? readFileSync(hookLog, "utf8").split("\n") : []);

async function start() {
  const session = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    mode: "fullAccess",
  });
  await client.call("session.open", { sessionId: session.id });
  return session;
}

async function turn(sessionId: string, text: string): Promise<SessionEvent[]> {
  const before = of(sessionId).length;
  const ended = () => of(sessionId).filter((event) => event.type === "turn.completed").length;
  const turns = ended();
  await client.call("session.send", { sessionId, text });
  await client.until(() => ended() > turns);
  return of(sessionId).slice(before);
}

test("a server added in Cycle is in a new session, and its values in no command's sight", async () => {
  const before = ownerFiles();
  const { servers } = await client.call("mcp.put", {
    ...CLAUDE,
    server: {
      name: "docs",
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [mcpServer],
        env: { DEMO_SUFFIX: " (from Cycle)", CYCLE_TEST_SECRET: SECRET },
      },
    },
  });
  const docs = servers.find((server) => server.name === "docs");
  expect(docs).toMatchObject({ origin: "config", enabled: true });
  expect(docs?.transport).toMatchObject({ env: ["CYCLE_TEST_SECRET", "DEMO_SUFFIX"] });
  expect(JSON.stringify(servers)).not.toContain(SECRET);
  expect(servers.find((server) => server.name === "owner-mcp")?.origin).toBe("owner");

  const session = await start();
  const echo = { name: "mcp__docs__echo", input: { text: "hi" } };
  script = (_prompt, results) => (results ? { text: ["used it"] } : { call: echo });
  const used = items(await turn(session.id, "use the docs"));
  expect(used.find((item) => item.kind === "toolCall")).toMatchObject({
    server: "docs",
    tool: "echo",
    status: "completed",
  });

  // What a command of the agent's can see: every process's arguments, and its own environment.
  const seen = { name: "Bash", input: { command: "ps -eo args; env" } };
  script = (_prompt, results) => (results ? { text: ["looked"] } : { call: seen });
  const looked = items(await turn(session.id, "look around"));
  const output = looked.find((item) => item.kind === "command");
  expect(output?.kind === "command" ? output.output : "").toContain("--settings");
  expect(output?.kind === "command" ? output.output : SECRET).not.toContain(SECRET);
  expect(ownerFiles()).toBe(before);
});

test("an owner's server is turned off in Cycle and nowhere else, and comes back", async () => {
  const before = ownerFiles();
  const { servers } = await client.call("mcp.enable", {
    ...CLAUDE,
    name: "owner-mcp",
    enabled: false,
  });
  expect(servers.find((server) => server.name === "owner-mcp")).toMatchObject({
    origin: "owner",
    enabled: false,
  });
  const session = await start();
  const echo = { name: "mcp__owner-mcp__echo", input: { text: "hi" } };
  script = (_prompt, results) => (results ? { text: ["tried"] } : { call: echo });
  const tried = items(await turn(session.id, "use theirs"));
  expect(tried.find((item) => item.kind === "toolCall")).not.toMatchObject({ status: "completed" });
  // A running process does not take a denied server back: its next prompt starts it again.
  await client.call("mcp.enable", { ...CLAUDE, name: "owner-mcp", enabled: true });
  const back = items(await turn(session.id, "use theirs again"));
  expect(back.find((item) => item.kind === "toolCall")).toMatchObject({ status: "completed" });
  expect(ownerFiles()).toBe(before);
});

test("a hook kept in Cycle runs beside the owner's, and turning the owner's off stops both", async () => {
  const before = ownerFiles();
  const kept = await client.call("hooks.set", {
    ...CLAUDE,
    settings: {
      hooks: [
        {
          id: "",
          event: "UserPromptSubmit",
          matcher: "",
          command: `echo cycle >> ${hookLog}`,
          timeout: null,
        },
      ],
      ownerHooks: true,
      ownerSettings: true,
      revision: 0,
    },
  });
  expect(kept.hooks[0]?.id).not.toBe("");
  script = () => ({ text: ["ok"] });
  const session = await start();
  writeFileSync(hookLog, "");
  await turn(session.id, "first");
  expect(hooksRun().toSorted()).toEqual(["", "cycle", "owner"]);

  await client.call("hooks.set", { ...CLAUDE, settings: { ...kept, ownerHooks: false } });
  writeFileSync(hookLog, "");
  await turn(session.id, "second");
  expect(hooksRun()).toEqual([""]);
  expect(ownerFiles()).toBe(before);
});
