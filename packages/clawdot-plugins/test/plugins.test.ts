import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinPluginNames, MARKETPLACE_DIR, PLUGINS_DIR } from "../src/index.ts";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

test("there is at least one plugin, and the marketplace lists exactly the directories", () => {
  const names = builtinPluginNames();
  expect(names.length).toBeGreaterThan(0);
  const marketplace = json(join(MARKETPLACE_DIR, ".claude-plugin", "marketplace.json"));
  const listed = (marketplace.plugins as { name: string; source: string }[]).map((p) => p.name);
  expect(listed.sort()).toEqual(names);
  for (const plugin of marketplace.plugins as { name: string; source: string }[]) {
    expect(plugin.source).toBe(`./plugins/${plugin.name}`);
  }
});

for (const name of builtinPluginNames()) {
  test(`${name}: its manifest names it as its directory does and has a version`, () => {
    const manifest = json(join(PLUGINS_DIR, name, ".claude-plugin", "plugin.json"));
    expect(manifest.name).toBe(name);
    expect(String(manifest.version)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof manifest.description).toBe("string");
  });

  test(`${name}: each skill is a directory with a SKILL.md whose name is the directory's`, () => {
    const skills = join(PLUGINS_DIR, name, "skills");
    if (!existsSync(skills)) return;
    for (const skill of new Bun.Glob("*/SKILL.md").scanSync(skills)) {
      const dir = skill.split("/")[0];
      const head = readFileSync(join(skills, skill), "utf8").split("---")[1] ?? "";
      expect(head).toMatch(new RegExp(`^name: ${dir}$`, "m"));
      expect(head).toMatch(/^description: .+/m);
    }
  });
}
