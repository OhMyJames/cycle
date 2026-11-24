import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("a plugin's assets/icon.svg is given as a data URL, small enough to send with the list", () => {
  const basics = builtinPlugins()?.plugins.find((plugin) => plugin.name === "clawdot-itsaplan");
  expect(basics?.icon).toStartWith("data:image/svg+xml;base64,");
  expect(basics?.icon?.length).toBeLessThan(100_000);
});

test("a plugin whose manifest does not name it as its folder does is left out: its id would be one nothing installs", async () => {
  const root = mkdtempSync(join(tmpdir(), "builtin-plugins-"));
  try {
    for (const [dir, name] of [
      ["right", "right"],
      ["wrong", "somethingelse"],
    ] as const) {
      mkdirSync(join(root, "plugins", dir, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(root, "plugins", dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name, version: "1.0.0" }),
      );
    }
    expect(builtinPlugins(root)?.plugins.map((p) => p.name)).toEqual(["right"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
