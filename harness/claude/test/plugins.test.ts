import { expect, test } from "bun:test";
import { emptyConfig } from "../src/config.ts";
import { CyclePlugins, OWNER_MARKETPLACE, type PluginCli, toCatalog } from "../src/plugins.ts";

const list = {
  installed: [{ id: "lint@market", version: "1.0.0", installPath: "/cycle/plugins/cache/lint" }],
  available: [
    { pluginId: "lint@market", name: "lint", marketplaceName: "market" },
    { pluginId: "docs@market", name: "docs", description: "Docs", marketplaceName: "market" },
  ],
};

/** A `claude plugin` that answers from a script, and remembers what it was asked. */
function fakeCli(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const asked: string[] = [];
  const cli: PluginCli = {
    async run(args) {
      const line = args.join(" ");
      asked.push(line);
      const answer = answers[line] ?? {};
      return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    },
  };
  return { cli, asked };
}

test("the catalog lists the owner's installs to turn off, and Cycle's marketplaces", () => {
  const catalog = toCatalog(
    [{ name: "market", source: "directory", path: "/m" }],
    list,
    [{ id: "fmt@theirs", name: "fmt", version: "2.0.0" }],
    { ...emptyConfig(), plugins: { "old@theirs": false, "lint@market": false } },
  );
  expect(catalog.marketplaces.map((market) => market.name)).toEqual([OWNER_MARKETPLACE, "market"]);
  const [owner, market] = catalog.marketplaces;
  // One turned off in Cycle is not loaded, so no process lists it: it is known from the configuration.
  expect(owner?.plugins.map((plugin) => [plugin.id, plugin.enabled])).toEqual([
    ["fmt@theirs", true],
    ["old@theirs", false],
  ]);
  expect(market?.path).toBe("/m");
  expect(market?.plugins.map((plugin) => [plugin.id, plugin.installed, plugin.enabled])).toEqual([
    ["docs@market", false, false],
    ["lint@market", true, false],
  ]);
});

test("Cycle installs in its own home, and leaves the owner's installs to their command line", async () => {
  const { cli, asked } = fakeCli({ "plugin list --json": { stdout: JSON.stringify(list) } });
  const plugins = new CyclePlugins(cli);
  await plugins.install("market", "docs");
  expect(asked).toEqual(["plugin install docs@market --json"]);
  await expect(plugins.install(OWNER_MARKETPLACE, "fmt")).rejects.toThrow("claude plugin install");
  await expect(plugins.uninstall("fmt@theirs")).rejects.toThrow("claude plugin uninstall");
  await plugins.uninstall("lint@market");
  expect(asked.at(-1)).toBe("plugin uninstall lint@market --json");
  await expect(plugins.addMarketplace("--evil")).rejects.toThrow("not a marketplace");
});

test("what is installed is read once, and again after a change", async () => {
  const { cli, asked } = fakeCli({ "plugin list --json": { stdout: JSON.stringify(list) } });
  const plugins = new CyclePlugins(cli);
  expect(await plugins.installed()).toEqual([
    { id: "lint@market", version: "1.0.0", path: "/cycle/plugins/cache/lint" },
  ]);
  await plugins.installed();
  expect(asked.filter((line) => line === "plugin list --json")).toHaveLength(1);
  await plugins.addMarketplace("owner/repo");
  await plugins.installed();
  expect(asked.filter((line) => line === "plugin list --json")).toHaveLength(2);
});

test("a failed command says what Claude Code said", async () => {
  const { cli } = fakeCli({
    "plugin install docs@market --json": {
      code: 1,
      stdout: '{"outcome":"error","message":"This plugin runs a command to install."}\n',
    },
    "plugin marketplace add x/y": { code: 1, stderr: "warming up\nrepository not found\n" },
  });
  const plugins = new CyclePlugins(cli);
  await expect(plugins.install("market", "docs")).rejects.toThrow("runs a command to install");
  await expect(plugins.addMarketplace("x/y")).rejects.toThrow("repository not found");
});
