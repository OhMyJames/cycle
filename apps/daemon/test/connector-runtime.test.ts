import { afterEach, expect, test } from "bun:test";
import { ConnectorService } from "../src/index.ts";
import { tempDir } from "./support.ts";

// What a connector last learnt from its server (a refusal, a server that was down, that it wants a sign-in) is said
// only while it still holds: a plugin update that changes its headers, or switching it on again, starts it afresh,
// and an answer to the old settings that comes in late says nothing of the new.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const spec = (change: { headers?: Record<string, string>; enabled?: boolean } = {}) => ({
  pluginId: "tracker@market",
  pluginName: "tracker",
  enabled: change.enabled ?? true,
  server: "api",
  agentName: "plugin:tracker:api",
  url: "https://tracker.example/mcp",
  headers: change.headers ?? { "X-Key": "old" },
});

type Kind = "probe" | "request";

/** Holds what reaches the server, of one kind, until let go. */
const gate = () => {
  let open = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open };
};

/**
 * A service in front of a fake server that answers `status`. The probe (the `initialize` Cycle sends on its own) and
 * an agent's request are counted apart, and either can be held.
 */
const start = async () => {
  const { dir, dispose } = await tempDir();
  const upstream = {
    status: 200,
    seen: { probe: 0, request: 0 } as Record<Kind, number>,
    held: {} as Partial<Record<Kind, Promise<void>>>,
  };
  const service = await ConnectorService.load(dir, {
    fetch: async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const kind: Kind =
        body.includes('"initialize"') && body.includes('"id":0') ? "probe" : "request";
      // As it was when it came in: a held answer is the one the server gave to that request.
      const status = upstream.status;
      upstream.seen[kind]++;
      await upstream.held[kind];
      return new Response("{}", { status });
    },
  });
  cleanups.push(dispose, () => service.close());
  return { service, upstream };
};

/** One request from the agent's session through the gateway, as an agent makes it. */
const request = async (service: ConnectorService) => {
  const [server] = (await service.serversFor("s1", "/tmp", new Set(), "claude")) as {
    url: string;
    headers: { name: string; value: string }[];
  }[];
  if (server === undefined) throw new Error("no connector given");
  const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await response.body?.cancel();
};

/** Until `condition` holds, or fails the test after a while. */
const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

const status = async (service: ConnectorService) => (await service.list())[0]?.status;

/** A plugin's connector, installed and asked once, that its server then refuses. */
const refused = async () => {
  const started = await start();
  await started.service.syncPlugins("claude", [spec()]);
  await until(() => started.upstream.seen.probe === 1, "the first probe");
  started.upstream.status = 403;
  await request(started.service);
  expect(await status(started.service)).toEqual({ state: "error", reason: "auth_failed" });
  started.upstream.status = 200;
  return started;
};

test("a plugin's refused connector is ready again once the plugin's headers change", async () => {
  const { service, upstream } = await refused();
  await service.syncPlugins("claude", [spec({ headers: { "X-Key": "new" } })]);
  expect(await status(service)).toEqual({ state: "ready" });
  await until(() => upstream.seen.probe === 2, "a probe with the new headers");
});

test("a plugin's refused connector is ready again when it is switched off and on", async () => {
  const { service, upstream } = await refused();
  await service.syncPlugins("claude", [spec({ enabled: false })]);
  expect(await status(service)).toEqual({ state: "disabled" });
  await service.syncPlugins("claude", [spec({ enabled: true })]);
  expect(await status(service)).toEqual({ state: "ready" });
  // Asked afresh, as when it was first installed.
  await until(() => upstream.seen.probe === 2, "a probe once switched on");
});

test("a plugin synced again unchanged keeps what its server said", async () => {
  const { service, upstream } = await refused();
  await service.syncPlugins("claude", [spec({ headers: { "X-Key": "old" } })]);
  expect(await status(service)).toEqual({ state: "error", reason: "auth_failed" });
  expect(upstream.seen.probe).toBe(1);
});

for (const answer of [403, 401]) {
  test(`a ${answer} to the old headers that comes in after they changed says nothing of the new`, async () => {
    const { service, upstream } = await start();
    await service.syncPlugins("claude", [spec()]);
    await until(() => upstream.seen.probe === 1, "the first probe");
    const { shut, open } = gate();
    upstream.held.request = shut;
    upstream.status = answer;
    const late = request(service);
    await until(() => upstream.seen.request === 1, "the request to reach the server");
    upstream.status = 200;
    await service.syncPlugins("claude", [spec({ headers: { "X-Key": "new" } })]);
    open();
    await late;
    // Neither refused nor taken for one that wants a sign-in.
    const [connector] = await service.list();
    expect(connector?.status).toEqual({ state: "ready" });
    expect(connector?.auth).toEqual({ type: "none" });
  });
}

test("a probe of the old headers that answers 401 late does not make the plugin one to sign in to", async () => {
  const { service, upstream } = await start();
  const { shut, open } = gate();
  upstream.held.probe = shut;
  upstream.status = 401;
  await service.syncPlugins("claude", [spec()]);
  await until(() => upstream.seen.probe === 1, "the first probe");
  upstream.status = 200;
  await service.syncPlugins("claude", [spec({ headers: { "X-Key": "new" } })]);
  await until(() => upstream.seen.probe === 2, "a probe with the new headers");
  open();
  // What the late probe would do (read the entry, write it back) is done within this; nothing is waited on to show
  // that it was not.
  await Bun.sleep(50);
  const [connector] = await service.list();
  expect(connector?.auth).toEqual({ type: "none" });
  expect(connector?.status).toEqual({ state: "ready" });
});

test("a connector of the person's own, refused, is ready again when switched back on", async () => {
  const { service, upstream } = await start();
  const added = await service.add({
    name: "mine",
    transport: { type: "http", url: "https://mine.example/mcp" },
    auth: { type: "none" },
  });
  upstream.status = 403;
  await request(service);
  expect(await status(service)).toEqual({ state: "error", reason: "auth_failed" });
  upstream.status = 200;
  await service.update({ id: added.id, enabled: false });
  await service.update({ id: added.id, enabled: true });
  expect(await status(service)).toEqual({ state: "ready" });
});
