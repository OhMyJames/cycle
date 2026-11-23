import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
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
const hasAgy = agyPath !== undefined && isAgyVersionSupported(agyPath, process.env);

describe("harness/agy integration (unauthenticated real agy acp)", () => {
  test.skipIf(!hasAgy)(
    "daemon launches real agy acp in isolated HOME and session/new returns -32000 Authentication required",
    async () => {
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
          [process.execPath, join(import.meta.dir, "../../../../apps/daemon/src/main.ts")],
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
    },
    30_000,
  );

  test.skipIf(!hasAgy)(
    "cycle login agy launches agy acp --login in isolated HOME and prints Google OAuth URL",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "cycle-agy-login-"));
      try {
        const proc = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "../../../../apps/daemon/src/main.ts"),
            "--data-dir",
            dataDir,
            "login",
            "agy",
          ],
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
    },
    25_000,
  );

  test.skipIf(!hasAgy)(
    "AgyPlugins installs, disables, enables, and uninstalls a local plugin in an isolated HOME (CYCL-179)",
    async () => {
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
    },
    30_000,
  );
});
