import { expect, test } from "bun:test";
import { CodexPlugins, withPluginEnabled } from "../src/plugins.ts";

test("the enabled switch of one plugin is written and nothing else of config.toml is touched", () => {
  const id = "basics@clawdot";
  expect(withPluginEnabled("", id, false)).toBe('[plugins."basics@clawdot"]\nenabled = false\n');
  const other = 'model = "x"\n\n[plugins."other@m"]\nenabled = true\n';
  expect(withPluginEnabled(other, id, false)).toBe(
    `${other}\n[plugins."basics@clawdot"]\nenabled = false\n`,
  );
  const mine = '[plugins."basics@clawdot"]\nenabled = true\n\n[other]\na = 1\n';
  expect(withPluginEnabled(mine, id, false)).toBe(
    '[plugins."basics@clawdot"]\nenabled = false\n\n[other]\na = 1\n',
  );
  expect(withPluginEnabled('[plugins."basics@clawdot"]\nfoo = 1\n[other]\n', id, true)).toBe(
    '[plugins."basics@clawdot"]\nenabled = true\nfoo = 1\n[other]\n',
  );
});

/** A `codex` that is a table of what it has and says. */
const fakeCodex = () => {
  const commands: string[] = [];
  const state = {
    marketplaces: [] as { name: string; root: string }[],
    installed: new Map<string, string>(),
  };
  const plugin = new CodexPlugins({
    executable: () => "/bin/codex",
    args: ["-c", "x=1"],
    env: { CODEX_HOME: "/tmp/does-not-matter-codex-home-test" },
    cwd: "/tmp",
    run: async (command) => {
      const args = command.slice(1).join(" ");
      commands.push(args);
      const rest = command.slice(command.indexOf("plugin") + 1);
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
      if (rest[0] === "marketplace" && rest[1] === "list") {
        return ok(
          JSON.stringify({
            marketplaces: state.marketplaces.map((m) => ({
              name: m.name,
              root: m.root,
              marketplaceSource: { sourceType: "local", source: m.root },
            })),
          }),
        );
      }
      if (rest[0] === "marketplace" && rest[1] === "add") {
        state.marketplaces.push({ name: "clawdot", root: rest[2] ?? "" });
        return ok();
      }
      if (rest[0] === "add") {
        state.installed.set(rest[1] ?? "", "1.0.0");
        return ok();
      }
      if (rest[0] === "list") {
        return ok(
          JSON.stringify({
            installed: [...state.installed].map(([id, version]) => ({
              pluginId: id,
              name: id.split("@")[0],
              marketplaceName: "clawdot",
              version,
              enabled: true,
            })),
            available: [],
          }),
        );
      }
      return { code: 1, stdout: "", stderr: "unrecognized subcommand", timedOut: false };
    },
  });
  return { plugin, commands, state };
};

test("what ships is added as a marketplace once and each plugin installed once", async () => {
  const { plugin, commands } = fakeCodex();
  const bundle = {
    root: "/shipped",
    marketplace: "clawdot",
    plugins: [{ name: "basics", version: "1.0.0", dir: "/shipped/plugins/basics" }],
  };
  await plugin.ensureBuiltin(bundle);
  await plugin.ensureBuiltin(bundle);
  expect(commands.filter((c) => c.includes("marketplace add"))).toHaveLength(1);
  expect(commands.filter((c) => c.endsWith("plugin add basics@clawdot"))).toHaveLength(1);
  expect(commands.every((c) => c.startsWith("-c x=1 plugin"))).toBe(true);
});
