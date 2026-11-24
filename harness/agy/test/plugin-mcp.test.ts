import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { createAdapter } from "../src/agent.ts";
import { AgyPlugins, type RunAgyPluginCommand } from "../src/plugins.ts";
import type { AdapterConfig } from "../src/server.ts";
import {
  defaultInitResult,
  defaultSessionResponse,
  type FakeRequestHandler,
  FakeV1Agent,
} from "./fake-v1.ts";

const config = (
  handler: FakeRequestHandler,
  extra: Partial<AdapterConfig>,
): { config: AdapterConfig; getFake: () => FakeV1Agent } => {
  let fake: FakeV1Agent | undefined;
  return {
    config: {
      env: { HOME: "/tmp/cycle-agy-test-home", PATH: "/usr/bin:/bin" },
      agyExecutable: "/usr/local/bin/agy",
      connect: (handlers) => {
        fake = new FakeV1Agent(handlers, handler);
        return fake;
      },
      ...extra,
    },
    getFake: () => {
      if (!fake) throw new Error("fake v1 agent was never created");
      return fake;
    },
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(5);
  }
};

describe("AgyPlugins.stdioServers", () => {
  test("reads the stdio servers of enabled plugins only, named <plugin>_<server>, with the plugin root filled in", async () => {
    const token = ["$", "{PLUGIN_ROOT}"].join("");
    const root = mkdtempSync(join(tmpdir(), "cycle-agy-plugin-mcp-"));
    try {
      const fast = join(root, "agy-fast");
      const off = join(root, "disabled");
      mkdirSync(fast, { recursive: true });
      mkdirSync(off, { recursive: true });
      writeFileSync(
        join(fast, "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            fast: {
              command: "node",
              args: [`${token}/dist/mcp-server.mjs`],
              env: { DATA: `${token}/data`, N: 1 },
              tools: { batch_search: { eager: true } },
            },
            remote: { type: "http", url: "https://example.test/mcp" },
          },
        }),
      );
      writeFileSync(
        join(off, "mcp_config.json"),
        JSON.stringify({ mcpServers: { x: { command: "node" } } }),
      );
      const run: RunAgyPluginCommand = async () => ({
        code: 0,
        stdout: JSON.stringify([
          { name: "agy-fast", enabled: true, path: fast },
          { name: "disabled", enabled: false, path: off },
          { name: "no-config", enabled: true, path: join(root, "missing") },
        ]),
        stderr: "",
        timedOut: false,
      });
      const plugins = new AgyPlugins({
        executable: () => "/usr/local/bin/agy",
        env: { HOME: join(root, "home"), PATH: "/usr/bin" },
        cwd: join(root, "cwd"),
        run,
      });
      expect(await plugins.stdioServers()).toEqual([
        {
          name: "agy-fast_fast",
          command: "node",
          args: [`${fast}/dist/mcp-server.mjs`],
          env: [{ name: "DATA", value: `${fast}/data` }],
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("brings no servers when agy cannot list plugins", async () => {
    const root = mkdtempSync(join(tmpdir(), "cycle-agy-plugin-mcp-"));
    try {
      const plugins = new AgyPlugins({
        executable: () => "/usr/local/bin/agy",
        env: { HOME: join(root, "home"), PATH: "/usr/bin" },
        cwd: join(root, "cwd"),
        run: async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false }),
      });
      expect(await plugins.stdioServers()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("plugin MCP servers in the adapter", () => {
  test("hands the enabled plugins' stdio servers to session/new and session/resume, after the session's own and never over one of the same name", async () => {
    const { config: adapterConfig, getFake } = config(
      (method) => {
        if (method === "initialize") return defaultInitResult("1.5.15");
        if (method === "session/new" || method === "session/resume")
          return defaultSessionResponse("agy-p1");
        return {};
      },
      {
        pluginServers: async () => [
          { name: "agy-fast_fast", command: "node", args: ["/p/dist/mcp-server.mjs"], env: [] },
          { name: "local-stdio", command: "/bin/false", args: [], env: [] },
        ],
      },
    );
    const adapter = createAdapter(adapterConfig);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        const own = [{ type: "stdio", name: "local-stdio", command: "/usr/bin/env", args: [] }];
        await agent.request(methods.agent.session.new, {
          cwd: "/tmp/work",
          mcpServers: own,
        } as never);
        const expected = [
          { name: "local-stdio", command: "/usr/bin/env", args: [], env: [] },
          { name: "agy-fast_fast", command: "node", args: ["/p/dist/mcp-server.mjs"], env: [] },
        ];
        const sent = (method: string) =>
          (
            getFake().requests.find((r) => r.method === method)?.params as
              | { mcpServers?: unknown[] }
              | undefined
          )?.mcpServers;
        expect(sent("session/new")).toEqual(expected);

        await agent.request(methods.agent.session.resume, {
          sessionId: "agy-p1",
          cwd: "/tmp/work",
          mcpServers: own,
        } as never);
        expect(sent("session/resume")).toEqual(expected);
      });
    } finally {
      adapter.close();
    }
  });

  test("offers 'always allow' for agy-fast's read-only tools but never for apply_edits or run_checks", async () => {
    const offered = new Map<string, string[]>();
    const names = [
      "mcp_agy-fast_fast_batch_search",
      "mcp_agy-fast_fast_apply_edits",
      "mcp_agy-fast_fast_run_checks",
    ];
    const { config: adapterConfig } = config(
      (method, params, fake) => {
        if (method === "initialize") return defaultInitResult("1.5.15");
        if (method === "session/new") return defaultSessionResponse("agy-p2");
        if (method === "session/prompt") {
          const sid = (params as { sessionId: string }).sessionId;
          return (async () => {
            for (const name of names) {
              const call = { toolCallId: `c_${name}`, name, kind: "other", title: name };
              fake.emitUpdate(sid, { sessionUpdate: "tool_call", ...call, status: "pending" });
              await fake.askClient("session/request_permission", {
                sessionId: sid,
                toolCall: { ...call, status: "pending" },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              });
            }
            return { stopReason: "end_turn" };
          })();
        }
        return {};
      },
      { pluginServers: async () => [] },
    );
    const adapter = createAdapter(adapterConfig);
    const updates: SessionUpdate[] = [];
    const app = client()
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        offered.set(
          (params as { title?: string }).title ?? "",
          (params.options as Array<{ kind: string }>).map((o) => o.kind),
        );
        return { outcome: { outcome: "selected", optionId: "allow" } } as never;
      });
    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-p2",
          prompt: [{ type: "text", text: "go" }],
        } as never);
        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );
      });
    } finally {
      adapter.close();
    }
    expect(offered.get(names[0] as string)).toContain("allow_always");
    expect(offered.get(names[1] as string)).not.toContain("allow_always");
    expect(offered.get(names[2] as string)).not.toContain("allow_always");
  });
});
