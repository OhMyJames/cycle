import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyPluginError, AgyPlugins, type RunAgyPluginCommand } from "../src/plugins.ts";

const tempDirs: string[] = [];
const makeTemp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("AgyPlugins unit tests (CYCL-179)", () => {
  test("parses agy plugin list --json, reads manifest description and mcp_config.json servers, and passes isolated env", async () => {
    const root = makeTemp("cycle-agy-plug-unit-");
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    const installedPath = join(home, ".gemini", "config", "plugins", "demo-probe");
    mkdirSync(join(installedPath, ".antigravity-plugin"), { recursive: true });
    writeFileSync(
      join(installedPath, ".antigravity-plugin", "plugin.json"),
      JSON.stringify({ name: "demo-probe", version: "1.2.3", description: "From manifest" }),
    );
    writeFileSync(
      join(installedPath, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          tracker: { type: "http", url: "https://tracker.example/mcp" },
        },
      }),
    );

    const calls: Array<{ cmd: readonly string[]; env: Record<string, string>; cwd: string }> = [];
    const run: RunAgyPluginCommand = async (command, options) => {
      calls.push({ cmd: command, env: options.env, cwd: options.cwd });
      if (command[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              name: "demo-probe",
              enabled: true,
              version: "1.2.3",
              source: "antigravity",
              path: installedPath,
              skills: ["greet", "lint"],
            },
          ]),
          stderr: "",
          timedOut: false,
        };
      }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };

    const plugins = new AgyPlugins({
      executable: () => "/usr/local/bin/agy",
      env: { PATH: "/usr/bin:/bin", HOME: home },
      cwd,
      run,
    });

    const snap = await plugins.snapshot();
    expect(snap.sources).toEqual([]);
    expect(snap.available).toEqual([]);
    expect(snap.installed).toEqual([
      {
        id: "demo-probe",
        name: "demo-probe",
        description: "From manifest",
        version: "1.2.3",
        sourceId: "antigravity",
        installed: true,
        enabled: true,
        scope: "user",
        contents: { skills: 2, commands: 0, agents: 0, hooks: 0, mcpServers: 1 },
        servers: [{ name: "tracker", agentName: "tracker" }],
      },
    ]);

    await plugins.install("/tmp/local-plugin");
    await plugins.setEnabled("demo-probe", false);
    await plugins.setEnabled("demo-probe", true);
    await plugins.uninstall("demo-probe");

    expect(calls.map((c) => c.cmd)).toEqual([
      ["/usr/local/bin/agy", "plugin", "list", "--json"],
      ["/usr/local/bin/agy", "plugin", "install", "/tmp/local-plugin"],
      ["/usr/local/bin/agy", "plugin", "disable", "demo-probe"],
      ["/usr/local/bin/agy", "plugin", "enable", "demo-probe"],
      ["/usr/local/bin/agy", "plugin", "uninstall", "demo-probe"],
    ]);
    for (const call of calls) {
      expect(call.env).toEqual({ PATH: "/usr/bin:/bin", HOME: home });
      expect(call.cwd).toBe(cwd);
    }
  });

  test("maps not_found, timeout, missing binary, and unsupported source/update actions to AgyPluginError", async () => {
    const root = makeTemp("cycle-agy-plug-err-");
    const cwd = join(root, "cwd");

    const missing = new AgyPlugins({
      executable: () => undefined,
      env: { HOME: join(root, "home") },
      cwd,
    });
    await expect(missing.installed()).rejects.toMatchObject({ reason: "unavailable" });

    let mode: "not_found" | "timeout" = "not_found";
    const plugins = new AgyPlugins({
      executable: () => "/usr/bin/agy",
      env: { HOME: join(root, "home") },
      cwd,
      run: async () =>
        mode === "not_found"
          ? {
              code: 1,
              stdout: "",
              stderr: 'Error: plugin "nope" not found or invalid',
              timedOut: false,
            }
          : { code: null, stdout: "", stderr: "", timedOut: true },
    });

    await expect(plugins.setEnabled("nope", false)).rejects.toMatchObject({
      name: "AgyPluginError",
      reason: "not_found",
    });

    mode = "timeout";
    await expect(plugins.installed()).rejects.toBeInstanceOf(AgyPluginError);
    await expect(plugins.installed()).rejects.toMatchObject({ reason: "timeout" });

    await expect(plugins.update("demo")).rejects.toMatchObject({ reason: "unavailable" });
    await expect(plugins.addSource("https://example.com")).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(plugins.removeSource("src")).rejects.toMatchObject({ reason: "unavailable" });
    await expect(plugins.refreshSource("src")).rejects.toMatchObject({ reason: "unavailable" });
  });
});

describe("AgyPlugins arguments", () => {
  test("a name that agy would read as one of its options is refused before agy runs", async () => {
    const root = makeTemp("cycle-agy-plug-arg-");
    let ran = false;
    const plugins = new AgyPlugins({
      executable: () => "/usr/bin/agy",
      env: { HOME: join(root, "home") },
      cwd: join(root, "cwd"),
      run: async () => {
        ran = true;
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    for (const attempt of [
      () => plugins.install("--help"),
      () => plugins.uninstall("-f"),
      () => plugins.setEnabled(" ", true),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AgyPluginError);
      expect((error as AgyPluginError).reason).toBe("not_found");
    }
    expect(ran).toBe(false);
  });
});
