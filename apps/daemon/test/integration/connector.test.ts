import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { type MockModel, startMockModel } from "./mock-model.ts";
import { connect } from "./wire-client.ts";

let model: MockModel;
let daemon: Daemon;
let root: string;
let providers: OpenProviders;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-connector-"));
  mkdirSync(join(root, "codex"));
  mkdirSync(join(root, "project"));
  model = startMockModel(() => ({ text: ["Done"] }));
  providers = await openProviders(diskFile(join(root, "home", "providers.json")), "gateway-token");
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

const config = () => readFileSync(join(root, "codex", "config.toml"), "utf8");

test("the owner's MCP servers are added, changed, turned off and removed", async () => {
  const client = connect(daemon.url);
  await client.opened;
  const server = join(import.meta.dir, "mcp-server.ts");

  const added = await client.call("mcp.put", {
    server: {
      name: "demo",
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [server],
        env: { DEMO_SUFFIX: " (first)" },
      },
    },
  });
  expect(added.servers).toMatchObject([
    {
      name: "demo",
      enabled: true,
      status: "connected",
      auth: "none",
      transport: { kind: "stdio", command: process.execPath, env: ["DEMO_SUFFIX"] },
      tools: [{ name: "echo", description: "Echoes its input (first)" }],
    },
  ]);
  // Every client hears of it.
  expect(client.pushes.some((push) => push.type === "mcp.changed")).toBe(true);

  // An edit that names the variable without a value keeps what is stored.
  await client.call("mcp.put", {
    server: {
      name: "demo",
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [server],
        env: { DEMO_SUFFIX: null },
      },
    },
  });
  expect(config()).toContain('DEMO_SUFFIX = " (first)"');

  const off = await client.call("mcp.enable", { name: "demo", enabled: false });
  expect(off.servers).toMatchObject([{ name: "demo", enabled: false, status: "disabled" }]);

  await expect(client.call("mcp.login", { name: "demo" })).rejects.toThrow("streamable HTTP");
  await expect(
    client.call("mcp.put", {
      server: {
        name: "a.b",
        transport: { kind: "http", url: "https://x", bearerTokenEnvVar: null },
      },
    }),
  ).rejects.toThrow("name is letters");

  const removed = await client.call("mcp.remove", { name: "demo" });
  expect(removed.servers).toEqual([]);
  expect(config()).not.toContain("mcp_servers");
  client.close();
}, 60_000);

test("a marketplace is added and its plugin installed, turned off and removed", async () => {
  const client = connect(daemon.url);
  await client.opened;
  const market = join(root, "market");
  mkdirSync(join(market, ".claude-plugin"), { recursive: true });
  mkdirSync(join(market, "hello", ".claude-plugin"), { recursive: true });
  mkdirSync(join(market, "hello", "skills", "greet"), { recursive: true });
  writeFileSync(
    join(market, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "demo-market",
      owner: { name: "Demo" },
      plugins: [{ name: "hello", source: "./hello", description: "Says hello" }],
    }),
  );
  writeFileSync(
    join(market, "hello", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "hello", version: "1.0.0", description: "Says hello" }),
  );
  writeFileSync(
    join(market, "hello", "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: Greets the user\n---\nSay hello.\n",
  );

  const listed = await client.call("marketplace.add", { source: market });
  expect(listed.marketplaces).toMatchObject([
    { name: "demo-market", plugins: [{ id: "hello@demo-market", installed: false }] },
  ]);
  const detail = await client.call("plugins.read", { marketplace: "demo-market", name: "hello" });
  expect(detail).toMatchObject({
    description: "Says hello",
    skills: [{ name: "hello:greet", description: "Greets the user" }],
  });

  const installed = await client.call("plugins.install", {
    marketplace: "demo-market",
    name: "hello",
  });
  expect(installed.marketplaces[0]?.plugins).toMatchObject([{ installed: true, enabled: true }]);
  const skills = await client.call("skills.list", { cwd: join(root, "project") });
  expect(skills.skills.map((skill) => skill.name)).toContain("hello:greet");

  const off = await client.call("plugins.enable", { id: "hello@demo-market", enabled: false });
  expect(off.marketplaces[0]?.plugins).toMatchObject([{ installed: true, enabled: false }]);

  const gone = await client.call("plugins.uninstall", { id: "hello@demo-market" });
  expect(gone.marketplaces[0]?.plugins).toMatchObject([{ installed: false }]);
  const removed = await client.call("marketplace.remove", { name: "demo-market" });
  expect(removed.marketplaces).toEqual([]);
  client.close();
}, 60_000);

test("a schedule's run starts a session marked as its own, and is kept", async () => {
  const client = connect(daemon.url);
  await client.opened;
  const schedule = await client.call("schedule.put", {
    name: "Nightly",
    enabled: true,
    prompt: "PROMPT:nightly",
    cwd: join(root, "project"),
    worktree: false,
    model: null,
    effort: null,
    mode: "readOnly",
    timing: { kind: "daily", time: "03:00", weekdays: null },
  });
  expect(schedule.next).toBeGreaterThan(Date.now());

  const run = await client.call("schedule.run", { id: schedule.id });
  expect(run).toMatchObject({ manual: true, error: null });
  const sessionId = run.sessionId ?? "";
  await client.call("session.open", { sessionId });
  await client.until(() => client.events().some((event) => event.type === "turn.completed"));
  const { sessions } = await client.call("session.list", { archived: false });
  expect(sessions.find((session) => session.id === sessionId)).toMatchObject({
    scheduleId: schedule.id,
    mode: "readOnly",
  });

  const { schedules } = await client.call("schedule.list", {});
  expect(schedules).toMatchObject([{ id: schedule.id, runs: [{ sessionId, manual: true }] }]);
  expect(client.pushes.some((push) => push.type === "schedules.changed")).toBe(true);
  await client.call("schedule.delete", { id: schedule.id });
  expect((await client.call("schedule.list", {})).schedules).toEqual([]);
  client.close();
}, 60_000);
