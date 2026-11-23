import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
});
