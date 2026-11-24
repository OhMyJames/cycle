import { expect, test } from "bun:test";
import { builtinPlugins } from "../src/builtin-plugins.ts";

test("the plugins that ship with Cycle are the directories of packages/clawdot-plugins, with their versions", () => {
  const bundle = builtinPlugins();
  expect(bundle?.marketplace).toBe("clawdot");
  const basics = bundle?.plugins.find((plugin) => plugin.name === "clawdot-itsaplan");
  expect(basics?.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(basics?.dir).toBe(`${bundle?.root}/plugins/clawdot-itsaplan`);
});

test("a folder without plugins is no bundle", () => {
  expect(builtinPlugins("/nonexistent-cycle-plugins")).toBeUndefined();
});
