// The whole backend, as a user would run it: a client reaches the daemon over ssh (a stand-in for
// ssh, which runs the command here), `cycle proxy` starts the daemon, the daemon starts the
// Claude adapter, which runs the real Agent SDK against a mock of the Anthropic API.
// Run with `bun run test:integration` in apps/daemon. The pre-commit gate does not run it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleClient, sshChannel } from "@cycle/client";
import { META } from "@cycle/protocol";
import {
  startMock,
  textReply,
} from "../../../../harness/claude/test/integration/mock-anthropic.ts";
import { response } from "../../../../harness/codex/test/integration/mock-responses.ts";
import { ConfigSchema } from "../../src/config.ts";
import { agentsFor } from "../../src/harnesses.ts";
import { Daemon } from "../../src/index.ts";
import { isListening } from "../../src/transport/server.ts";
import { connectClient, until as waitUntil } from "../client.ts";
import { fakeSsh } from "../fake-ssh.ts";

// CYCLE_DAEMON_BIN: run the built single-file executable instead of the source (see `bun run build`).
const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;
const DAEMON =
  process.env.CYCLE_DAEMON_BIN !== undefined ? [process.env.CYCLE_DAEMON_BIN] : ["bun", MAIN];
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-full-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string, ms = 60_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

const daemonPid = async (dataDir: string): Promise<number | undefined> => {
  const pid = await Bun.file(join(dataDir, "daemon.pid"))
    .text()
    .catch(() => "");
  return pid === "" ? undefined : Number(pid.trim());
};

test("the backend end to end: ssh, proxy, daemon, adapter, SDK, and a drop that changes nothing", async () => {
  const mock = startMock(() => textReply("Hello from the whole backend."));
  const dataDir = join(root, "data");
  const socket = join(root, "d.sock");
  const cwd = join(root, "work");
  await Bun.write(join(cwd, ".keep"), "");
  await Bun.write(
    join(dataDir, "config.json"),
    JSON.stringify({
      claude: {
        configDir: join(root, "claude"),
        env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "mock-key-not-real" },
      },
    }),
  );
  const ssh = await fakeSsh(root);
  // The daemon's own environment holds a key that would bill an account. It must stay there.
  process.env.ANTHROPIC_API_KEY = "SHOULD-NEVER-REACH-CLAUDE";
  let pid: number | undefined;
  try {
    const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
    const states: string[] = [];
    const client = new CycleClient({
      connect: async () =>
        sshChannel({
          host: "me@box",
          ssh: ssh.path,
          command: [...DAEMON, "proxy", "--data-dir", dataDir, "--socket", socket],
        }),
      events: {
        update: (_id, update, seq) => seen.push({ update, seq }),
        connection: (state) => states.push(state),
      },
      backoff: { first: 50, max: 500 },
    });
    // No daemon is running yet: the proxy starts one.
    expect(await isListening(socket)).toBe(false);
    await client.start();
    expect(await isListening(socket)).toBe(true);
    pid = await daemonPid(dataDir);
    expect(pid).toBeNumber();

    const agents = await client.agents();
    expect(agents.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "claude", available: true }),
        expect.objectContaining({ id: "codex", available: true }),
      ]),
    );

    const sessionId = await client.newSession({ cwd, config: { mode: "default" } });
    await client.watch(sessionId, cwd);
    await client.prompt(sessionId, [{ type: "text", text: "Say hello." }]);
    const ended = (n: number) =>
      seen.filter((s) => {
        const u = s.update as { state?: string; stopReason?: string };
        return u.state === "idle" && u.stopReason !== undefined;
      }).length >= n;
    await until(() => ended(1), "the first turn");
    const streamed = () =>
      seen
        .filter((s) => s.update.sessionUpdate === "agent_message_chunk")
        .map((s) => (s.update as unknown as { content: { text: string } }).content.text)
        .join("");
    expect(streamed()).toBe("Hello from the whole backend.");

    // The ssh connection dies. The daemon, which was started detached, goes on.
    // (Cutting the client's channel stands in for the network.)
    await client.close();
    expect(await isListening(socket)).toBe(true);
    expect(await daemonPid(dataDir)).toBe(pid);

    // A new client, a new ssh, the same daemon: it asks for the history and gets it, then goes on.
    const again: { update: SessionUpdate; seq: number | undefined }[] = [];
    const second = new CycleClient({
      connect: async () =>
        sshChannel({
          host: "me@box",
          ssh: ssh.path,
          command: [...DAEMON, "proxy", "--data-dir", dataDir, "--socket", socket],
        }),
      events: { update: (_id, update, seq) => again.push({ update, seq }) },
    });
    await second.start();
    expect((await second.listSessions()).map((s) => s.sessionId)).toEqual([sessionId]);
    await second.watch(sessionId, cwd);
    expect(
      again
        .filter((s) => s.update.sessionUpdate === "agent_message_chunk")
        .map((s) => (s.update as unknown as { content: { text: string } }).content.text)
        .join(""),
    ).toBe("Hello from the whole backend.");
    await second.prompt(sessionId, [{ type: "text", text: "And once more." }]);
    await until(
      () =>
        again.filter((s) => (s.update as { stopReason?: string }).stopReason === "end_turn")
          .length >= 2,
      "the second turn",
    );
    await second.close();

    // Claude got what it was given, and nothing else: not the daemon's key.
    const asked = mock.requests.filter((r) => r.path === "/v1/messages");
    expect(asked.length).toBeGreaterThan(0);
    for (const request of mock.requests) {
      expect(JSON.stringify(request.headers)).not.toContain("SHOULD-NEVER-REACH-CLAUDE");
    }
    expect(asked.some((r) => r.headers["x-api-key"] === "mock-key-not-real")).toBe(true);
    // The second turn had the first in its context.
    expect(
      asked.some((r) => {
        const body = JSON.stringify(r.body);
        return body.includes("Say hello.") && body.includes("And once more.");
      }),
    ).toBe(true);
  } finally {
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    const toStop = pid ?? (await daemonPid(dataDir));
    if (toStop !== undefined) process.kill(toStop, "SIGTERM");
    mock.stop();
  }
}, 100_000);

/** An http MCP server with one tool, that answers only the key the connector was given. */
const keyedMcp = (key: string) => {
  const seen: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      seen.push(request.headers.get("authorization"));
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return new Response("unauthorized", { status: 401 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "keyed", version: "0" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "gateway_ping",
                    description: "Answers when the key was right.",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : {};
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, seen, stop: () => server.stop(true) };
};

test("a connector added in Cycle reaches the real Claude through the daemon's gateway; its key stays in the daemon", async () => {
  const key = "connector-key-5150";
  const mock = startMock(() => textReply("Ok."));
  const mcp = keyedMcp(key);
  const base = join(root, "connectors");
  const dataDir = join(base, "data");
  const socket = join(base, "d.sock");
  const cwd = join(base, "work");
  await Bun.write(join(cwd, ".keep"), "");
  await Bun.write(
    join(dataDir, "config.json"),
    JSON.stringify({
      claude: {
        configDir: join(base, "claude"),
        env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "mock-key-not-real" },
      },
    }),
  );
  const ssh = await fakeSsh(base);
  let pid: number | undefined;
  try {
    const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
    const client = new CycleClient({
      connect: async () =>
        sshChannel({
          host: "me@box",
          ssh: ssh.path,
          command: [...DAEMON, "proxy", "--data-dir", dataDir, "--socket", socket],
        }),
      events: { update: (_id, update, seq) => seen.push({ update, seq }) },
    });
    await client.start();
    pid = await daemonPid(dataDir);
    const connector = await client.addConnector({
      name: "keyed",
      transport: { type: "http", url: mcp.url },
      auth: { type: "none" },
      secrets: { headers: { Authorization: `Bearer ${key}` } },
    });
    expect(connector.secrets.headers).toEqual(["Authorization"]);
    expect(JSON.stringify(await client.listConnectors())).not.toContain(key);

    const sessionId = await client.newSession({ cwd, config: { mode: "default" } });
    await client.watch(sessionId, cwd);
    await client.prompt(sessionId, [{ type: "text", text: "hello" }]);
    await until(
      () =>
        seen.some((s) => {
          const u = s.update as { state?: string; stopReason?: string };
          return u.state === "idle" && u.stopReason !== undefined;
        }),
      "the turn",
    );
    await client.close();

    // The model was offered the connector's tool: Claude reached the server, through the gateway.
    const asked = mock.requests.filter((r) => r.path === "/v1/messages");
    expect(asked.some((r) => JSON.stringify(r.body).includes("mcp__keyed__gateway_ping"))).toBe(
      true,
    );
    // The server only ever saw the key the daemon put in; the key is in no history on disk.
    expect(mcp.seen.length).toBeGreaterThan(0);
    expect(mcp.seen.every((auth) => auth === `Bearer ${key}`)).toBe(true);
    const glob = new Bun.Glob("**/*.jsonl");
    for await (const file of glob.scan({ cwd: dataDir, absolute: true })) {
      expect(await Bun.file(file).text()).not.toContain(key);
    }
    expect(await Bun.file(join(dataDir, "index.json")).text()).not.toContain(key);
  } finally {
    const toStop = pid ?? (await daemonPid(dataDir));
    if (toStop !== undefined) process.kill(toStop, "SIGTERM");
    mock.stop();
    mcp.stop();
  }
}, 60_000);

test("Codex permissions, empty-thread reassociation and missing answered history through the daemon", async () => {
  const dataDir = join(root, "codex-data"),
    cwd = join(root, "codex-project"),
    home = join(dataDir, "codex");
  await mkdir(cwd);
  await mkdir(home, { recursive: true });
  let command: string | undefined;
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/responses"))
        return new Response(null, { status: 404 });
      await req.text();
      const cmd = command;
      command = undefined;
      return response(cmd !== undefined, cmd ?? "");
    },
  });
  await Bun.write(
    join(home, "config.toml"),
    `model="gpt-5.4"
model_provider="mock"
[model_providers.mock]
name="mock"
base_url="http://127.0.0.1:${mock.port}/v1"
wire_api="responses"
supports_websockets=false
`,
  );
  const start = () =>
    Daemon.start({
      dataDir,
      agents: agentsFor(
        ConfigSchema.parse({}),
        dataDir,
        { PATH: process.env.PATH, OPENAI_API_KEY: "host-secret" },
        undefined,
        undefined,
        DAEMON,
      ),
    });
  let daemon = await start();
  try {
    let c = await connectClient(daemon);
    const list = (await c.agent.request("_cycle/agents/list", {})) as {
      agents: { id: string; available: boolean }[];
    };
    expect(list.agents).toContainEqual(expect.objectContaining({ id: "codex", available: true }));
    const { sessionId } = await c.agent.request(methods.agent.session.new, {
      cwd,
      _meta: { [META.agent]: "codex", [META.config]: { mode: "untrusted" } },
    });
    const entry = async () =>
      (await Bun.file(join(dataDir, "index.json")).json()).sessions[sessionId];
    const original = (await entry()).agentSessionId;
    await daemon.close();
    // Force the missing-rollout case, including on versions that persist an empty thread.
    await rm(join(home, "sessions"), { recursive: true, force: true });
    daemon = await start();
    let answer: "allow" | "deny" = "deny";
    c = await connectClient(daemon, { onPermission: () => answer });
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd });
    const prompt = async (text: string) => {
      const count = c.ended();
      await c.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      await waitUntil(() => c.ended() > count, "Codex prompt", 10_000);
    };
    command = "touch denied-by-cycle";
    await prompt("Try the first command.");
    expect(c.permissions.length).toBeGreaterThan(0);
    expect(await Bun.file(join(cwd, "denied-by-cycle")).exists()).toBe(false);
    const replacement = (await entry()).agentSessionId;
    expect(replacement).not.toBe(original);
    answer = "allow";
    command = "if env | grep -q ^OPENAI_API_KEY=; then exit 1; fi; touch allowed-by-cycle";
    await prompt("Try the second command.");
    expect(c.permissions.length).toBeGreaterThan(1);
    expect(await Bun.file(join(cwd, "allowed-by-cycle")).exists()).toBe(true);
    expect((await entry()).hadTurn).toBe(true);
    await daemon.close();
    await rm(join(home, "sessions"), { recursive: true, force: true });
    daemon = await start();
    c = await connectClient(daemon);
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd });
    await expect(
      c.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "continue" }],
      }),
    ).rejects.toMatchObject({ code: -32013 });
    expect((await entry()).agentSessionId).toBe(replacement);
  } finally {
    await daemon.close();
    mock.stop(true);
  }
}, 30_000);
