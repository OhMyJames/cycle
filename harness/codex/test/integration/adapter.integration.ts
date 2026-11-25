// Pinned native CLI, real ACP stdio, local Responses API. No credentials or real model.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  client,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";

import { response } from "./mock-responses.ts";

/** The agent side of a connection, as a test drives it. */
type Agent = Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];

test("the packaged adapter streams, executes a sandboxed command, interrupts and closes", async () => {
  // Under the home directory on purpose: the sandbox lets a command write the temp directory, and this test needs
  // `touch ../outside` to be refused. Tests that make no such claim use tmpdir() (CYC-277).
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
  const dir = await mkdtemp(join(tmpdir(), "cycle-test-codex-mcp-"));
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
      const msg = (await req.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
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
        tools?: { name?: string; type?: string; tools?: { name?: string }[] }[];
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
    open: (agent: Agent) => Promise<string>,
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

// A session on the owner's own models (docs/adapters/codex.md "自带模型"): a local Responses API stands for the daemon's gateway.
const OWN = {
  id: "acme/fast-1",
  name: "Fast 1",
  description: "Acme",
  efforts: [
    { id: "low", description: "" },
    { id: "high", description: "" },
    { id: "max", description: "" },
  ],
  defaultEffort: "low",
  images: false,
  contextWindow: 64_000,
  provider: { id: "acme", name: "Acme" },
};

test("a session that begins on one of the owner's models talks to the gateway with its token, keeps to the owner's models, and keeps the token from commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-test-codex-providers-"));
  const cwd = join(dir, "project"),
    home = join(dir, "home");
  await mkdir(cwd);
  await mkdir(home);
  let nextCommand: string | undefined;
  const seen: {
    auth: string | null;
    model: string;
    effort: string | null;
    tools: number;
    toolTypes: string[];
    namespaces: string[];
  }[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (!new URL(req.url).pathname.endsWith("/responses"))
        return new Response(null, { status: 404 });
      const body = JSON.parse(await req.text()) as {
        model: string;
        reasoning?: { effort?: string | null } | null;
        tools?: { type?: string; name?: string }[];
      };
      seen.push({
        auth: req.headers.get("authorization"),
        model: body.model,
        effort: body.reasoning?.effort ?? null,
        tools: body.tools?.length ?? 0,
        toolTypes: (body.tools ?? []).map((t) => t.type ?? ""),
        namespaces: (body.tools ?? [])
          .filter((t) => t.type === "namespace" && typeof t.name === "string")
          .map((t) => t.name as string),
      });
      if (nextCommand !== undefined) {
        const cmd = nextCommand;
        nextCommand = undefined;
        return response(true, cmd);
      }
      return response(false, "");
    },
  });
  const entry = new URL("../../../../apps/daemon/src/main.ts", import.meta.url).pathname;
  const executable = process.env.CYCLE_DAEMON_BIN;
  const proc = Bun.spawn(
    [...(executable ? [executable] : [process.execPath, entry]), "adapter", "codex"],
    {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        CYCLE_ADAPTER_CONFIG: JSON.stringify({
          env: { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin" },
          providers: {
            url: `http://127.0.0.1:${gateway.port}/v1`,
            token: "gw-token",
            models: [OWN],
          },
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
  const idle = () =>
    updates.filter((u) => u.sessionUpdate === "state_update" && "state" in u && u.state === "idle");
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
      const created = await agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/model": OWN.id },
      });
      const sessionId = created.sessionId;
      const model = (created.configOptions ?? []).find(
        (o) => o.configId === "model",
      ) as unknown as {
        options: { value: string; _meta?: Record<string, unknown> }[];
      };
      // Only the owner's models are the menu of this session, each marked with its provider.
      expect(model.options.filter((o) => o.value !== "default").map((o) => o.value)).toEqual([
        OWN.id,
      ]);
      expect(model.options.find((o) => o.value === OWN.id)?._meta).toMatchObject({
        "cycle/provider": OWN.provider,
        "cycle/efforts": ["low", "high", "max"],
      });
      const set = (configId: string, value: string) =>
        agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId,
          type: "id",
          value,
        } as never);
      await set("model", OWN.id);
      await expect(set("model", "gpt-5.4")).rejects.toThrow();
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      await waitFor(() => idle().length === 1);
      expect(idle()[0]).toMatchObject({ stopReason: "end_turn" });
      expect(seen[0]).toMatchObject({ auth: "Bearer gw-token", model: OWN.id });
      // Deferred tools stay behind `tool_search` instead of bloating the prompt with every namespace upfront.
      expect(seen[0]?.toolTypes).toContain("tool_search");
      expect(seen[0]?.namespaces).not.toContain("multi_agent_v1");
      expect(updates).toContainEqual(
        expect.objectContaining({ sessionUpdate: "usage_update", size: 60_800 }),
      );
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "cycle reply" },
        }),
      );
      // Codex hands its environment to the commands the agent runs: the gateway's token is not in it.
      await set("effort", "max");
      nextCommand =
        "if env | grep -q CYCLE_PROVIDER_TOKEN; then printf leaked > marker; else printf clean > marker; fi";
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "run it" }],
      });
      await waitFor(() => idle().length === 2);
      expect(seen.some((request) => request.effort === "max")).toBe(true);
      expect(await Bun.file(join(cwd, "marker")).text()).toBe("clean");
      await agent.request(methods.agent.session.close, { sessionId });
    });
  } finally {
    proc.stdin.end();
    await Promise.race([proc.exited, Bun.sleep(1500)]);
    proc.kill();
    await proc.exited;
    gateway.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("the workspace profile unlocks .agents/worktree and .agents/notes in repo and worktree sessions while keeping .agents/skills, .git, .codex, and denyRead protected", async () => {
  // Under the home directory on purpose: the sandbox leaves tmpdir writable, and this test verifies read-only rules.
  const dir = await mkdtemp(join(homedir(), ".cycle-test-codex-agents-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const wt = join(repo, ".agents", "worktree", "wt-1");
  const secretFile = join(dir, "secrets.env");
  const missingProviders = join(dir, "providers.json");
  await mkdir(home, { recursive: true });
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, ".codex"), { recursive: true });
  await mkdir(join(repo, ".agents", "notes"), { recursive: true });
  await mkdir(join(repo, ".agents", "skills"), { recursive: true });
  await mkdir(join(wt, ".agents", "notes"), { recursive: true });
  await mkdir(join(wt, ".agents", "skills"), { recursive: true });
  await writeFile(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt-1")}\n`);
  await mkdir(join(repo, ".git", "worktrees", "wt-1"), { recursive: true });
  await writeFile(secretFile, "VAULT_SECRET='top-secret'\n", { mode: 0o600 });

  let nextCommand: string | undefined;
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (!new URL(req.url).pathname.endsWith("/responses"))
        return new Response(null, { status: 404 });
      await req.text();
      const cmd = nextCommand;
      nextCommand = undefined;
      return cmd !== undefined ? response(true, cmd) : response(false, "");
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

  async function runCommand(sessionCwd: string, command: string) {
    const proc = Bun.spawn(
      [...(executable ? [executable] : [process.execPath, entry]), "adapter", "codex"],
      {
        cwd: sessionCwd,
        env: {
          PATH: "/usr/bin:/bin",
          CYCLE_ADAPTER_CONFIG: JSON.stringify({
            env: { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin" },
            denyRead: [secretFile, missingProviders],
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
    const acp = client()
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .onRequest(methods.client.session.requestPermission, () => ({
        outcome: { outcome: "selected", optionId: "deny" },
      }));
    const idle = () =>
      updates.filter(
        (u) => u.sessionUpdate === "state_update" && "state" in u && u.state === "idle",
      );
    try {
      await acp.connectWith(ndJsonStream(input, proc.stdout), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "test", version: "1" },
        });
        const { sessionId } = await agent.request(methods.agent.session.new, { cwd: sessionCwd });
        nextCommand = command;
        await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "check sandbox" }],
        });
        for (let i = 0; i < 400 && idle().length === 0; i++) await Bun.sleep(25);
        expect(idle()[0]).toMatchObject({ stopReason: "end_turn" });
        await agent.request(methods.agent.session.close, { sessionId });
      });
    } finally {
      proc.stdin.end();
      await Promise.race([proc.exited, Bun.sleep(1500)]);
      proc.kill();
      await proc.exited;
    }
    return updates;
  }

  try {
    // Scenario 1: cwd is the main repo.
    const repoResult = join(repo, "result.txt");
    await runCommand(
      repo,
      [
        `{`,
        `  touch "${join(wt, "created.txt")}" && echo wt=ALLOW || echo wt=DENY;`,
        `  touch "${join(repo, ".agents", "notes", "n.txt")}" && echo notes=ALLOW || echo notes=DENY;`,
        `  touch "${join(repo, ".agents", "skills", "s.txt")}" 2>/dev/null && echo skills=ALLOW || echo skills=DENY;`,
        `  touch "${join(repo, ".git", "g.txt")}" 2>/dev/null && echo git=ALLOW || echo git=DENY;`,
        `  touch "${join(repo, ".codex", "c.txt")}" 2>/dev/null && echo codex=ALLOW || echo codex=DENY;`,
        `  cat "${secretFile}" >/dev/null 2>&1 && echo secret=ALLOW || echo secret=DENY;`,
        `} > "${repoResult}"`,
      ].join(" "),
    );
    expect((await readFile(repoResult, "utf8")).trim().split("\n")).toEqual([
      "wt=ALLOW",
      "notes=ALLOW",
      "skills=DENY",
      "git=DENY",
      "codex=DENY",
      "secret=DENY",
    ]);
    // On Linux bubblewrap, nonexistent denyRead entries must never be materialized as 0-byte stubs on the host.
    expect(existsSync(missingProviders)).toBe(false);

    // Scenario 2: cwd is inside `.agents/worktree/wt-1`.
    const wtResult = join(wt, "result.txt");
    await runCommand(
      wt,
      [
        `{`,
        `  touch "${join(wt, "code.txt")}" && echo code=ALLOW || echo code=DENY;`,
        `  touch "${join(wt, ".agents", "notes", "wt-note.txt")}" && echo wt_notes=ALLOW || echo wt_notes=DENY;`,
        `  touch "${join(wt, ".agents", "skills", "s.txt")}" 2>/dev/null && echo wt_skills=ALLOW || echo wt_skills=DENY;`,
        `  touch "${join(wt, ".git")}" 2>/dev/null && echo wt_git=ALLOW || echo wt_git=DENY;`,
        `  touch "${join(repo, ".git", "g2.txt")}" 2>/dev/null && echo repo_git=ALLOW || echo repo_git=DENY;`,
        `  touch "${join(repo, ".codex", "c2.txt")}" 2>/dev/null && echo repo_codex=ALLOW || echo repo_codex=DENY;`,
        `  cat "${secretFile}" >/dev/null 2>&1 && echo secret=ALLOW || echo secret=DENY;`,
        `} > "${wtResult}"`,
      ].join(" "),
    );
    expect((await readFile(wtResult, "utf8")).trim().split("\n")).toEqual([
      "code=ALLOW",
      "wt_notes=ALLOW",
      "wt_skills=DENY",
      "wt_git=DENY",
      "repo_git=DENY",
      "repo_codex=DENY",
      "secret=DENY",
    ]);
  } finally {
    mock.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 45_000);

test("a command with more output than the adapter keeps still ends cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-test-codex-large-output-"));
  const cwd = join(dir, "project"),
    home = join(dir, "home");
  await mkdir(cwd);
  await mkdir(home);
  let nextCommand: string | undefined = "head -c 300000 /dev/zero | tr '\\0' x";
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (!new URL(req.url).pathname.endsWith("/responses"))
        return new Response(null, { status: 404 });
      if (nextCommand !== undefined) {
        const cmd = nextCommand;
        nextCommand = undefined;
        return response(true, cmd);
      }
      return response(false, "");
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
  const entry = new URL("../../../../apps/daemon/src/main.ts", import.meta.url).pathname;
  const proc = Bun.spawn([process.execPath, entry, "adapter", "codex"], {
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
    for (let i = 0; i < 600 && !predicate(); i++) await Bun.sleep(25);
    if (!predicate()) throw new Error(`Timed out, ACP updates: ${JSON.stringify(updates)}`);
  }
  try {
    await acp.connectWith(ndJsonStream(input, proc.stdout), async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
      });
      const { sessionId } = await agent.request(methods.agent.session.new, { cwd });
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "run the large command" }],
      });
      const idle = () =>
        updates.filter(
          (u) => u.sessionUpdate === "state_update" && "state" in u && u.state === "idle",
        );
      await waitFor(() => idle().length === 1);
      expect(idle()[0]).toMatchObject({ stopReason: "end_turn" });
      const completed = updates.find(
        (u) => u.sessionUpdate === "tool_call_update" && "status" in u && u.status === "completed",
      ) as { content?: { content?: { text?: string } }[] } | undefined;
      const output = completed?.content?.[0]?.content?.text ?? "";
      expect(output).toContain("earlier characters not shown");
      expect(output.length).toBeLessThanOrEqual(100_100);
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
}, 40_000);
