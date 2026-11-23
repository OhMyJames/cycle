import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import {
  AGY_CONFIG_SCHEMA,
  AGY_PROMPT_CAPABILITIES,
  AgyRpcError,
  createAdapter,
} from "@cycle/harness-agy";
import { agentsList, CycleErrorCode, META } from "@cycle/protocol";
import {
  defaultInitResult,
  defaultSessionResponse,
  type FakeRequestHandler,
  FakeV1Agent,
} from "../../../harness/agy/test/fake-v1.ts";
import type { AgentDefinition } from "../src/agents.ts";
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

  test("agyHarness.cli configures `agy acp --login` with isolated HOME and config executable", () => {
    const binDir = makeTemp("cycle-agy-cli-");
    const customBin = makeFakeAgy(binDir, "1.5.15", "agy-custom");
    const config = ConfigSchema.parse({ agy: { executable: customBin } });
    expect(agyHarness.cli).toBeDefined();
    expect(agyHarness.cli?.login).toEqual(["acp", "--login"]);
    expect(agyHarness.cli?.directories).toEqual(["HOME"]);
    expect(
      agyHarness.cli?.executable({ config, dataDir: "/data", inherited: { PATH: "/usr/bin" } }),
    ).toBe(customBin);
    expect(
      agyHarness.cli?.env({
        config,
        dataDir: "/data",
        inherited: { PATH: "/usr/bin", HOME: "/Users/real", GEMINI_API_KEY: "secret" },
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/data/agy",
    });
  });

  test("daemon keeps Cycle sessionId distinct from agy agentSessionId across restart and maps missing hadTurn session to -32013 (CYCL-173)", async () => {
    const dataDir = makeTemp("cycle-agy-resume-data-");
    const workDir = makeTemp("cycle-agy-resume-work-");
    let mode: "normal" | "missing" = "normal";
    let nextNewId = 1;
    const seenResumes: string[] = [];
    const seenPrompts: string[] = [];

    const makeDef = (): AgentDefinition => ({
      id: "agy",
      name: "Antigravity",
      available: () => true,
      configSchema: AGY_CONFIG_SCHEMA,
      promptCapabilities: AGY_PROMPT_CAPABILITIES,
      steer: true,
      launch: async () => {
        const handler: FakeRequestHandler = (method, params) => {
          if (method === "initialize") return defaultInitResult("1.5.15");
          if (method === "session/new") return defaultSessionResponse(`agy-native-${nextNewId++}`);
          if (method === "session/resume") {
            const sid = (params as { sessionId: string }).sessionId;
            seenResumes.push(sid);
            if (mode === "missing") {
              throw new AgyRpcError(-32603, `Failed to read session ${sid}: no such file`);
            }
            const res = defaultSessionResponse(sid);
            const { sessionId: _omit, ...withoutId } = res;
            return withoutId;
          }
          if (method === "session/prompt") {
            seenPrompts.push((params as { sessionId: string }).sessionId);
            return { stopReason: "end_turn" };
          }
          return {};
        };
        const adapter = createAdapter({
          env: { HOME: join(dataDir, "agy") },
          agyExecutable: "/fake/agy",
          connect: (handlers) => new FakeV1Agent(handlers, handler),
        });
        return {
          target: adapter.app,
          kill: () => adapter.close(),
        };
      },
    });

    const withDaemon = async <T>(
      fn: (agent: ReturnType<ReturnType<typeof client>["connect"]>["agent"]) => Promise<T>,
    ) => {
      const daemon = await Daemon.start({ dataDir, agents: [makeDef()] });
      const c2s = new TransformStream<Uint8Array, Uint8Array>();
      const s2c = new TransformStream<Uint8Array, Uint8Array>();
      const serverConn = daemon.accept(ndJsonStream(s2c.writable, c2s.readable));
      const clientConn = client().connect(ndJsonStream(c2s.writable, s2c.readable));
      try {
        await clientConn.agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        return await fn(clientConn.agent);
      } finally {
        clientConn.close();
        serverConn.close();
        await daemon.close();
      }
    };

    // 1. Create two sessions: sWithTurn (has a turn) and sEmpty (0 turns).
    const { sWithTurn, sEmpty } = await withDaemon(async (agent) => {
      const a = (await agent.request(methods.agent.session.new, {
        cwd: workDir,
        _meta: { [META.agent]: "agy" },
      } as never)) as { sessionId: string };
      expect(a.sessionId).not.toBe("agy-native-1");
      await agent.request(methods.agent.session.prompt, {
        sessionId: a.sessionId,
        prompt: [{ type: "text", text: "turn 1" }],
      } as never);
      await Bun.sleep(30);

      const b = (await agent.request(methods.agent.session.new, {
        cwd: workDir,
        _meta: { [META.agent]: "agy" },
      } as never)) as { sessionId: string };
      return { sWithTurn: a.sessionId, sEmpty: b.sessionId };
    });

    // 2. Restart daemon: sWithTurn resumes using agy-native-1.
    await withDaemon(async (agent) => {
      await agent.request(methods.agent.session.prompt, {
        sessionId: sWithTurn,
        prompt: [{ type: "text", text: "turn 2" }],
      } as never);
      await Bun.sleep(30);
    });
    expect(seenResumes).toEqual(["agy-native-1"]);
    expect(seenPrompts).toEqual(["agy-native-1", "agy-native-1"]);

    // 3. Restart daemon with missing files:
    //    - sEmpty (hadTurn=false) falls back to session/new -> agy-native-3 and succeeds.
    //    - sWithTurn (hadTurn=true) fails with -32013 (ResumeFailed).
    mode = "missing";
    await withDaemon(async (agent) => {
      await agent.request(methods.agent.session.prompt, {
        sessionId: sEmpty,
        prompt: [{ type: "text", text: "first turn after missing empty session" }],
      } as never);
      await Bun.sleep(30);

      let caught: unknown;
      try {
        await agent.request(methods.agent.session.prompt, {
          sessionId: sWithTurn,
          prompt: [{ type: "text", text: "turn 3" }],
        } as never);
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: number })?.code).toBe(CycleErrorCode.ResumeFailed);
    });
    expect(seenPrompts.at(-1)).toBe("agy-native-3");
  });

  test("daemon caches agy model choices with efforts and reapplies mode/model/effort on restart (CYCL-174)", async () => {
    const dataDir = makeTemp("cycle-agy-cfg-data-");
    const workDir = makeTemp("cycle-agy-cfg-work-");
    const appliedSets: Array<{ configId: string; value: string }> = [];

    const makeDef = (): AgentDefinition => ({
      id: "agy",
      name: "Antigravity",
      available: () => true,
      configSchema: AGY_CONFIG_SCHEMA,
      promptCapabilities: AGY_PROMPT_CAPABILITIES,
      steer: true,
      launch: async () => {
        let model = "gemini-4-neon";
        let mode = "default";
        let thought = "high";
        const currentV1 = () =>
          (defaultSessionResponse("agy-cfg-1").configOptions ?? []).map((o) => {
            if (o.id === "model") return { ...o, currentValue: model };
            if (o.id === "mode") return { ...o, currentValue: mode };
            if (o.id === "thought_level") return { ...o, currentValue: thought };
            return o;
          });
        const handler: FakeRequestHandler = (method, params) => {
          if (method === "initialize") return defaultInitResult("1.5.15");
          if (method === "session/new") return defaultSessionResponse("agy-cfg-1");
          if (method === "session/resume") {
            // agy resets mode/model/thought_level to defaults on restart.
            model = "gemini-4-neon";
            mode = "default";
            thought = "high";
            const { sessionId: _omit, ...rest } = defaultSessionResponse("agy-cfg-1");
            return rest;
          }
          if (method === "session/set_config_option") {
            const p = params as { configId: string; value: string };
            appliedSets.push({ configId: p.configId, value: p.value });
            if (p.configId === "model") model = p.value;
            if (p.configId === "mode") mode = p.value;
            if (p.configId === "thought_level") thought = p.value;
            return { configOptions: currentV1() };
          }
          if (method === "session/prompt") return { stopReason: "end_turn" };
          return {};
        };
        const adapter = createAdapter({
          env: { HOME: join(dataDir, "agy") },
          agyExecutable: "/fake/agy",
          connect: (handlers) => new FakeV1Agent(handlers, handler),
        });
        return { target: adapter.app, kill: () => adapter.close() };
      },
    });

    const withDaemon = async <T>(
      fn: (agent: ReturnType<ReturnType<typeof client>["connect"]>["agent"]) => Promise<T>,
    ) => {
      const daemon = await Daemon.start({ dataDir, agents: [makeDef()] });
      const c2s = new TransformStream<Uint8Array, Uint8Array>();
      const s2c = new TransformStream<Uint8Array, Uint8Array>();
      const serverConn = daemon.accept(ndJsonStream(s2c.writable, c2s.readable));
      const clientConn = client().connect(ndJsonStream(c2s.writable, s2c.readable));
      try {
        await clientConn.agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        return await fn(clientConn.agent);
      } finally {
        clientConn.close();
        serverConn.close();
        await daemon.close();
      }
    };

    const sessionId = await withDaemon(async (agent) => {
      const created = (await agent.request(methods.agent.session.new, {
        cwd: workDir,
        _meta: {
          [META.agent]: "agy",
          [META.config]: { mode: "plan", model: "gemini-4-carbon", effort: "medium" },
        },
      } as never)) as { sessionId: string };
      // Check that `_cycle/agents/list` picked up live models + META.efforts into the cache.
      const listed = (await agent.request(agentsList.name as never, {} as never)) as {
        agents: Array<{
          id: string;
          configSchema: {
            properties: {
              model: {
                oneOf: Array<{ const: string; _meta?: Record<string, unknown> }>;
              };
            };
          };
        }>;
      };
      const agy = listed.agents.find((a) => a.id === "agy");
      const neon = agy?.configSchema.properties.model.oneOf.find(
        (c) => c.const === "gemini-4-neon",
      );
      expect(neon?._meta?.[META.efforts]).toEqual(["low", "medium", "high", "xhigh"]);
      await agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "turn 1" }],
      } as never);
      await Bun.sleep(30);
      return created.sessionId;
    });

    appliedSets.length = 0;

    // Restart daemon and send another prompt: saved mode/model/effort must be re-applied!
    await withDaemon(async (agent) => {
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "turn 2" }],
      } as never);
      await Bun.sleep(30);
    });

    expect(appliedSets).toContainEqual({ configId: "mode", value: "plan" });
    expect(appliedSets).toContainEqual({ configId: "model", value: "gemini-4-carbon" });
    expect(appliedSets).toContainEqual({ configId: "thought_level", value: "medium" });
  });
});
