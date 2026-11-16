import { expect, test } from "bun:test";
import type { PluginInfo, PluginMarketplace } from "@cycle/protocol";
import { matchPlugins, orderMarketplaces } from "../src/lib/plugins.ts";

const plugin = (name: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({
  id: `${name}@m`,
  name,
  displayName: name,
  description: "",
  version: null,
  installed: false,
  enabled: false,
  available: true,
  unavailable: null,
  ...extra,
});
const market = (name: string, plugins: PluginInfo[]): PluginMarketplace => ({
  name,
  displayName: name,
  path: null,
  plugins,
});

test("what is installed comes first, then the small marketplaces before the large", () => {
  const big = market(
    "a-official",
    Array.from({ length: 50 }, (_, index) => plugin(`p${index}`)),
  );
  const added = market("z-mine", [plugin("one"), plugin("two")]);
  const used = market("m-used", [plugin("x", { installed: true })]);
  expect(orderMarketplaces([big, added, used]).map((each) => each.name)).toEqual([
    "m-used",
    "z-mine",
    "a-official",
  ]);
});

test("a search matches name and description, and installed plugins lead", () => {
  const all = [
    plugin("formatter", { description: "Formats code" }),
    plugin("linter", { description: "Finds problems" }),
    plugin("fmt-tools", { installed: true }),
  ];
  expect(matchPlugins(all, "", 2).shown.map((each) => each.name)).toEqual([
    "fmt-tools",
    "formatter",
  ]);
  expect(matchPlugins(all, "", 2).total).toBe(3);
  expect(matchPlugins(all, " PROBLEMS ", 10).shown.map((each) => each.name)).toEqual(["linter"]);
  expect(matchPlugins(all, "fmt", 10).total).toBe(1);
});
