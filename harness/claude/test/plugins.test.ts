import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudePluginError, ClaudePlugins, type RunCommand } from "../src/plugins.ts";

/**
 * Claude's command line as it answered on 2026-11-23 (2.1.327), replayed: what is read out of it, and what it is
 * asked. The real one is asked in test/integration/adapter.integration.ts.
 */
const scripted = (
  answers: Record<string, { stdout: string; code?: number; timedOut?: boolean }>,
) => {
  const calls: { args: string[]; env: Record<string, string>; cwd: string }[] = [];
  const run: RunCommand = async (command, options) => {
    const args = command.slice(1);
    calls.push({ args: [...args], env: options.env, cwd: options.cwd });
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    const answer = key !== undefined ? answers[key] : undefined;
    if (answer === undefined) throw new Error(`not scripted: ${args.join(" ")}`);
    return { code: answer.code ?? 0, stdout: answer.stdout, timedOut: answer.timedOut ?? false };
  };
  return { run, calls };
};

const make = (run: RunCommand, cwd = "/tmp/cycle-plugins-test-cwd") =>
  new ClaudePlugins({ executable: "/opt/claude", env: { PATH: "/bin", HOME: "/h" }, cwd, run });

test("what Claude lists becomes sources, installed plugins with what they bring, and what can be installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-v1-plugin-"));
  try {
    await mkdir(join(root, "skills", "hello"), { recursive: true });
    await mkdir(join(root, "commands"), { recursive: true });
    await mkdir(join(root, "hooks"), { recursive: true });
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(join(root, "skills", "hello", "SKILL.md"), "x");
    await writeFile(join(root, "commands", "greet.md"), "x");
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      '{"description":"Says so itself"}',
    );
    await writeFile(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "a" },
                { type: "command", command: "b" },
              ],
            },
          ],
        },
      }),
    );
    const { run, calls } = scripted({
      "plugin list --available": {
        stdout: JSON.stringify({
          installed: [
            {
              id: "demo@local-market",
              version: "1.0.0",
              scope: "user",
              enabled: true,
              installPath: root,
              mcpServers: {
                remote: {
                  type: "http",
                  url: "https://mcp.example.com/mcp",
                  headers: { Authorization: "Bearer ${TOKEN}" },
                },
                rooted: { type: "http", url: "${CLAUDE_PLUGIN_ROOT}/x" },
                local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] },
                defaulted: {
                  type: "http",
                  url: "https://x.example/mcp",
                  headers: { "X-Key": "${KEY:-none}" },
                },
              },
            },
            // The same one again, and one a folder installed for itself: neither is another plugin here.
            { id: "demo@local-market", scope: "user", enabled: true, installPath: root },
            { id: "theirs@local-market", version: "1.0.0", scope: "project", enabled: true },
          ],
          available: [
            {
              pluginId: "linear@anthropic-plugin-directory",
              name: "linear",
              description: "Issues",
              marketplaceName: "anthropic-plugin-directory",
            },
            {
              pluginId: "other@local-market",
              name: "other",
              marketplaceName: "local-market",
              version: "2.0.0",
            },
          ],
        }),
      },
      "plugin marketplace list": {
        stdout: JSON.stringify([
          { name: "local-market", source: "directory", path: "/srv/market" },
          { name: "team", source: "github", repo: "acme/plugins" },
        ]),
      },
    });
    const snapshot = await make(run).snapshot();

    // The directory Claude comes with is a source nobody added, and cannot be removed.
    expect(snapshot.sources).toEqual([
      {
        id: "anthropic-plugin-directory",
        name: "anthropic-plugin-directory",
        kind: "builtin",
        removable: false,
      },
      {
        id: "local-market",
        name: "local-market",
        kind: "directory",
        removable: true,
        location: "/srv/market",
      },
      { id: "team", name: "team", kind: "git", removable: true, location: "acme/plugins" },
    ]);
    expect(snapshot.installed).toEqual([
      {
        id: "demo@local-market",
        name: "demo",
        sourceId: "local-market",
        installed: true,
        description: "Says so itself",
        enabled: true,
        scope: "user",
        version: "1.0.0",
        contents: { skills: 1, commands: 1, agents: 0, hooks: 2, mcpServers: 4 },
        servers: [
          // A plain http server: one that can be served in Claude's place, under the name a session knows it by.
          {
            name: "remote",
            agentName: "plugin:demo:remote",
            http: {
              url: "https://mcp.example.com/mcp",
              headers: { Authorization: "Bearer ${TOKEN}" },
            },
          },
          // An address only Claude can work out, and a process: Claude's own to start.
          { name: "rooted", agentName: "plugin:demo:rooted" },
          { name: "local", agentName: "plugin:demo:local" },
          // A header with a form of variable only Claude expands: Claude's too.
          { name: "defaulted", agentName: "plugin:demo:defaulted" },
        ],
      },
    ]);
    expect(snapshot.available.map((p) => [p.id, p.installed])).toEqual([
      ["linear@anthropic-plugin-directory", false],
      ["other@local-market", false],
      ["demo@local-market", true],
    ]);

    // Asked as itself, with the environment it was given and nothing else, in the folder that is no project.
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "plugin list --available --json",
      "plugin marketplace list --json",
    ]);
    expect(calls[0]).toMatchObject({
      env: { PATH: "/bin", HOME: "/h" },
      cwd: "/tmp/cycle-plugins-test-cwd",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each change is Claude's own command for the person's own scope, never agreed to on the person's behalf", async () => {
  const ok = (extra: object = {}) => ({
    stdout: `Cloning…\n${JSON.stringify({ outcome: "ok", ...extra })}\n`,
  });
  const { run, calls } = scripted({
    "plugin install": ok(),
    "plugin uninstall": ok(),
    "plugin update": ok({ updateOutcome: "updated", oldVersion: "1", newVersion: "2" }),
    "plugin enable": ok(),
    "plugin disable": ok(),
    "plugin marketplace add": ok({ marketplace: "team" }),
    "plugin marketplace remove": ok(),
    "plugin marketplace update": ok(),
  });
  const plugins = make(run);
  await plugins.install("demo@local-market");
  await plugins.uninstall("demo@local-market");
  expect(await plugins.update("demo@local-market")).toEqual({ updated: true });
  await plugins.setEnabled("demo@local-market", true);
  await plugins.setEnabled("demo@local-market", false);
  // What a person typed is never read as an option.
  expect(await plugins.addSource("--evil")).toBe("team");
  await plugins.removeSource("team");
  await plugins.refreshSource();
  await plugins.refreshSource("team");
  const said = calls.map((c) => c.args.join(" "));
  expect(said).toEqual([
    "plugin install demo@local-market --scope user --json",
    "plugin uninstall demo@local-market --scope user --json",
    "plugin update demo@local-market --scope user --json",
    "plugin enable demo@local-market --scope user --json",
    "plugin disable demo@local-market --scope user --json",
    "plugin marketplace add --scope user --json -- --evil",
    "plugin marketplace remove --json -- team",
    "plugin marketplace update --json",
    "plugin marketplace update --json -- team",
  ]);
  // What is installed can be asked alone, without a source being asked.
  const quick = scripted({
    "plugin list --json": {
      stdout: JSON.stringify([{ id: "demo@local-market", scope: "user", enabled: false }]),
    },
  });
  expect(await make(quick.run).installed()).toMatchObject([
    { id: "demo@local-market", installed: true, enabled: false },
  ]);

  // An id that would be read as an option is no plugin: nothing is run.
  await expect(plugins.install("--scope=project")).rejects.toMatchObject({ reason: "not_found" });
  await expect(plugins.setEnabled("-y", true)).rejects.toMatchObject({ reason: "not_found" });
  expect(calls).toHaveLength(said.length);

  // A source that wants its own command run is not said yes to here.
  for (const line of said) expect(line).not.toMatch(/(^| )(-y|--yes|--accept-command)( |$)/);
});

test("a refusal is a fixed word and what Claude said; no answer in time, or no Claude, are their own", async () => {
  const failed = (failureCode: string, message: string) => ({
    code: 1,
    stdout: JSON.stringify({ outcome: "failed", failureCode, message }),
  });
  const reasonOf = async (answer: { stdout: string; code?: number; timedOut?: boolean }) => {
    const { run } = scripted({ "plugin install": answer });
    try {
      await make(run).install("x@y");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudePluginError);
      return [(error as ClaudePluginError).reason, (error as ClaudePluginError).detail];
    }
    throw new Error("it did not fail");
  };
  expect(await reasonOf(failed("not_found", "Plugin not found"))).toEqual([
    "not_found",
    "Plugin not found",
  ]);
  expect(await reasonOf(failed("needs_command_approval", "Shown"))).toEqual([
    "needs_command",
    "Shown",
  ]);
  expect(await reasonOf(failed("clone_failed", "No network"))).toEqual(["failed", "No network"]);
  expect(await reasonOf({ stdout: "", timedOut: true })).toEqual(["timeout", ""]);
  expect(await reasonOf({ stdout: "Segmentation fault" })).toEqual([
    "failed",
    "Segmentation fault",
  ]);

  // A listing that is not one is a failure, not an empty list.
  const odd = scripted({
    "plugin list --available": { stdout: "{}" },
    "plugin marketplace list": { stdout: "[]" },
  });
  await expect(make(odd.run).snapshot()).rejects.toMatchObject({ reason: "failed" });

  const gone: RunCommand = async () => {
    throw new Error("ENOENT");
  };
  await expect(make(gone).snapshot()).rejects.toMatchObject({ reason: "unavailable" });
});
