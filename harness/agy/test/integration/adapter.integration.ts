import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  client,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import {
  agyHarness,
  findAgyExecutable,
  isAgyVersionSupported,
} from "../../../../apps/daemon/src/agy-agent.ts";
import { ConfigSchema } from "../../../../apps/daemon/src/config.ts";
import { Daemon } from "../../../../apps/daemon/src/daemon.ts";
import { agentsFor } from "../../../../apps/daemon/src/harnesses.ts";
import { AgyPlugins } from "../../src/plugins.ts";

const agyPath = findAgyExecutable(ConfigSchema.parse({}).agy, process.env);
const hasAgy = agyPath !== undefined && (await isAgyVersionSupported(agyPath, process.env));
const daemonMain = join(import.meta.dir, "../../../../apps/daemon/src/main.ts");

/** Create a fake `agy` executable speaking real ACP v1 over stdio NDJSON for CI-safe process tests. */
const writeFakeAgyBinary = (dir: string): string => {
  const scriptPath = join(dir, "fake-agy.ts");
  const binPath = join(dir, "agy");
  writeFileSync(
    scriptPath,
    `import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("1.5.15");
  process.exit(0);
}
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\\n");
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextReqId = 1;
const pending = new Map<number, (v: unknown) => void>();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.result);
    }
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Fake Agy", version: "1.5.15" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, additionalDirectories: {} },
          mcpCapabilities: { http: true },
        },
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "fake-agy-stdio-1",
        configOptions: [
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "auto", name: "Auto" },
            ],
          },
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gemini-4-neon",
            options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }],
          },
          {
            id: "thought_level",
            name: "Thinking Level",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const permId = nextReqId++;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          name: "run_command",
          kind: "execute",
          title: "check env",
          status: "pending",
        },
      },
    });
    pending.set(permId, (outcome) => {
      const envSummary = JSON.stringify({
        home: process.env.HOME ?? null,
        leakedSecret: process.env.CYCLE_TEST_HOST_SECRET ?? null,
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-1",
            name: "run_command",
            kind: "execute",
            title: "check env",
            status: "completed",
            rawOutput: { output: envSummary, exit_code: 0 },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ENV=" + envSummary + " OUTCOME=" + JSON.stringify(outcome) },
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });
    send({
      jsonrpc: "2.0",
      id: permId,
      method: "session/request_permission",
      params: {
        sessionId: sid,
        toolCall: { toolCallId: "tc-1", name: "run_command", kind: "execute", title: "check env", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    return;
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
`,
  );
  writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  chmodSync(binPath, 0o755);
  return binPath;
};

describe("harness/agy integration (real adapter child process over stdio)", () => {
  test("daemon spawns real `cycle adapter agy` child process, isolates env/HOME, approves permission, and completes turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "cycle-agy-proc-integ-"));
    const dataDir = join(root, "data");
    const workDir = join(root, "work");
    const binDir = join(root, "bin");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const fakeBin = writeFakeAgyBinary(binDir);

    const config = ConfigSchema.parse({
      agy: { executable: fakeBin, telemetry: false },
    });
    const daemon = await Daemon.start({
      dataDir,
      agents: agentsFor(
        config,
        dataDir,
        {
          PATH: process.env.PATH,
          HOME: "/Users/should-never-reach-agy",
          TMPDIR: process.env.TMPDIR,
          CYCLE_TEST_HOST_SECRET: "host-secret-must-not-leak",
        },
        undefined,
        [agyHarness],
        [process.execPath, daemonMain],
      ),
    });
    const c2s = new TransformStream<Uint8Array, Uint8Array>();
    const s2c = new TransformStream<Uint8Array, Uint8Array>();
    const serverConn = daemon.accept(ndJsonStream(s2c.writable, c2s.readable));
    const updates: SessionUpdate[] = [];
    const clientConn = client()
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .onRequest(methods.client.session.requestPermission, () => {
        return { outcome: { outcome: "selected", optionId: "allow" } } as never;
      })
      .connect(ndJsonStream(c2s.writable, s2c.readable));

    try {
      await clientConn.agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        capabilities: {},
        info: { name: "agy-proc-integ", version: "1" },
      });
      const created = (await clientConn.agent.request(methods.agent.session.new, {
        cwd: workDir,
        _meta: { [META.agent]: "agy" },
      } as never)) as { sessionId: string };
      await clientConn.agent.request(methods.agent.session.resume, {
        sessionId: created.sessionId,
        cwd: workDir,
      } as never);
      await clientConn.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "verify stdio child process" }],
      } as never);

      const deadline = Date.now() + 15_000;
      while (
        !updates.some(
          (u) => u.sessionUpdate === "state_update" && u.state === "idle" && "stopReason" in u,
        )
      ) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for turn to finish");
        await Bun.sleep(20);
      }

      const text = updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u as { content?: { text?: string } }).content?.text ?? "")
        .join("");
      expect(text).toContain(`"home":"${join(dataDir, "agy")}"`);
      expect(text).toContain('"leakedSecret":null');
      expect(text).toContain('"optionId":"allow"');
      expect(text).not.toContain("host-secret-must-not-leak");
    } finally {
      clientConn.close();
      serverConn.close();
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

if (hasAgy) {
  describe("harness/agy integration (real installed agy binary, unauthenticated)", () => {
    test("daemon launches real agy acp in isolated HOME and session/new returns -32000 Authentication required", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cycle-agy-integ-data-"));
      const workDir = mkdtempSync(join(tmpdir(), "cycle-agy-integ-work-"));
      const config = ConfigSchema.parse({
        agy: {
          executable: agyPath,
          telemetry: false,
        },
      });
      const daemon = await Daemon.start({
        dataDir,
        agents: agentsFor(
          config,
          dataDir,
          { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
          undefined,
          [agyHarness],
          [process.execPath, daemonMain],
        ),
      });
      const c2s = new TransformStream<Uint8Array, Uint8Array>();
      const s2c = new TransformStream<Uint8Array, Uint8Array>();
      const serverConn = daemon.accept(ndJsonStream(s2c.writable, c2s.readable));
      const clientConn = client().connect(ndJsonStream(c2s.writable, s2c.readable));
      try {
        await clientConn.agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "agy-integ", version: "1" },
        });
        let caught: unknown;
        try {
          await clientConn.agent.request(methods.agent.session.new, {
            cwd: workDir,
            _meta: { [META.agent]: "agy" },
          } as never);
        } catch (error) {
          caught = error;
        }
        expect((caught as { code?: number })?.code).toBe(-32000);
        expect(String((caught as { message?: string })?.message ?? "")).toContain(
          "cycle login agy",
        );
      } finally {
        clientConn.close();
        serverConn.close();
        await daemon.close();
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(workDir, { recursive: true, force: true });
      }
    }, 30_000);

    test("cycle login agy launches agy acp --login in isolated HOME and prints Google OAuth URL", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cycle-agy-login-"));
      try {
        const proc = Bun.spawn(
          [process.execPath, daemonMain, "--data-dir", dataDir, "login", "agy"],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
              TMPDIR: process.env.TMPDIR ?? tmpdir(),
            },
          },
        );
        let output = "";
        const decoder = new TextDecoder();
        const readStream = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              output += decoder.decode(value, { stream: true });
              if (output.includes("https://accounts.google.com/")) {
                proc.kill("SIGTERM");
                break;
              }
            }
          } finally {
            reader.releaseLock();
          }
        };
        const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
        try {
          await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
          await proc.exited;
        } finally {
          clearTimeout(timer);
        }
        expect(output).toContain("https://accounts.google.com/");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }, 25_000);

    test("AgyPlugins installs, disables, enables, and uninstalls a local plugin in an isolated HOME (CYCL-179)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cycle-agy-plug-integ-"));
      const home = join(root, "home");
      const cwd = join(root, "cwd");
      const plugDir = join(root, "demo-plugin");
      mkdirSync(join(plugDir, ".antigravity-plugin"), { recursive: true });
      mkdirSync(join(plugDir, "skills", "greet"), { recursive: true });
      writeFileSync(
        join(plugDir, ".antigravity-plugin", "plugin.json"),
        JSON.stringify({
          name: "demo-integ",
          version: "0.1.0",
          description: "Cycle integration test plugin",
        }),
      );
      writeFileSync(
        join(plugDir, "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            echoHttp: { type: "http", url: "http://127.0.0.1:9999/mcp" },
          },
        }),
      );
      writeFileSync(
        join(plugDir, "skills", "greet", "SKILL.md"),
        "---\nname: greet\ndescription: Say hi\n---\nSay hi\n",
      );

      const plugins = new AgyPlugins({
        executable: () => agyPath,
        env: { PATH: process.env.PATH ?? "", HOME: home },
        cwd,
      });

      try {
        expect(await plugins.installed()).toEqual([]);
        await plugins.install(plugDir);
        const afterInstall = await plugins.installed();
        expect(afterInstall).toHaveLength(1);
        expect(afterInstall[0]).toMatchObject({
          id: "demo-integ",
          name: "demo-integ",
          version: "0.1.0",
          description: "Cycle integration test plugin",
          enabled: true,
          contents: { skills: 1, mcpServers: 1 },
          servers: [{ name: "echoHttp", agentName: "echoHttp" }],
        });

        await plugins.setEnabled("demo-integ", false);
        expect((await plugins.installed())[0]?.enabled).toBe(false);

        await plugins.setEnabled("demo-integ", true);
        expect((await plugins.installed())[0]?.enabled).toBe(true);

        await plugins.uninstall("demo-integ");
        expect(await plugins.installed()).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30_000);
  });
}
