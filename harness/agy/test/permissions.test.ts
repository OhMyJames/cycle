import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { client, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import { createAdapter } from "../src/agent.ts";
import {
  agySettingsPath,
  TOOL_PERMISSIONS,
  withSettingsLock,
  writeManagedSettings,
} from "../src/permissions.ts";
import type { AdapterConfig } from "../src/server.ts";
import { AGY_CONFIG_SCHEMA } from "../src/settings.ts";
import {
  defaultInitResult,
  defaultSessionResponse,
  type FakeRequestHandler,
  FakeV1Agent,
} from "./fake-v1.ts";

const roots: string[] = [];
const tempHome = () => {
  const home = mkdtempSync(join(tmpdir(), "agy-perm-"));
  roots.push(home);
  return home;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const readSettings = async (home: string) =>
  JSON.parse(await readFile(agySettingsPath(home), "utf8")) as Record<string, unknown>;

describe("writeManagedSettings", () => {
  test("creates the file at 0600 with only the managed key", async () => {
    const path = agySettingsPath(tempHome());
    await writeManagedSettings(path, { toolPermission: "request-review" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ toolPermission: "request-review" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("changes toolPermission and keeps every other key, nested ones too", async () => {
    const path = agySettingsPath(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    const user = {
      agentMode: "plan",
      showThinking: true,
      toolPermission: "strict",
      permissions: { allow: ["command(git)"], deny: ["command(sudo)"] },
    };
    writeFileSync(path, JSON.stringify(user));
    await writeManagedSettings(path, { toolPermission: "always-proceed" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...user,
      toolPermission: "always-proceed",
    });
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("does not rewrite a file that already has the value", async () => {
    const path = agySettingsPath(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    const text = '{"toolPermission":"strict","a":1}';
    writeFileSync(path, text);
    await writeManagedSettings(path, { toolPermission: "strict" });
    expect(await readFile(path, "utf8")).toBe(text);
  });

  test("refuses a file that is not a JSON object and leaves it as it was", async () => {
    const path = agySettingsPath(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    for (const text of ["{oops", "[1]", "3"]) {
      writeFileSync(path, text);
      await expect(writeManagedSettings(path, { toolPermission: "strict" })).rejects.toThrow(
        /not (valid JSON|a JSON object)/,
      );
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });
});

describe("withSettingsLock", () => {
  test("runs one holder at a time and releases the lock, even after a failure", async () => {
    const path = agySettingsPath(tempHome());
    const order: string[] = [];
    const hold = (name: string, ms: number) =>
      withSettingsLock(path, async () => {
        order.push(`${name}:in`);
        await Bun.sleep(ms);
        order.push(`${name}:out`);
      });
    await Promise.all([hold("a", 60), hold("b", 1)]);
    // Whoever gets in first, the other waits for it to leave.
    expect(order[1]?.endsWith(":out")).toBe(true);
    expect(order[0]?.split(":")[0]).toBe(order[1]?.split(":")[0]);
    expect(order).toHaveLength(4);
    await expect(
      withSettingsLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("takes over a lock a dead process left behind", async () => {
    const path = agySettingsPath(tempHome());
    mkdirSync(`${path}.lock`, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(`${path}.lock`, old, old);
    expect(await withSettingsLock(path, async () => "ok")).toBe("ok");
  });
});

describe("the Approvals option", () => {
  test("the schema offers the four levels and marks only always-proceed dangerous", () => {
    const options = AGY_CONFIG_SCHEMA.properties.toolPermission.oneOf as readonly {
      const: string;
      _meta?: Record<string, unknown>;
    }[];
    expect(options.map((o) => o.const)).toEqual([
      "request-review",
      "proceed-in-sandbox",
      "strict",
      "always-proceed",
    ]);
    expect(options.filter((o) => o._meta?.[META.danger] === true).map((o) => o.const)).toEqual([
      "always-proceed",
    ]);
    expect(AGY_CONFIG_SCHEMA.properties.toolPermission.default).toBe("request-review");
    expect(TOOL_PERMISSIONS).toHaveLength(4);
  });
});

type Harness = { home: string; fake: () => FakeV1Agent; config: AdapterConfig };

const harness = (
  handler: FakeRequestHandler,
  extra: Partial<AdapterConfig> = {},
  home = tempHome(),
): Harness => {
  let fake: FakeV1Agent | undefined;
  const config: AdapterConfig = {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    agyExecutable: "/usr/local/bin/agy",
    connect: (handlers) => {
      fake = new FakeV1Agent(handlers, handler);
      return fake;
    },
    ...extra,
  };
  return {
    home,
    config,
    fake: () => {
      if (!fake) throw new Error("fake v1 agent was never created");
      return fake;
    },
  };
};

type Option = { configId: string; currentValue: string };
const optionValue = (options: readonly Option[], id: string) =>
  options.find((o) => o.configId === id)?.currentValue;

const init = (agent: { request: (m: never, p: never) => Promise<unknown> }) =>
  agent.request(
    methods.agent.initialize as never,
    {
      protocolVersion: 2,
      capabilities: {},
      info: { name: "test", version: "1" },
    } as never,
  );

describe("a session's tool permission", () => {
  test("a new session starts under request-review, written before agy creates the worker", async () => {
    const seenAtCreate: unknown[] = [];
    const h = harness(async (method) => {
      if (method === "initialize") return defaultInitResult("1.5.16");
      if (method === "session/new") {
        seenAtCreate.push(await readSettingsOrNull(h.home));
        return defaultSessionResponse("agy-1");
      }
      return {};
    });
    const adapter = createAdapter(h.config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await init(agent as never);
        const created = (await agent.request(methods.agent.session.new, {
          cwd: "/tmp/work",
        } as never)) as { configOptions: Option[] };
        expect(optionValue(created.configOptions, "toolPermission")).toBe("request-review");
      });
      expect(seenAtCreate).toEqual([{ toolPermission: "request-review" }]);
    } finally {
      adapter.close();
    }
  });

  test("skipPermissions starts sessions under always-proceed and keeps the user's own keys", async () => {
    const home = tempHome();
    mkdirSync(dirname(agySettingsPath(home)), { recursive: true });
    writeFileSync(agySettingsPath(home), JSON.stringify({ showThinking: true }));
    const h = harness(
      (method) =>
        method === "initialize" ? defaultInitResult("1.5.16") : defaultSessionResponse(),
      { skipPermissions: true },
      home,
    );
    const adapter = createAdapter(h.config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await init(agent as never);
        const created = (await agent.request(methods.agent.session.new, {
          cwd: "/tmp/work",
        } as never)) as { configOptions: Option[] };
        expect(optionValue(created.configOptions, "toolPermission")).toBe("always-proceed");
      });
      expect(await readSettings(home)).toEqual({
        showThinking: true,
        toolPermission: "always-proceed",
      });
    } finally {
      adapter.close();
    }
  });

  test("changing it closes the worker, resumes the session under the new level, and puts the mode back", async () => {
    const levelAtResume: unknown[] = [];
    let resumedOnce = false;
    const h = harness(async (method) => {
      if (method === "initialize") return defaultInitResult("1.5.16");
      if (method === "session/new") {
        return {
          ...defaultSessionResponse("agy-1"),
          configOptions: modeOptions("default"),
        };
      }
      if (method === "session/resume") {
        levelAtResume.push((await readSettingsOrNull(h.home))?.toolPermission);
        resumedOnce = true;
        // agy's resumed worker starts in its own default mode again.
        return { ...defaultSessionResponse("agy-1"), configOptions: modeOptions("default") };
      }
      if (method === "session/set_config_option") return { configOptions: modeOptions("auto") };
      return {};
    });
    const adapter = createAdapter(h.config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await init(agent as never);
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        const changed = (await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-1",
          configId: "toolPermission",
          type: "id",
          value: "always-proceed",
        } as never)) as { configOptions: Option[] };
        expect(optionValue(changed.configOptions, "toolPermission")).toBe("always-proceed");
      });
      expect(resumedOnce).toBe(true);
      expect(levelAtResume).toEqual(["always-proceed"]);
      const methodsSeen = h.fake().requests.map((r) => r.method);
      expect(methodsSeen.indexOf("session/close")).toBeLessThan(
        methodsSeen.indexOf("session/resume"),
      );
      expect(await readSettings(h.home)).toEqual({ toolPermission: "always-proceed" });
    } finally {
      adapter.close();
    }
  });

  test("choosing the level it already has does not touch agy", async () => {
    const h = harness((method) =>
      method === "initialize" ? defaultInitResult("1.5.16") : defaultSessionResponse("agy-1"),
    );
    const adapter = createAdapter(h.config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await init(agent as never);
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-1",
          configId: "toolPermission",
          type: "id",
          value: "request-review",
        } as never);
      });
      expect(h.fake().requests.map((r) => r.method)).not.toContain("session/resume");
    } finally {
      adapter.close();
    }
  });

  test("an unknown level is refused", async () => {
    const h = harness((method) =>
      method === "initialize" ? defaultInitResult("1.5.16") : defaultSessionResponse("agy-1"),
    );
    const adapter = createAdapter(h.config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await init(agent as never);
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        let caught: unknown;
        try {
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: "agy-1",
            configId: "toolPermission",
            type: "id",
            value: "yolo",
          } as never);
        } catch (error) {
          caught = error;
        }
        expect((caught as { code?: number })?.code).toBe(-32602);
      });
    } finally {
      adapter.close();
    }
  });

  test("a change made during a turn shows at once and is applied before the next turn", async () => {
    let finishPrompt: ((value: unknown) => void) | undefined;
    const resumes: unknown[] = [];
    const h = harness(async (method) => {
      if (method === "initialize") return defaultInitResult("1.5.16");
      if (method === "session/new") return defaultSessionResponse("agy-1");
      if (method === "session/resume") {
        resumes.push((await readSettingsOrNull(h.home))?.toolPermission);
        return defaultSessionResponse("agy-1");
      }
      if (method === "session/prompt") {
        return new Promise((resolve) => {
          finishPrompt = resolve;
        });
      }
      return {};
    });
    const adapter = createAdapter(h.config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await init(agent as never);
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        const first = agent.request(methods.agent.session.prompt, {
          sessionId: "agy-1",
          prompt: [{ type: "text", text: "go" }],
        } as never);
        await first;
        const during = (await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-1",
          configId: "toolPermission",
          type: "id",
          value: "strict",
        } as never)) as { configOptions: Option[] };
        expect(optionValue(during.configOptions, "toolPermission")).toBe("strict");
        expect(resumes).toEqual([]);
        finishPrompt?.({ stopReason: "end_turn" });
        await Bun.sleep(30);
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-1",
          prompt: [{ type: "text", text: "again" }],
        } as never);
        expect(resumes).toEqual(["strict"]);
      });
    } finally {
      adapter.close();
    }
  });

  test("a settings file that cannot be read stops the session from starting", async () => {
    const home = tempHome();
    mkdirSync(dirname(agySettingsPath(home)), { recursive: true });
    writeFileSync(agySettingsPath(home), "{oops");
    const h = harness(
      (method) =>
        method === "initialize" ? defaultInitResult("1.5.16") : defaultSessionResponse(),
      {},
      home,
    );
    const adapter = createAdapter(h.config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await init(agent as never);
        let caught: unknown;
        try {
          await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        } catch (error) {
          caught = error;
        }
        expect((caught as { message?: string })?.message).toMatch(/tool permission/);
        expect(h.fake().requests.map((r) => r.method)).not.toContain("session/new");
      });
      expect(await readFile(agySettingsPath(home), "utf8")).toBe("{oops");
    } finally {
      adapter.close();
    }
  });
});

const readSettingsOrNull = async (home: string) =>
  readSettings(home).catch(() => null) as Promise<Record<string, unknown> | null>;

const modeOptions = (current: string) => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: current,
    options: [
      { value: "default", name: "Default" },
      { value: "auto", name: "Auto" },
    ],
  },
];
