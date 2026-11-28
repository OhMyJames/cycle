import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceManifests } from "./workspaces.ts";

test("workspace discovery follows the root manifest, including overlapping patterns", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-workspaces-"));
  try {
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({
        workspaces: { packages: ["extensions/*", "./extensions/active"] },
      }),
    );
    for (const dir of ["extensions/active", "packages/unlisted"]) {
      await Bun.write(join(root, dir, "package.json"), "{}");
    }
    expect(await workspaceManifests(root)).toEqual(["extensions/active/package.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace glob exclusions apply independently of order and allow explicit directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-workspace-excludes-"));
  try {
    for (const dir of [
      "kept",
      "hidden",
      "hidden/child",
      "hidden/explicit",
      "vendor/node_modules/other",
    ]) {
      await Bun.write(join(root, "plugins", dir, "package.json"), "{}");
    }
    const excluded = "!./plugins/hidden/**";
    for (const packages of [
      [excluded, "plugins/**", "plugins/hidden/explicit"],
      ["plugins/hidden/explicit", "plugins/**", excluded],
    ]) {
      await Bun.write(join(root, "package.json"), JSON.stringify({ workspaces: { packages } }));
      expect(await workspaceManifests(root)).toEqual([
        "plugins/hidden/explicit/package.json",
        "plugins/kept/package.json",
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
