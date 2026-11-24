import { afterEach, beforeEach, expect, test } from "bun:test";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import {
  ConnectorService,
  Daemon,
  type PluginProvider,
  type ProviderPlugin,
  type ProviderSnapshot,
} from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

/**
 * Plugins (docs/protocol.md §15) against an agent's plugin machinery that is a list in memory, and an MCP server on
 * loopback that says what reached it. Nothing here is Claude's: that is harness/claude/test/plugins.test.ts.
 */

/** An MCP server that answers 401 until it is sent what it wants. */
const fakeServer = (wants: { header: string; value: string } | "sign-in" | "nothing") => {
  const seen: { key: string | null; bundle: string | null; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const body = (await request.json()) as { id: number };
      seen.push({
        key: request.headers.get("x-key"),
        bundle: request.headers.get("x-bundle"),
        authorization: request.headers.get("authorization"),
      });
      const allowed =
        wants === "nothing" ||
        (wants !== "sign-in" && request.headers.get(wants.header) === wants.value);
      if (!allowed) {
        return new Response("no", { status: 401, headers: { "www-authenticate": "Bearer" } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, seen, stop: () => server.stop(true) };
};

/** An agent's plugins, kept in memory: a directory of two, and what was done to it. */
const fakeProvider = (directory: ProviderPlugin[]) => {
  const installed = new Map<string, ProviderPlugin>();
  const sources = [
    { id: "builtin", name: "Directory", kind: "builtin" as const, removable: false },
  ];
  const calls: string[] = [];
  const control = { fail: undefined as { reason: string; detail: string } | undefined };
  const act = (what: string) => {
    calls.push(what);
    if (control.fail !== undefined) throw Object.assign(new Error("no"), control.fail);
  };
  const provider: PluginProvider = {
    snapshot: async (): Promise<ProviderSnapshot> => ({
      sources: [...sources],
      installed: [...installed.values()],
      available: directory.map((plugin) => installed.get(plugin.id) ?? plugin),
    }),
    installed: async () => [...installed.values()],
    install: async (id) => {
      act(`install ${id}`);
      const plugin = directory.find((p) => p.id === id);
      if (plugin === undefined) throw Object.assign(new Error("no"), { reason: "not_found" });
      installed.set(id, {
        ...plugin,
        installed: true,
        enabled: true,
        scope: "user",
        contents: { skills: 1, commands: 0, agents: 0, hooks: 2, mcpServers: 2 },
      });
    },
    uninstall: async (id) => {
      act(`uninstall ${id}`);
      installed.delete(id);
    },
    update: async (id) => {
      act(`update ${id}`);
      return { updated: false };
    },
    setEnabled: async (id, enabled) => {
      act(`${enabled ? "enable" : "disable"} ${id}`);
      const plugin = installed.get(id);
      if (plugin !== undefined) installed.set(id, { ...plugin, enabled });
    },
    addSource: async (location) => {
      act(`add ${location}`);
      sources.push({ id: "mine", name: "mine", kind: "git" as never, removable: true as never });
      return "mine";
    },
    removeSource: async (id) => {
      act(`remove ${id}`);
    },
    refreshSource: async (id) => {
      act(`refresh ${id ?? "*"}`);
    },
  };
  return { provider, calls, control, installed };
};

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];
let stops: (() => void)[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  for (const stop of stops) stop();
  stops = [];
  await dispose();
});

const serve = (wants: Parameters<typeof fakeServer>[0]) => {
  const server = fakeServer(wants);
  stops.push(server.stop);
  return server;
};

const start = async (directory: ProviderPlugin[]) => {
  const fake = fakeAgent({}, { mcpHttp: true });
  const plugins = fakeProvider(directory);
  const connectors = await ConnectorService.load(dir);
  const daemon = await Daemon.start({
    dataDir: dir,
    agents: [{ ...fake.definition, plugins: plugins.provider }],
    connectors,
  });
  open.push(daemon);
  return { daemon, fake, plugins, connectors, c: await connectClient(daemon) };
};

type Client = Awaited<ReturnType<typeof connectClient>>;
const call = <T = Record<string, unknown>>(c: Client, method: string, params: object) =>
  c.agent.request(method as never, params as never) as Promise<T>;
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: number; data?: { reason?: string; detail?: string } };
  }
  throw new Error("it did not fail");
};

type Plugin = {
  id: string;
  agentId: string;
  installed: boolean;
  enabled?: boolean;
  servers?: { name: string; by: string; connectorId?: string }[];
};
type Connector = {
  id: string;
  name: string;
  enabled: boolean;
  auth: { type: string };
  secrets: { env: string[] };
  status: { state: string };
  origin?: { type: string; agentId: string; pluginId: string; server: string };
  requires?: string[];
};
type Given = { name: string; url: string; headers: { name: string; value: string }[] };

const asAgent = (server: Given) =>
  fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
  });

const plain = (name: string, description: string): ProviderPlugin => ({
  id: `${name}@builtin`,
  name,
  description,
  sourceId: "builtin",
  installed: false,
});

test("the agents with plugins are a capability; what can be installed comes a page at a time and is searched", async () => {
  const { c } = await start([
    plain("alpha", "Writes notes"),
    plain("beta", "Reads mail"),
    plain("gamma", "Notes and more"),
  ]);
  const capabilities = (c.init._meta as Record<string, { plugins?: string[] }>)[
    "cycle/capabilities"
  ];
  expect(capabilities?.plugins).toEqual(["fake"]);

  const listed = await call<{ sources: { id: string; agentId: string }[]; plugins: Plugin[] }>(
    c,
    "_cycle/plugins/list",
    { agentId: "fake" },
  );
  expect(listed.plugins).toEqual([]);
  expect(listed.sources).toMatchObject([{ id: "builtin", agentId: "fake", removable: false }]);

  const first = await call<{ plugins: Plugin[]; nextCursor?: string; total: number }>(
    c,
    "_cycle/plugins/available",
    { agentId: "fake", limit: 2 },
  );
  expect(first.plugins.map((p) => p.id)).toEqual(["alpha@builtin", "beta@builtin"]);
  expect(first.total).toBe(3);
  const rest = await call<{ plugins: Plugin[]; nextCursor?: string }>(
    c,
    "_cycle/plugins/available",
    { agentId: "fake", limit: 2, cursor: first.nextCursor },
  );
  expect(rest.plugins.map((p) => p.id)).toEqual(["gamma@builtin"]);
  expect(rest.nextCursor).toBeUndefined();

  const found = await call<{ plugins: Plugin[]; total: number }>(c, "_cycle/plugins/available", {
    agentId: "fake",
    query: "NOTES",
  });
  expect(found.plugins.map((p) => p.id)).toEqual(["alpha@builtin", "gamma@builtin"]);

  // An agent that has none, or is not there, is said to have none.
  expect((await errorOf(call(c, "_cycle/plugins/list", { agentId: "other" }))).code).toBe(-32002);
});

test("installing needs the person's word; then the plugin is installed, switched, updated and removed, and everyone is told", async () => {
  const { c, plugins } = await start([plain("alpha", "Writes notes")]);

  const unsaid = await errorOf(
    call(c, "_cycle/plugins/install", { agentId: "fake", id: "alpha@builtin" }),
  );
  expect(unsaid.code).toBe(-32602);
  expect(plugins.calls).toEqual([]);

  const { plugin } = await call<{ plugin: Plugin & { contents: { hooks: number } } }>(
    c,
    "_cycle/plugins/install",
    { agentId: "fake", id: "alpha@builtin", acknowledged: true },
  );
  expect(plugin).toMatchObject({ agentId: "fake", installed: true, enabled: true, scope: "user" });
  expect(plugin.contents.hooks).toBe(2);
  await until(() => c.pluginsChanged.length === 1, "the change to be told");
  expect(c.pluginsChanged).toEqual(["fake"]);

  const off = await call<{ plugin: Plugin }>(c, "_cycle/plugins/set_enabled", {
    agentId: "fake",
    id: "alpha@builtin",
    enabled: false,
  });
  expect(off.plugin.enabled).toBe(false);
  const updated = await call<{ updated: boolean }>(c, "_cycle/plugins/update", {
    agentId: "fake",
    id: "alpha@builtin",
  });
  expect(updated.updated).toBe(false);

  await call(c, "_cycle/plugins/uninstall", { agentId: "fake", id: "alpha@builtin" });
  const after = await call<{ plugins: Plugin[] }>(c, "_cycle/plugins/list", { agentId: "fake" });
  expect(after.plugins).toEqual([]);
  expect(plugins.calls).toEqual([
    "install alpha@builtin",
    "disable alpha@builtin",
    "update alpha@builtin",
    "uninstall alpha@builtin",
  ]);
});

test("what the agent's machinery refuses comes back as a fixed word, with what it said for a person", async () => {
  const { c, plugins } = await start([plain("alpha", "Writes notes")]);
  plugins.control.fail = { reason: "not_found", detail: "No plugin of that name" };
  const failed = await errorOf(
    call(c, "_cycle/plugins/install", { agentId: "fake", id: "alpha@builtin", acknowledged: true }),
  );
  expect(failed.code).toBe(-32020);
  expect(failed.data).toMatchObject({ reason: "not_found", detail: "No plugin of that name" });

  // A word that is not one of ours is not passed on as if it were.
  plugins.control.fail = { reason: "exploded", detail: "" };
  const other = await errorOf(call(c, "_cycle/plugins/sources/refresh", { agentId: "fake" }));
  expect(other.data?.reason).toBe("failed");

  plugins.control.fail = undefined;
  const unsaid = await errorOf(
    call(c, "_cycle/plugins/sources/add", { agentId: "fake", location: "owner/repo" }),
  );
  expect(unsaid.code).toBe(-32602);
  const added = await call<{ source: { id: string } }>(c, "_cycle/plugins/sources/add", {
    agentId: "fake",
    location: "owner/repo",
    acknowledged: true,
  });
  expect(added.source.id).toBe("mine");
});

test("a plugin's http server is a connector of Cycle's: given to the agent under the agent's name for it, with the person's value filled in here", async () => {
  const upstream = serve({ header: "x-key", value: "Bearer secret-1" });
  const { c, fake, plugins, connectors } = await start([
    {
      ...plain("tracker", "Issues"),
      servers: [
        {
          name: "api",
          agentName: "plugin:tracker:api",
          http: {
            url: upstream.url,
            headers: { "X-Key": `Bearer \${TRACKER_TOKEN}`, "X-Bundle": "b1" },
          },
        },
        { name: "local", agentName: "plugin:tracker:local" },
      ],
    },
  ]);
  const { plugin } = await call<{ plugin: Plugin }>(c, "_cycle/plugins/install", {
    agentId: "fake",
    id: "tracker@builtin",
    acknowledged: true,
  });
  const api = plugin.servers?.find((s) => s.name === "api");
  expect(api?.by).toBe("cycle");
  expect(plugin.servers?.find((s) => s.name === "local")).toEqual({ name: "local", by: "agent" });

  const list = async () =>
    (await call<{ connectors: Connector[] }>(c, "_cycle/connectors/list", {})).connectors;
  const [connector] = await list();
  expect(connector).toMatchObject({
    id: api?.connectorId,
    enabled: true,
    origin: { type: "plugin", agentId: "fake", pluginId: "tracker@builtin", server: "api" },
    requires: ["TRACKER_TOKEN"],
    status: { state: "needs_auth" },
  });
  const id = (connector as Connector).id;

  // It is the plugin's: not renamed, moved, switched or removed on its own.
  for (const change of [{ name: "mine" }, { enabled: false }, { auth: { type: "oauth" } }]) {
    const refused = await errorOf(call(c, "_cycle/connectors/update", { id, ...change }));
    expect(refused.data?.reason).toBe("managed");
  }
  expect((await errorOf(call(c, "_cycle/connectors/remove", { id }))).data?.reason).toBe("managed");

  // The agent is given it under the name it knows the plugin's server by, in place of the plugin's own.
  await c.agent.request(methods.agent.session.new, { cwd: dir } as never);
  const given = (fake.log.news[0]?.mcpServers ?? []) as Given[];
  expect(given.map((s) => s.name)).toEqual(["plugin:tracker:api"]);
  const server = given[0] as Given;
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);

  // Without the person's value nothing is sent on.
  expect((await asAgent(server)).status).toBe(401);
  expect(upstream.seen).toEqual([]);

  // A key the server refuses is a wrong key, not a server to sign in to.
  await call(c, "_cycle/connectors/update", { id, secrets: { env: { TRACKER_TOKEN: "wrong" } } });
  expect((await asAgent(server)).status).toBe(401);
  expect((await list())[0]).toMatchObject({ auth: { type: "none" }, status: { state: "error" } });

  await call(c, "_cycle/connectors/update", {
    id,
    secrets: { env: { TRACKER_TOKEN: "secret-1" } },
  });
  expect((await list())[0]).toMatchObject({
    secrets: { env: ["TRACKER_TOKEN"] },
    status: { state: "ready" },
  });
  const answer = await asAgent(server);
  expect(answer.status).toBe(200);
  expect(upstream.seen.at(-1)).toMatchObject({ key: "Bearer secret-1", bundle: "b1" });
  expect(JSON.stringify(given)).not.toContain("secret-1");

  // Another agent's sessions are not given it.
  expect(await connectors.serversFor("elsewhere", dir, new Set(), "other")).toEqual([]);

  // An update of the plugin that moves its server: the key typed for the old address is asked for again, not sent on.
  const elsewhere = serve("nothing");
  const mine = plugins.installed.get("tracker@builtin") as ProviderPlugin;
  plugins.installed.set("tracker@builtin", {
    ...mine,
    servers: [
      {
        name: "api",
        agentName: "plugin:tracker:api",
        http: { url: elsewhere.url, headers: { "X-Key": `Bearer \${TRACKER_TOKEN}` } },
      },
    ],
  });
  await call(c, "_cycle/plugins/update", { agentId: "fake", id: "tracker@builtin" });
  expect((await list())[0]).toMatchObject({
    id,
    transport: { url: elsewhere.url },
    secrets: { env: [] },
    status: { state: "needs_auth" },
  });
  expect((await asAgent(server)).status).toBe(401);
  expect(elsewhere.seen).toEqual([]);

  // Switched off with its plugin, and gone with it, values and all.
  await call(c, "_cycle/plugins/set_enabled", {
    agentId: "fake",
    id: "tracker@builtin",
    enabled: false,
  });
  expect((await list())[0]).toMatchObject({ enabled: false, status: { state: "disabled" } });
  await call(c, "_cycle/plugins/uninstall", { agentId: "fake", id: "tracker@builtin" });
  expect(await list()).toEqual([]);
  expect(plugins.installed.size).toBe(0);
});

test("a plugin's server that answers 401 is one to sign in to, found when the plugin is installed", async () => {
  const upstream = serve("sign-in");
  const { c } = await start([
    {
      ...plain("docs", "Documents"),
      servers: [
        { name: "docs", agentName: "plugin:docs:docs", http: { url: upstream.url, headers: {} } },
      ],
    },
  ]);
  await call(c, "_cycle/plugins/install", {
    agentId: "fake",
    id: "docs@builtin",
    acknowledged: true,
  });
  let connector: Connector | undefined;
  const started = Date.now();
  while (connector?.auth.type !== "oauth") {
    if (Date.now() - started > 2_000)
      throw new Error("timed out waiting for the sign-in to be found");
    await Bun.sleep(10);
    connector = (await call<{ connectors: Connector[] }>(c, "_cycle/connectors/list", {}))
      .connectors[0];
  }
  expect(connector).toMatchObject({ auth: { type: "oauth" }, status: { state: "needs_auth" } });
  // Asked with no token of anyone's.
  expect(upstream.seen[0]?.authorization).toBeNull();
});

test("a plugin's server at an address that is not safe for a token is left to the agent", async () => {
  const { c, fake } = await start([
    {
      ...plain("lan", "On the network"),
      servers: [
        {
          name: "lan",
          agentName: "plugin:lan:lan",
          http: { url: "http://192.168.1.9/mcp", headers: {} },
        },
      ],
    },
  ]);
  const { plugin } = await call<{ plugin: Plugin }>(c, "_cycle/plugins/install", {
    agentId: "fake",
    id: "lan@builtin",
    acknowledged: true,
  });
  expect(plugin.servers).toEqual([{ name: "lan", by: "agent" }]);
  await c.agent.request(methods.agent.session.new, { cwd: dir } as never);
  expect(fake.log.news[0]?.mcpServers ?? []).toEqual([]);
});

test("before an agent starts, its plugins' connectors are made what is installed now, though nobody has looked", async () => {
  const upstream = serve("nothing");
  const { c, fake, plugins } = await start([]);
  // Installed without Cycle being asked to (the agent updating itself, a change made outside), and listed twice.
  const outside: ProviderPlugin = {
    ...plain("docs", "Documents"),
    installed: true,
    enabled: true,
    servers: [
      { name: "docs", agentName: "plugin:docs:docs", http: { url: upstream.url, headers: {} } },
    ],
  };
  plugins.installed.set("docs@builtin", outside);
  plugins.provider.installed = async () => [outside, outside];

  await c.agent.request(methods.agent.session.new, { cwd: dir } as never);
  const given = (fake.log.news[0]?.mcpServers ?? []) as Given[];
  expect(given.map((s) => s.name)).toEqual(["plugin:docs:docs"]);
  expect((await asAgent(given[0] as Given)).status).toBe(200);
  // One connector for one server, however often it is named.
  const { connectors } = await call<{ connectors: Connector[] }>(c, "_cycle/connectors/list", {});
  expect(connectors).toHaveLength(1);
});

test("an agent's plugins that cannot be asked do not keep it from starting", async () => {
  const { c, fake, plugins } = await start([]);
  plugins.provider.installed = async () => {
    throw new Error("no");
  };
  await c.agent.request(methods.agent.session.new, { cwd: dir } as never);
  expect(fake.log.news).toHaveLength(1);
});

test("a change that fails is told too: it may have been done halfway", async () => {
  const { c, plugins } = await start([plain("alpha", "Writes notes")]);
  plugins.control.fail = { reason: "timeout", detail: "" };
  await errorOf(
    call(c, "_cycle/plugins/install", { agentId: "fake", id: "alpha@builtin", acknowledged: true }),
  );
  await until(() => c.pluginsChanged.length === 1, "the failed change to be told");
});
