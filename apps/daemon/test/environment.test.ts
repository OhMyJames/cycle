// A session's environment (docs/protocol.md §6 "环境"): checked, kept in the index only, given to every launch of the
// session's agent, summed up in the list without values, and its actions run in the session's terminals.
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { checkEnvironment } from "@cycle/protocol";
import { scriptFor } from "../src/environment.ts";
import { Daemon, indexPath, sessionsDir } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { daemonHarness } from "./support.ts";

let dir: string;
const open = daemonHarness<Daemon>((made) => {
  dir = made;
});

const start = async (fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  return { daemon, fake };
};

const environment = {
  id: "env-1",
  name: "Node + Postgres",
  variables: [
    { name: "DATABASE_URL", value: "postgres://u:s3cret-pass@db/app" },
    { name: "NODE_ENV", value: "development" },
  ],
  actions: [{ id: "dev", name: "Dev server", command: { default: "npm run dev" } }],
  setup: { default: "npm ci" },
};

test("the environment is given to every launch of the session's agent, and kept for a restart", async () => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/environment": environment },
  });
  const sessionEnv = { DATABASE_URL: "postgres://u:s3cret-pass@db/app", NODE_ENV: "development" };
  expect(fake.log.launchContexts[0]).toEqual({ sessionId, sessionEnv });
  // The agent does not get the client's _meta: the variables reach it only through its launch.
  expect(JSON.stringify(fake.log.news[0])).not.toContain("s3cret-pass");

  fake.crash();
  await Bun.sleep(30);
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "again" }],
  });
  await until(() => fake.log.resumes.length === 1, "the agent to be resumed");
  expect(fake.log.launchContexts[1]).toEqual({ sessionId, sessionEnv });
});

test("a session without an environment launches with no variables", async () => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  expect(fake.log.launchContexts[0]).toMatchObject({ sessionEnv: {} });
  const row = (await c.agent.request(methods.agent.session.list, {})).sessions[0]?._meta ?? {};
  expect(row).not.toHaveProperty("cycle/environment");
});

test("the list sums the environment up without a value; the values are in the index only", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/environment": environment },
  });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "hi" }],
  });
  await until(() => c.ended() >= 1, "the turn to end");

  const listed = await c.agent.request(methods.agent.session.list, {});
  expect(listed.sessions[0]?._meta?.["cycle/environment"]).toEqual({
    id: "env-1",
    name: "Node + Postgres",
    variableNames: ["DATABASE_URL", "NODE_ENV"],
    actions: [{ id: "dev", name: "Dev server" }],
  });
  expect(JSON.stringify(listed)).not.toContain("s3cret-pass");
  for (const file of await readdir(sessionsDir(dir))) {
    expect(await readFile(join(sessionsDir(dir), file), "utf8")).not.toContain("s3cret-pass");
  }
  expect(await readFile(indexPath(dir), "utf8")).toContain("s3cret-pass");
});

test.each([
  ["a reserved name", [{ name: "HOME", value: "/x" }], "reserved_variable"],
  ["an agent's login", [{ name: "ANTHROPIC_API_KEY", value: "k" }], "reserved_variable"],
  ["the daemon's prefix", [{ name: "CYCLE_ADAPTER_CONFIG", value: "{}" }], "reserved_variable"],
  ["a name a shell cannot take", [{ name: "NOT-OK", value: "x" }], "invalid_variable"],
  [
    "a name twice",
    [
      { name: "A", value: "1" },
      { name: "A", value: "2" },
    ],
    "invalid_variable",
  ],
])("an environment with %s is refused, and nothing is made", async (_what, variables, reason) => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  await expect(
    c.agent.request(methods.agent.session.new, {
      cwd: "/tmp",
      _meta: { "cycle/environment": { ...environment, variables } },
    }),
  ).rejects.toMatchObject({ code: -32602, data: { reason } });
  expect(fake.log.launches).toBe(0);
  expect((await c.agent.request(methods.agent.session.list, {})).sessions).toEqual([]);
});

test("the daemon says it takes environments", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  expect((c.init._meta as Record<string, unknown>)["cycle/capabilities"]).toMatchObject({
    environments: true,
  });
});

// ---- the parts that need no daemon ----

test("an environment too large is refused", () => {
  const big = { ...environment, variables: [{ name: "BIG", value: "x".repeat(70_000) }] };
  expect(checkEnvironment(big)).toMatchObject({ ok: false, problem: { reason: "too_large" } });
});

test("two actions with one id are refused", () => {
  const twice = { ...environment, actions: [environment.actions[0], environment.actions[0]] };
  expect(checkEnvironment(twice)).toMatchObject({
    ok: false,
    problem: { reason: "invalid_environment" },
  });
});

test("a script is this system's own, else the default, else none", () => {
  const scripts = { default: "make", macos: "make mac", windows: "" };
  expect(scriptFor(scripts, "darwin")).toBe("make mac");
  expect(scriptFor(scripts, "linux")).toBe("make");
  // An empty one is none, not a fall back to the default: the person cleared it for that system.
  expect(scriptFor(scripts, "win32")).toBeUndefined();
  expect(scriptFor({}, "linux")).toBeUndefined();
  expect(scriptFor(undefined, "linux")).toBeUndefined();
});

test("an environment in the index this version cannot read counts as none: the list, a launch and a terminal still work", async () => {
  const { environmentOf, sessionVariables, environmentRowMeta } = await import(
    "../src/environment.ts"
  );
  const entry = {
    agent: "fake",
    agentSessionId: "a",
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    environment: { id: "e", name: "Odd", variables: { NOT: "a list" } },
  };
  expect(environmentOf(entry)).toBeUndefined();
  expect(sessionVariables(entry)).toEqual({});
  expect(environmentRowMeta(entry)).toEqual({});
});

// ---- what each harness hands its adapter ----

test("each harness hands its adapter the session's variables its own way: Claude a private file, Codex the values, agy none", async () => {
  const { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = await import(
    "node:fs"
  );
  const { claudeHarness } = await import("../src/claude-agent.ts");
  const { codexHarness } = await import("../src/codex-agent.ts");
  const { agyHarness } = await import("../src/agy-agent.ts");
  const { ConfigSchema } = await import("../src/config.ts");
  const configs = join(dir, "adapter-configs.txt");
  const self = join(dir, "self.sh");
  writeFileSync(self, `#!/bin/sh\nprintf '%s\\n' "$CYCLE_ADAPTER_CONFIG" >> "${configs}"\n`);
  chmodSync(self, 0o755);
  // A file a former daemon left: gone once Claude's definition is made.
  mkdirSync(join(dir, "claude-env"), { recursive: true });
  writeFileSync(join(dir, "claude-env", "old.sh"), "export OLD='x'\n");
  const context = {
    config: ConfigSchema.parse({}),
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin", HOME: dir },
    self: [self],
  };
  const sessionId = "5b0c3a3e-8a52-4d3f-9a0e-1c2d3e4f5a6b";
  const sessionEnv = { DATABASE_URL: "postgres://db" };
  const claude = claudeHarness.definition(context);
  expect(existsSync(join(dir, "claude-env", "old.sh"))).toBe(false);
  for (const definition of [
    claude,
    codexHarness.definition(context),
    agyHarness.definition(context),
  ]) {
    const launched = await definition.launch({ sessionId, sessionEnv });
    const before = existsSync(configs) ? readFileSync(configs, "utf8").split("\n").length : 0;
    await until(
      () => existsSync(configs) && readFileSync(configs, "utf8").split("\n").length > before,
      `${definition.id}'s adapter config`,
      // A shell spawned on a loaded machine (CI runs the suite twice over) can take more than the default 2 s.
      15_000,
    );
    launched.kill?.();
  }
  const [forClaude, forCodex, forAgy] = readFileSync(configs, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const file = join(dir, "claude-env", `${sessionId}.sh`);
  expect(forClaude).toMatchObject({ sessionEnvFile: file });
  expect(forClaude).not.toHaveProperty("sessionEnv");
  expect(JSON.stringify(forClaude)).not.toContain("postgres://db");
  expect(readFileSync(file, "utf8")).toBe("export DATABASE_URL='postgres://db'\n");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(forCodex).toMatchObject({ sessionEnv });
  expect(forAgy).not.toHaveProperty("sessionEnv");
  expect(JSON.stringify(forAgy)).not.toContain("postgres://db");
}, 60_000);

test("an environment in the index with a name the rules refuse counts as none", async () => {
  const { environmentOf } = await import("../src/environment.ts");
  const entry = {
    agent: "fake",
    agentSessionId: "a",
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    environment: { id: "e", name: "Odd", variables: [{ name: "a.b", value: "1" }], actions: [] },
  };
  expect(environmentOf(entry)).toBeUndefined();
  const reserved = {
    ...entry,
    environment: { ...entry.environment, variables: [{ name: "HOME", value: "/x" }] },
  };
  expect(environmentOf(reserved)).toBeUndefined();
});
