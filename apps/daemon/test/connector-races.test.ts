import { afterEach, expect, test } from "bun:test";
import { ConnectorService } from "../src/connectors/service.ts";
import type { Spawn, Spawned } from "../src/connectors/stdio-bridge.ts";
import {
  type CatalogEntry,
  type ConnectorCatalog,
  type Credentials,
  type CredentialVault,
  emptyCredentials,
} from "../src/connectors/store.ts";

// Concurrency races across sign-in, stdio bridge startup, plugin sync, and revocation (CYCL-272).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const gate = () => {
  let open = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open };
};

const until = async (condition: () => boolean, what: string, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

class MemoryCatalog implements ConnectorCatalog {
  readonly items = new Map<string, CatalogEntry>();
  onGet: ((id: string) => Promise<void> | void) | undefined;
  onPut: ((entry: CatalogEntry) => Promise<void> | void) | undefined;
  onRemove: ((id: string) => Promise<void> | void) | undefined;

  async list(): Promise<CatalogEntry[]> {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async get(id: string): Promise<CatalogEntry | undefined> {
    await this.onGet?.(id);
    const found = this.items.get(id);
    return found === undefined ? undefined : structuredClone(found);
  }
  async put(entry: CatalogEntry): Promise<void> {
    await this.onPut?.(entry);
    this.items.set(entry.id, structuredClone(entry));
  }
  async remove(id: string): Promise<void> {
    await this.onRemove?.(id);
    this.items.delete(id);
  }
}

class MemoryVault implements CredentialVault {
  readonly items = new Map<string, Credentials>();
  onGet: ((id: string) => Promise<void> | void) | undefined;
  onPut: ((id: string, credentials: Credentials) => Promise<void> | void) | undefined;

  async get(id: string): Promise<Credentials> {
    await this.onGet?.(id);
    const found = this.items.get(id);
    return found === undefined ? emptyCredentials() : structuredClone(found);
  }
  async put(id: string, credentials: Credentials): Promise<void> {
    await this.onPut?.(id, credentials);
    this.items.set(id, structuredClone(credentials));
  }
  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}

type OAuthHarness = {
  service: ConnectorService;
  catalog: MemoryCatalog;
  vault: MemoryVault;
  seen: {
    mcp: { url: string; authorization: string | null }[];
    revoked: string[];
    tokenCalls: Record<string, string>[];
    registerCalls: number;
  };
  gates: {
    register?: Promise<void> | undefined;
    exchange?: Promise<void> | undefined;
    refresh?: Promise<void> | undefined;
  };
  state: {
    valid: Set<string>;
    issued: number;
    rotateRefresh: boolean;
  };
};

const makeOAuthHarness = (): OAuthHarness => {
  const catalog = new MemoryCatalog();
  const vault = new MemoryVault();
  const seen = {
    mcp: [] as { url: string; authorization: string | null }[],
    revoked: [] as string[],
    tokenCalls: [] as Record<string, string>[],
    registerCalls: 0,
  };
  const gates: OAuthHarness["gates"] = {};
  const state = { valid: new Set(["access-1"]), issued: 1, rotateRefresh: true };

  const service = new ConnectorService({
    catalog,
    vault,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/mcp" || url.pathname === "/mcp-b") {
        const auth = new Headers(init?.headers).get("authorization");
        seen.mcp.push({ url: url.href, authorization: auth });
        const token = auth?.replace(/^Bearer /, "");
        if (token === undefined || !state.valid.has(token)) {
          return new Response("no", {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}"`,
            },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `${url.origin}/mcp`,
          authorization_servers: [`${url.origin}/as`],
          scopes_supported: ["read"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server/as") {
        return Response.json({
          issuer: `${url.origin}/as`,
          authorization_endpoint: `${url.origin}/as/authorize`,
          token_endpoint: `${url.origin}/as/token`,
          registration_endpoint: `${url.origin}/as/register`,
          revocation_endpoint: `${url.origin}/as/revoke`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/as/register") {
        seen.registerCalls++;
        await gates.register;
        return Response.json({ client_id: `client-${url.hostname}` }, { status: 201 });
      }
      if (url.pathname === "/as/token") {
        const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
        seen.tokenCalls.push(form);
        if (form.grant_type === "authorization_code") {
          await gates.exchange;
          return Response.json({
            access_token: `access-${state.issued}`,
            refresh_token: `refresh-${state.issued}`,
            expires_in: 3600,
          });
        }
        if (form.grant_type === "refresh_token") {
          await gates.refresh;
          state.issued++;
          const access = `access-${state.issued}`;
          state.valid = new Set([access]);
          return Response.json({
            access_token: access,
            ...(state.rotateRefresh ? { refresh_token: `refresh-${state.issued}` } : {}),
            expires_in: 3600,
          });
        }
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (url.pathname === "/as/revoke") {
        const token = new URLSearchParams(String(init?.body ?? "")).get("token") ?? "";
        seen.revoked.push(token);
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => service.close());
  return { service, catalog, vault, seen, gates, state };
};

const postGateway = async (
  server: { url: string; headers: { name: string; value: string }[] },
  id = 1,
) => {
  const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
  return fetch(server.url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
  });
};

type FakeProc = {
  command: string[];
  env: Record<string, string>;
  killed: boolean;
  process: Spawned;
};

const makeEchoSpawn = () => {
  const spawned: FakeProc[] = [];
  const spawn: Spawn = (command, options) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    let resolveExit = (_code: number) => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const encoder = new TextEncoder();
    const record: FakeProc = {
      command,
      env: { ...options.env },
      killed: false,
      process: {
        stdin: {
          write(data: string) {
            for (const line of data.split("\n")) {
              if (line.trim() === "") continue;
              const msg = JSON.parse(line) as { id?: number | string };
              if (msg.id !== undefined) {
                controller?.enqueue(
                  encoder.encode(
                    `${JSON.stringify({
                      jsonrpc: "2.0",
                      id: msg.id,
                      result: { cmd: command[0], secret: options.env.SECRET ?? null },
                    })}\n`,
                  ),
                );
              }
            }
          },
          end() {},
        },
        stdout,
        exited,
        kill() {
          if (record.killed) return;
          record.killed = true;
          try {
            controller?.close();
          } catch {
            // Already closed.
          }
          resolveExit(0);
        },
      },
    };
    spawned.push(record);
    return record.process;
  };
  return { spawn, spawned };
};

test("changing address during authFinish discards and revokes the old server's tokens", async () => {
  const { service, vault, seen, gates } = makeOAuthHarness();
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://old.example/mcp" },
    auth: { type: "oauth" },
  });
  const begun = await service.authStart(added.id, "http://127.0.0.1:43123/callback");
  const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";

  const exchange = gate();
  gates.exchange = exchange.shut;
  const finishing = service.authFinish({ flowId: begun.flowId, code: "ok", state });
  await until(() => seen.tokenCalls.length === 1, "token exchange to start");

  await service.update({
    id: added.id,
    transport: { type: "http", url: "https://new.example/mcp" },
  });

  exchange.open();
  await expect(finishing).rejects.toMatchObject({ data: { reason: "auth_rejected" } });

  // Old server's freshly-minted tokens are revoked and never stored on the new server.
  expect(seen.revoked).toContain("refresh-1");
  expect(seen.revoked).toContain("access-1");
  expect((await vault.get(added.id)).oauth).toBeUndefined();
  const [listed] = await service.list();
  expect(listed).toMatchObject({ authorized: false, status: { state: "needs_auth" } });

  // A request to the new server never carries the old server's token.
  const [server] = (await service.serversFor("s1", "/tmp", new Set())) as {
    url: string;
    headers: { name: string; value: string }[];
  }[];
  if (server === undefined) throw new Error("no server");
  const response = await postGateway(server);
  await response.body?.cancel();
  expect(seen.mcp.at(-1)).toEqual({ url: "https://new.example/mcp", authorization: null });
});

test("signing out during authFinish discards and revokes the newly-exchanged tokens", async () => {
  const { service, vault, seen, gates } = makeOAuthHarness();
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://old.example/mcp" },
    auth: { type: "oauth" },
  });
  const begun = await service.authStart(added.id, "http://127.0.0.1:43123/callback");
  const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";

  const exchange = gate();
  gates.exchange = exchange.shut;
  const finishing = service.authFinish({ flowId: begun.flowId, code: "ok", state });
  await until(() => seen.tokenCalls.length === 1, "token exchange to start");

  await service.authClear(added.id);
  exchange.open();
  await expect(finishing).rejects.toMatchObject({ data: { reason: "auth_rejected" } });

  expect(seen.revoked).toContain("refresh-1");
  expect(seen.revoked).toContain("access-1");
  expect((await vault.get(added.id)).oauth).toBeUndefined();
});

test("changing address during authStart does not write old server endpoints into the vault", async () => {
  const { service, vault, seen, gates } = makeOAuthHarness();
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://old.example/mcp" },
    auth: { type: "oauth" },
  });
  const reg = gate();
  gates.register = reg.shut;
  const starting = service.authStart(added.id, "http://127.0.0.1:43123/callback");
  await until(() => seen.registerCalls === 1, "registration to start");

  await service.update({
    id: added.id,
    transport: { type: "http", url: "https://new.example/mcp" },
  });

  reg.open();
  await expect(starting).rejects.toMatchObject({ data: { reason: "auth_rejected" } });
  expect((await vault.get(added.id)).oauth).toBeUndefined();
});

test("renaming during authFinish is reflected in the returned connector view", async () => {
  const { service, seen, gates } = makeOAuthHarness();
  const added = await service.add({
    name: "before",
    transport: { type: "http", url: "https://srv.example/mcp" },
    auth: { type: "oauth" },
  });
  const begun = await service.authStart(added.id, "http://127.0.0.1:43123/callback");
  const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";

  const exchange = gate();
  gates.exchange = exchange.shut;
  const finishing = service.authFinish({ flowId: begun.flowId, code: "ok", state });
  await until(() => seen.tokenCalls.length === 1, "token exchange to start");

  await service.update({ id: added.id, name: "after" });
  exchange.open();
  const finished = await finishing;
  expect(finished).toMatchObject({
    name: "after",
    authorized: true,
    status: { state: "ready" },
  });
});

for (const action of ["remove", "move"] as const) {
  test(`${action} during an in-flight refresh also revokes the newly rotated refresh token`, async () => {
    const { service, vault, seen, gates, state } = makeOAuthHarness();
    const added = await service.add({
      name: "srv",
      transport: { type: "http", url: "https://old.example/mcp" },
      auth: { type: "oauth" },
    });
    const begun = await service.authStart(added.id, "http://127.0.0.1:43123/callback");
    const oauthState = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";
    await service.authFinish({ flowId: begun.flowId, code: "ok", state: oauthState });

    const [server] = (await service.serversFor("s1", "/tmp", new Set())) as {
      url: string;
      headers: { name: string; value: string }[];
    }[];
    if (server === undefined) throw new Error("no server");

    state.valid = new Set();
    const refreshGate = gate();
    gates.refresh = refreshGate.shut;
    const pending = postGateway(server);
    await until(
      () => seen.tokenCalls.some((t) => t.grant_type === "refresh_token"),
      "refresh to reach the token endpoint",
    );

    if (action === "remove") {
      await service.remove(added.id);
    } else {
      await service.update({
        id: added.id,
        transport: { type: "http", url: "https://new.example/mcp" },
      });
    }
    expect(seen.revoked).toContain("refresh-1");

    refreshGate.open();
    const response = await pending;
    await response.body?.cancel();

    // The rotated refresh token and access token returned after the remove/move are revoked too.
    expect(seen.revoked).toContain("refresh-2");
    expect(seen.revoked).toContain("access-2");
    expect((await vault.get(added.id)).oauth).toBeUndefined();
  });
}

test("stdio deduplicates concurrent first requests so only one process is spawned", async () => {
  const catalog = new MemoryCatalog();
  const vault = new MemoryVault();
  const { spawn, spawned } = makeEchoSpawn();
  const service = new ConnectorService({ catalog, vault, spawn, env: {} });
  cleanups.push(() => service.close());

  const added = await service.add({
    name: "local",
    transport: { type: "stdio", command: "fake-mcp", args: [] },
    auth: { type: "none" },
    secrets: { env: { SECRET: "v1" } },
  });
  const [server] = (await service.serversFor("s1", "/tmp", new Set())) as {
    url: string;
    headers: { name: string; value: string }[];
  }[];
  if (server === undefined) throw new Error("no server");

  const vaultGate = gate();
  let vaultGets = 0;
  let catalogGets = 0;
  catalog.onGet = (id) => {
    if (id === added.id) catalogGets++;
  };
  vault.onGet = async (id) => {
    if (id !== added.id) return;
    vaultGets++;
    if (vaultGets === 1) await vaultGate.shut;
  };

  const first = postGateway(server, 1);
  await until(() => vaultGets === 1, "first request to await vault.get");
  const second = postGateway(server, 2);
  // Wait until the second request has read the catalog and entered #stdio -> #startStdio.
  await until(() => catalogGets >= 2, "second request to reach #stdio");
  vaultGate.open();

  const [r1, r2] = await Promise.all([first, second]);
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  expect(await r1.json()).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: { cmd: "fake-mcp", secret: "v1" },
  });
  expect(await r2.json()).toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: { cmd: "fake-mcp", secret: "v1" },
  });
  expect(vaultGets).toBe(1);
  expect(spawned).toHaveLength(1);
});

test("stdio does not spawn a process if the session is released while reading credentials", async () => {
  const catalog = new MemoryCatalog();
  const vault = new MemoryVault();
  const { spawn, spawned } = makeEchoSpawn();
  const service = new ConnectorService({ catalog, vault, spawn, env: {} });
  cleanups.push(() => service.close());

  const added = await service.add({
    name: "local",
    transport: { type: "stdio", command: "fake-mcp", args: [] },
    auth: { type: "none" },
  });
  const [server] = (await service.serversFor("s1", "/tmp", new Set())) as {
    url: string;
    headers: { name: string; value: string }[];
  }[];
  if (server === undefined) throw new Error("no server");

  const vaultGate = gate();
  let waiting = false;
  vault.onGet = async (id) => {
    if (id !== added.id || waiting) return;
    waiting = true;
    await vaultGate.shut;
  };

  const pending = postGateway(server, 1);
  await until(() => waiting, "request to await vault.get");
  service.release("s1");
  vaultGate.open();

  const response = await pending;
  await response.body?.cancel();
  expect(response.status).toBe(401);
  expect(spawned).toHaveLength(0);
});

test("stdio does not spawn with stale settings if updated while reading credentials", async () => {
  const catalog = new MemoryCatalog();
  const vault = new MemoryVault();
  const { spawn, spawned } = makeEchoSpawn();
  const service = new ConnectorService({ catalog, vault, spawn, env: {} });
  cleanups.push(() => service.close());

  const added = await service.add({
    name: "local",
    transport: { type: "stdio", command: "old-cmd", args: [] },
    auth: { type: "none" },
    secrets: { env: { SECRET: "old" } },
  });
  const [server] = (await service.serversFor("s1", "/tmp", new Set())) as {
    url: string;
    headers: { name: string; value: string }[];
  }[];
  if (server === undefined) throw new Error("no server");

  const vaultGate = gate();
  let gated = false;
  vault.onGet = async (id) => {
    if (id !== added.id || gated) return;
    gated = true;
    await vaultGate.shut;
  };

  const stale = postGateway(server, 1);
  await until(() => gated, "stale request to await vault.get");

  await service.update({
    id: added.id,
    transport: { type: "stdio", command: "new-cmd", args: [] },
    secrets: { env: { SECRET: "new" } },
  });
  vaultGate.open();

  const staleResponse = await stale;
  await staleResponse.body?.cancel();
  expect(staleResponse.status).toBe(502);
  expect(spawned).toHaveLength(0);

  // Subsequent request spawns once with the new command and values.
  const fresh = await postGateway(server, 2);
  expect(fresh.status).toBe(200);
  expect(await fresh.json()).toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: { cmd: "new-cmd", secret: "new" },
  });
  expect(spawned).toHaveLength(1);
});

test("a late 401 from an old plugin URL cannot overwrite a concurrent sync that moves the URL", async () => {
  const catalog = new MemoryCatalog();
  const vault = new MemoryVault();
  const oldRequestGate = gate();
  let oldRequestSeen = false;
  let newProbeSeen = false;

  const service = new ConnectorService({
    catalog,
    vault,
    fetch: async (input, init) => {
      const body = String(init?.body ?? "");
      const isProbe = body.includes('"initialize"') && body.includes('"id":0');
      if (input === "https://old.example/mcp") {
        if (isProbe) return new Response("{}", { status: 200 });
        oldRequestSeen = true;
        await oldRequestGate.shut;
        return new Response("no", { status: 401 });
      }
      if (input === "https://new.example/mcp") {
        if (isProbe) newProbeSeen = true;
        return new Response("{}", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => service.close());

  const plugin = (url: string) => [
    {
      pluginId: "tracker@market",
      pluginName: "tracker",
      enabled: true,
      server: "api",
      agentName: "plugin:tracker:api",
      url,
      headers: {},
    },
  ];

  await service.syncPlugins("claude", plugin("https://old.example/mcp"));
  const [server] = (await service.serversFor("s1", "/tmp", new Set(), "claude")) as {
    url: string;
    headers: { name: string; value: string }[];
  }[];
  if (server === undefined) throw new Error("no server");

  const late401 = postGateway(server, 1);
  await until(() => oldRequestSeen, "request to reach old plugin URL");

  // Pause syncPlugins right before writing the moved entry to the catalog (before reset runs),
  // and release the late 401 into needsSignIn during that exact window.
  const putGate = gate();
  let syncPaused = false;
  catalog.onPut = async (entry) => {
    if (
      entry.transport.type === "http" &&
      entry.transport.url === "https://new.example/mcp" &&
      !syncPaused
    ) {
      syncPaused = true;
      await putGate.shut;
    }
  };

  const moving = service.syncPlugins("claude", plugin("https://new.example/mcp"));
  await until(() => syncPaused, "syncPlugins to pause mid-move before reset");

  oldRequestGate.open();
  // Let the late 401 reach needsSignIn while syncPlugins is still before catalog.put and reset.
  await Bun.sleep(25);
  putGate.open();

  await Promise.all([moving, late401.then((r) => r.body?.cancel())]);
  await until(() => newProbeSeen, "probe on new URL");

  const [listed] = await service.list();
  expect(listed).toMatchObject({
    transport: { type: "http", url: "https://new.example/mcp" },
    auth: { type: "none" },
    status: { state: "ready" },
  });
});

test("a stale authStart finishing after a move and a new authStart does not wipe the new flow", async () => {
  const { service, seen, gates } = makeOAuthHarness();
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://old.example/mcp" },
    auth: { type: "oauth" },
  });

  const regGate = gate();
  gates.register = regGate.shut;
  const staleStart = service.authStart(added.id, "http://127.0.0.1:43123/callback");
  await until(() => seen.registerCalls === 1, "stale registration to start");

  await service.update({
    id: added.id,
    transport: { type: "http", url: "https://new.example/mcp" },
  });
  gates.register = undefined;
  const freshBegun = await service.authStart(added.id, "http://127.0.0.1:43124/callback");
  const freshState = new URL(freshBegun.authorizationUrl).searchParams.get("state") ?? "";

  // Let the stale start complete after the new flow is already active.
  regGate.open();
  await expect(staleStart).rejects.toMatchObject({ data: { reason: "auth_rejected" } });

  // The new flow is intact and finishes cleanly.
  const finished = await service.authFinish({
    flowId: freshBegun.flowId,
    code: "ok",
    state: freshState,
  });
  expect(finished).toMatchObject({ authorized: true, status: { state: "ready" } });
});

test("removing a connector during authFinish rejects with not found and revokes tokens", async () => {
  const { service, seen, gates } = makeOAuthHarness();
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://old.example/mcp" },
    auth: { type: "oauth" },
  });
  const begun = await service.authStart(added.id, "http://127.0.0.1:43123/callback");
  const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";

  const exchange = gate();
  gates.exchange = exchange.shut;
  const finishing = service.authFinish({ flowId: begun.flowId, code: "ok", state });
  await until(() => seen.tokenCalls.length === 1, "token exchange to start");

  await service.remove(added.id);
  exchange.open();
  await expect(finishing).rejects.toMatchObject({ code: -32002 });
  expect(seen.revoked).toContain("refresh-1");
  expect(seen.revoked).toContain("access-1");
});

test("switching auth type to none during authFinish rejects and revokes tokens", async () => {
  const { service, vault, seen, gates } = makeOAuthHarness();
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://old.example/mcp" },
    auth: { type: "oauth" },
  });
  const begun = await service.authStart(added.id, "http://127.0.0.1:43123/callback");
  const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";

  const exchange = gate();
  gates.exchange = exchange.shut;
  const finishing = service.authFinish({ flowId: begun.flowId, code: "ok", state });
  await until(() => seen.tokenCalls.length === 1, "token exchange to start");

  await service.update({ id: added.id, auth: { type: "none" } });
  exchange.open();
  await expect(finishing).rejects.toMatchObject({ data: { reason: "auth_rejected" } });
  expect(seen.revoked).toContain("refresh-1");
  expect((await vault.get(added.id)).oauth).toBeUndefined();
});

test("a delayed authFinish cannot exchange an old flow's code against a moved server", async () => {
  const { service, catalog, seen } = makeOAuthHarness();
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://old.example/mcp" },
    auth: { type: "oauth" },
  });
  const oldBegun = await service.authStart(added.id, "http://127.0.0.1:43123/callback");
  const oldState = new URL(oldBegun.authorizationUrl).searchParams.get("state") ?? "";

  const getGate = gate();
  let paused = false;
  catalog.onGet = async (id) => {
    if (id === added.id && !paused) {
      paused = true;
      await getGate.shut;
    }
  };
  const oldFinishing = service.authFinish({ flowId: oldBegun.flowId, code: "ok", state: oldState });
  await until(() => paused, "authFinish to pause on catalog.get");

  catalog.onGet = undefined;
  await service.update({
    id: added.id,
    transport: { type: "http", url: "https://new.example/mcp" },
  });
  await service.authStart(added.id, "http://127.0.0.1:43124/callback");

  getGate.open();
  await expect(oldFinishing).rejects.toMatchObject({ data: { reason: "auth_rejected" } });
  // No token exchange ever happened for the stale flow.
  expect(seen.tokenCalls).toHaveLength(0);
});

test("concurrent update and remove never resurrects a deleted connector", async () => {
  const { service, catalog } = makeOAuthHarness();
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://srv.example/mcp" },
    auth: { type: "none" },
  });

  const removeGate = gate();
  let removingPaused = false;
  catalog.onRemove = async (id) => {
    if (id === added.id && !removingPaused) {
      removingPaused = true;
      await removeGate.shut;
    }
  };

  const removing = service.remove(added.id);
  await until(() => removingPaused, "remove to pause at catalog.remove");
  const updating = service.update({ id: added.id, name: "renamed" });
  removeGate.open();

  await removing;
  await expect(updating).rejects.toMatchObject({ code: -32002 });
  expect(await service.list()).toEqual([]);
});

test("stdio does not spawn when disabled or during a concurrent remove or command+env update", async () => {
  const catalog = new MemoryCatalog();
  const vault = new MemoryVault();
  const { spawn, spawned } = makeEchoSpawn();
  const service = new ConnectorService({ catalog, vault, spawn, env: {} });
  cleanups.push(() => service.close());

  const added = await service.add({
    name: "local",
    transport: { type: "stdio", command: "old-cmd", args: [] },
    auth: { type: "none" },
    secrets: { env: { SECRET: "old" } },
  });
  const [server] = (await service.serversFor("s1", "/tmp", new Set())) as {
    url: string;
    headers: { name: string; value: string }[];
  }[];
  if (server === undefined) throw new Error("no server");

  // 1. Update writes new env to vault while catalog still has old-cmd: a request arriving mid-update must not spawn old-cmd with new env.
  const putVaultGate = gate();
  let vaultPutPaused = false;
  vault.onPut = async (id) => {
    if (id === added.id && !vaultPutPaused) {
      vaultPutPaused = true;
      await putVaultGate.shut;
    }
  };
  const updating = service.update({
    id: added.id,
    transport: { type: "stdio", command: "new-cmd", args: [] },
    secrets: { env: { SECRET: "new" } },
  });
  await until(() => vaultPutPaused, "update to pause at vault.put");
  const midUpdate = await postGateway(server, 1);
  await midUpdate.body?.cancel();
  expect(midUpdate.status).toBe(502);
  expect(spawned).toHaveLength(0);
  putVaultGate.open();
  await updating;

  // 2. Disabling while a request awaits vault.get prevents spawning.
  const disableGate = gate();
  let disablePaused = false;
  vault.onGet = async (id) => {
    if (id === added.id && !disablePaused) {
      disablePaused = true;
      await disableGate.shut;
    }
  };
  const pendingDisable = postGateway(server, 2);
  await until(() => disablePaused, "request to pause at vault.get before disable");
  await service.update({ id: added.id, enabled: false });
  disableGate.open();
  const disabledResp = await pendingDisable;
  await disabledResp.body?.cancel();
  expect(disabledResp.status).toBe(404);
  expect(spawned).toHaveLength(0);

  // 3. Re-enable, then pause remove() before catalog.remove: a request arriving mid-remove must not spawn a leaked process.
  vault.onGet = undefined;
  await service.update({ id: added.id, enabled: true });
  const removeGate = gate();
  let removePaused = false;
  catalog.onRemove = async (id) => {
    if (id === added.id && !removePaused) {
      removePaused = true;
      await removeGate.shut;
    }
  };
  const removing = service.remove(added.id);
  await until(() => removePaused, "remove to pause at catalog.remove");
  const midRemove = await postGateway(server, 3);
  await midRemove.body?.cancel();
  expect(midRemove.status).toBe(502);
  expect(spawned).toHaveLength(0);
  removeGate.open();
  await removing;
});

test("non-invalidated refresh loss only revokes tokens not kept by a concurrent re-sign-in", async () => {
  const { service, seen, gates, state } = makeOAuthHarness();
  state.rotateRefresh = false;
  const added = await service.add({
    name: "srv",
    transport: { type: "http", url: "https://srv.example/mcp" },
    auth: { type: "oauth" },
  });
  const begun1 = await service.authStart(added.id, "http://127.0.0.1:43123/callback");
  await service.authFinish({
    flowId: begun1.flowId,
    code: "ok",
    state: new URL(begun1.authorizationUrl).searchParams.get("state") ?? "",
  });

  const [server] = (await service.serversFor("s1", "/tmp", new Set())) as {
    url: string;
    headers: { name: string; value: string }[];
  }[];
  if (server === undefined) throw new Error("no server");

  state.valid = new Set();
  const refreshGate = gate();
  gates.refresh = refreshGate.shut;
  const pending = postGateway(server, 1);
  await until(
    () => seen.tokenCalls.some((t) => t.grant_type === "refresh_token"),
    "refresh to reach token endpoint",
  );

  // Re-sign-in on the same server completes while refresh is in flight (issues access-99 and refresh-99).
  state.issued = 99;
  const begun2 = await service.authStart(added.id, "http://127.0.0.1:43124/callback");
  await service.authFinish({
    flowId: begun2.flowId,
    code: "ok",
    state: new URL(begun2.authorizationUrl).searchParams.get("state") ?? "",
  });

  // Now release the old refresh (which returns access-100 and keeps refresh-1).
  refreshGate.open();
  const response = await pending;
  await response.body?.cancel();

  // Discarded access-100 is revoked, and refresh-1 (which differs from refresh-99) is revoked too;
  // refresh-99 and access-99 (currently active) are NOT revoked.
  expect(seen.revoked).toContain("access-100");
  expect(seen.revoked).not.toContain("access-99");
  expect(seen.revoked).not.toContain("refresh-99");
});
