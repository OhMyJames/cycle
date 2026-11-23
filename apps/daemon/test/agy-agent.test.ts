import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { agentsList } from "@cycle/protocol";
import { agyEnv, agyHarness, findAgyExecutable, isAgyVersionSupported } from "../src/agy-agent.ts";
import { ConfigSchema } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { agentsFor } from "../src/harnesses.ts";

const tempDirs: string[] = [];
const makeTemp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const makeFakeAgy = (dir: string, versionOutput: string, name = "agy"): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${versionOutput}"\n`);
  chmodSync(path, 0o755);
  return path;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("agy daemon harness", () => {
  test("agyEnv isolates HOME under <dataDir>/agy and never inherits host secrets or DBUS", () => {
    const config = ConfigSchema.parse({}).agy;
    const env = agyEnv(config, "/data", {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/real-user",
      TMPDIR: "/tmp",
      GEMINI_API_KEY: "host-gemini-secret",
      ANTHROPIC_API_KEY: "host-anthropic-secret",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp",
      HOME: "/data/agy",
    });
  });

  test("agyEnv honors explicit home and config.env overrides", () => {
    const config = ConfigSchema.parse({
      agy: {
        home: "/custom/agy-home",
        env: { GEMINI_API_KEY: "explicit-key" },
      },
    }).agy;
    const env = agyEnv(config, "/data", { PATH: "/bin", HOME: "/Users/real-user" });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/custom/agy-home",
      GEMINI_API_KEY: "explicit-key",
    });
  });

  test("findAgyExecutable follows config.executable -> ~/.local/bin/agy -> PATH", () => {
    const root = makeTemp("cycle-agy-find-");
    const hostHome = join(root, "home");
    const localBin = join(hostHome, ".local", "bin");
    const pathBin = join(root, "pathbin");
    const customBin = join(root, "custom");
    mkdirSync(localBin, { recursive: true });
    mkdirSync(pathBin, { recursive: true });
    mkdirSync(customBin, { recursive: true });

    const onPath = makeFakeAgy(pathBin, "1.5.15");
    expect(findAgyExecutable(ConfigSchema.parse({}).agy, { HOME: hostHome, PATH: pathBin })).toBe(
      onPath,
    );

    const inLocal = makeFakeAgy(localBin, "1.5.15");
    expect(findAgyExecutable(ConfigSchema.parse({}).agy, { HOME: hostHome, PATH: pathBin })).toBe(
      inLocal,
    );

    const explicit = makeFakeAgy(customBin, "1.5.15", "agy-custom");
    expect(
      findAgyExecutable(ConfigSchema.parse({ agy: { executable: explicit } }).agy, {
        HOME: hostHome,
        PATH: pathBin,
      }),
    ).toBe(explicit);

    // When config.executable is explicitly set to a missing file, do not silently fall back.
    expect(
      findAgyExecutable(
        ConfigSchema.parse({ agy: { executable: join(customBin, "missing") } }).agy,
        { HOME: hostHome, PATH: pathBin },
      ),
    ).toBeUndefined();
  });

  test("isAgyVersionSupported enforces 1.5.10 floor", () => {
    const binDir = makeTemp("cycle-agy-ver-");
    const oldBin = makeFakeAgy(binDir, "1.5.9", "agy-old");
    const okBin = makeFakeAgy(binDir, "1.5.10", "agy-ok");
    const newBin = makeFakeAgy(binDir, "1.5.15", "agy-new");
    expect(isAgyVersionSupported(oldBin, {})).toBe(false);
    expect(isAgyVersionSupported(okBin, {})).toBe(true);
    expect(isAgyVersionSupported(newBin, {})).toBe(true);
  });

  test("_cycle/agents/list includes agy and marks available false when missing or too old", async () => {
    const dataDir = makeTemp("cycle-agy-list-");
    const binDir = makeTemp("cycle-agy-bins-");
    const oldBin = makeFakeAgy(binDir, "1.5.9", "agy-old");
    const okBin = makeFakeAgy(binDir, "1.5.15", "agy-ok");

    // Connect to Daemon cleanly via in-process stream pair.
    const checkList = async (executable: string) => {
      const config = ConfigSchema.parse({ agy: { executable } });
      const daemon = await Daemon.start({
        dataDir: makeTemp("cycle-agy-daemon-"),
        agents: agentsFor(config, dataDir, { PATH: "/usr/bin:/bin" }, undefined, [agyHarness]),
      });
      const c2s = new TransformStream<Uint8Array, Uint8Array>();
      const s2c = new TransformStream<Uint8Array, Uint8Array>();
      const serverConn = daemon.accept(ndJsonStream(s2c.writable, c2s.readable));
      const app = client();
      const clientConn = app.connect(ndJsonStream(c2s.writable, s2c.readable));
      try {
        await clientConn.agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        const listed = await clientConn.agent.request(agentsList.name as never, {} as never);
        const agy = (
          listed as { agents: Array<{ id: string; available: boolean; steer?: boolean }> }
        ).agents.find((a) => a.id === "agy");
        return agy;
      } finally {
        clientConn.close();
        serverConn.close();
        await daemon.close();
      }
    };

    const missing = await checkList(join(binDir, "does-not-exist"));
    expect(missing?.id).toBe("agy");
    expect(missing?.available).toBe(false);
    expect(missing?.steer).toBe(true);

    const tooOld = await checkList(oldBin);
    expect(tooOld?.available).toBe(false);

    const ready = await checkList(okBin);
    expect(ready?.available).toBe(true);
  });
});
