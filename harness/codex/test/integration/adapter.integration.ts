// Pinned native CLI, real ACP stdio, local Responses API. No credentials or real model.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  client,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";

import { response } from "./mock-responses.ts";

test("the packaged adapter streams, executes a sandboxed command, interrupts and closes", async () => {
  const dir = await mkdtemp(join(homedir(), ".cycle-test-codex-"));
  const cwd = join(dir, "project"),
    home = join(dir, "home");
  await mkdir(cwd);
  await mkdir(home);
  const command =
    "if env | grep -q ^CYCLE_TEST_SECRET=; then exit 1; fi; if touch ../outside; then exit 1; fi; printf unset > marker";
  let nextCommand: string | undefined;
  let hold = false;
  const received: string[] = [];
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (!new URL(req.url).pathname.endsWith("/responses"))
        return new Response(null, { status: 404 });
      received.push(await req.text());
      if (nextCommand !== undefined) {
        const cmd = nextCommand;
        nextCommand = undefined;
        return response(true, cmd);
      }
      if (hold)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      return response(false, "");
    },
  });
  const executable = process.env.CYCLE_DAEMON_BIN;
  const entry = new URL("../../../../apps/daemon/src/main.ts", import.meta.url).pathname;
  await writeFile(
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
  const proc = Bun.spawn(
    [...(executable ? [executable] : [process.execPath, entry]), "adapter", "codex"],
    {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        CYCLE_TEST_SECRET: "host-only-secret",
        CYCLE_ADAPTER_CONFIG: JSON.stringify({
          env: { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin" },
        }),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const updates: SessionUpdate[] = [];
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      proc.stdin.end();
    },
  });
  const acp = client().onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params.update);
  });
  async function waitFor(predicate: () => boolean) {
    for (let i = 0; i < 400 && !predicate(); i++) await Bun.sleep(25);
    if (!predicate()) throw new Error(`Timed out, ACP updates: ${JSON.stringify(updates)}`);
  }
  try {
    await acp.connectWith(ndJsonStream(input, proc.stdout), async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
      });
      const { sessionId } = await agent.request(methods.agent.session.new, { cwd });
      const prompt = () =>
        agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "test" }],
        });
      const idle = () =>
        updates.filter(
          (u) => u.sessionUpdate === "state_update" && "state" in u && u.state === "idle",
        );
      await prompt();
      await waitFor(() => idle().length === 1);
      expect(idle()[0]).toMatchObject({ stopReason: "end_turn" });
      nextCommand = command;
      await prompt();
      await waitFor(() => idle().length === 2);
      expect(idle()[1]).toMatchObject({ stopReason: "end_turn" });
      const failed = updates.find(
        (u) => u.sessionUpdate === "tool_call_update" && "status" in u && u.status === "failed",
      );
      if (failed) throw new Error(`Sandbox command failed: ${JSON.stringify(failed)}`);
      expect(await readFile(join(cwd, "marker"), "utf8")).toBe("unset");
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "cycle reply" },
        }),
      );
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "tool_call_update",
          status: "completed",
          kind: "execute",
        }),
      );
      expect(received.join("")).not.toContain("host-only-secret");
      // Plan mode goes to Codex as its experimental collaboration mode, with its settings, and the turn completes.
      const set = (value: string) =>
        agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: "mode",
          type: "id",
          value,
        } as never);
      await set("plan");
      await prompt();
      await waitFor(() => idle().length === 3);
      expect(idle()[2]).toMatchObject({ stopReason: "end_turn" });
      await set("default");
      // /compact runs as a turn of Codex's own: it ends like one, with its compaction begun and completed.
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/compact" }],
      });
      await waitFor(() => idle().length === 4);
      expect(idle()[3]).toMatchObject({ stopReason: "end_turn" });
      expect(
        updates
          .filter((u) => u.sessionUpdate === "compaction_update")
          .map((u) => (u as { status?: string }).status),
      ).toEqual(["in_progress", "completed"]);
      nextCommand = "touch running && sleep 10";
      hold = true;

      await prompt();
      await waitFor(() => existsSync(join(cwd, "running")));
      const steered = await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "finish the current work" }],
        _meta: { "cycle/steer": true },
      });
      expect(steered.messageId).toBeString();
      await agent.notify(methods.agent.session.cancel, { sessionId });
      await waitFor(() => idle().length === 5);
      expect(idle()[4]).toMatchObject({ stopReason: "cancelled" });
      await agent.request(methods.agent.session.close, { sessionId });
    });
  } finally {
    proc.stdin.end();
    await Promise.race([proc.exited, Bun.sleep(1500)]);
    proc.kill();
    await proc.exited;
    mock.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("an MCP gateway is reached with this launch's key, a resumed session with the next one, and the key is not kept", async () => {
  const dir = await mkdtemp(join(homedir(), ".cycle-test-codex-mcp-"));
  const cwd = join(dir, "project"),
    home = join(dir, "home");
  await mkdir(cwd);
  await mkdir(home);
  // A gateway that speaks MCP's streamable HTTP with plain JSON answers, and notes each request's key.
  const keys: string[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      keys.push(req.headers.get("authorization") ?? "");
      const msg = (await req.json()) as { id?: number; method: string; params?: any };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "gateway", version: "1" },
            }
          : msg.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "lookup",
                    description: "Look something up",
                    inputSchema: { type: "object", properties: {} },
                    annotations: { readOnlyHint: true },
                  },
                ],
              }
            : msg.method === "tools/call"
              ? { content: [{ type: "text", text: "found it" }] }
              : {};
      return Response.json({ jsonrpc: "2.0", id: msg.id, result });
    },
  });
  // The model calls the gateway's tool once per prompt, then answers.
  let callTool = false;
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (!new URL(req.url).pathname.endsWith("/responses"))
        return new Response(null, { status: 404 });
      const body = (await req.json()) as {
        tools?: { name?: string; type?: string; tools?: any[] }[];
      };
      if (!callTool) return response(false, "");
      callTool = false;
      const flat = (body.tools ?? []).flatMap((t) =>
        t.type === "namespace" ? (t.tools ?? []).map((n) => ({ ...n, ns: t.name })) : [t],
      ) as { name?: string; ns?: string }[];
      const tool = flat.find((t) => t.name?.includes("lookup"));
      if (!tool?.name) throw new Error(`No gateway tool offered: ${JSON.stringify(body.tools)}`);
      return response(true, "", { name: tool.name, namespace: tool.ns, args: {} });
    },
  });
  await writeFile(
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
  const executable = process.env.CYCLE_DAEMON_BIN;
  const entry = new URL("../../../../apps/daemon/src/main.ts", import.meta.url).pathname;
  const launch = () =>
    Bun.spawn([...(executable ? [executable] : [process.execPath, entry]), "adapter", "codex"], {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        CYCLE_ADAPTER_CONFIG: JSON.stringify({
          env: { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin" },
        }),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
  const gatewayServer = (key: string) => [
    {
      type: "http" as const,
      // Cycle's names are a person's; Codex's must be plain.
      name: "Cycle gateway",
      url: `http://127.0.0.1:${gateway.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${key}` }],
    },
  ];
  async function run(
    open: (agent: any) => Promise<string>,
    check: (updates: SessionUpdate[]) => void,
  ) {
    const proc = launch();
    const updates: SessionUpdate[] = [];
    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        proc.stdin.write(chunk);
        proc.stdin.flush();
      },
      close() {
        proc.stdin.end();
      },
    });
    const acp = client().onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });
    try {
      await acp.connectWith(ndJsonStream(input, proc.stdout), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "test", version: "1" },
        });
        const sessionId = await open(agent);
        callTool = true;
        await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "look it up" }],
        });
        for (let i = 0; i < 400; i++) {
          if (updates.some((u) => "state" in u && u.state === "idle" && "stopReason" in u)) break;
          await Bun.sleep(25);
        }
        check(updates);
      });
    } finally {
      proc.stdin.end();
      await Promise.race([proc.exited, Bun.sleep(1500)]);
      proc.kill();
      await proc.exited;
    }
    return updates;
  }
  const called = (updates: SessionUpdate[]) => {
    expect(updates).toContainEqual(
      expect.objectContaining({ sessionUpdate: "state_update", stopReason: "end_turn" }),
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: "tool_call_update",
        status: "completed",
        name: expect.stringContaining("lookup"),
      }),
    );
  };
  try {
    let sessionId = "";
    await run(async (agent) => {
      const opened = await agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: gatewayServer("key-first"),
      });
      sessionId = opened.sessionId;
      return sessionId;
    }, called);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set(["Bearer key-first"]));
    keys.length = 0;
    // The next launch has a key of its own: the resumed thread reaches the gateway with it, never the old one.
    await run(async (agent) => {
      await agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: gatewayServer("key-second"),
        _meta: { "cycle/hadTurn": true },
      });
      return sessionId;
    }, called);
    expect(new Set(keys)).toEqual(new Set(["Bearer key-second"]));
    const kept = Bun.spawnSync(["/usr/bin/grep", "-rl", "key-first\\|key-second", home]);
    expect(kept.stdout.toString()).toBe("");
  } finally {
    gateway.stop(true);
    mock.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
