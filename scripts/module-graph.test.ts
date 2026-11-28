import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstCycle, moduleGraph } from "./module-graph.ts";

test("a shared dependency can be visited twice; a cycle names the closing edge", () => {
  const graph = new Map([
    ["app", ["left", "right"]],
    ["left", ["common"]],
    ["right", ["common"]],
    ["common", []],
  ]);
  expect(firstCycle(graph)).toBeUndefined();
  graph.set("common", ["left"]);
  expect(firstCycle(graph)).toEqual(["left", "common", "left"]);
});

test("workspace production modules have no circular runtime imports", async () => {
  const graph = await moduleGraph(new URL("..", import.meta.url).pathname);
  expect(graph.size).toBeGreaterThan(0);
  expect(firstCycle(graph)).toBeUndefined();
});

test("resolves workspace exports and literal lazy imports, omitting type-only edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-module-graph-"));
  try {
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ workspaces: { packages: ["modules/*"] } }),
    );
    for (const name of ["app", "lib"]) {
      await Bun.write(
        join(root, "modules", name, "package.json"),
        JSON.stringify({ name, exports: "./src/index.ts" }),
      );
    }
    await mkdir(join(root, "node_modules"));
    await symlink(join(root, "modules/lib"), join(root, "node_modules/lib"));
    await Bun.write(
      join(root, "modules/app/src/index.ts"),
      'import { value } from "lib"; export { value };',
    );
    await Bun.write(
      join(root, "modules/lib/src/index.ts"),
      'import type { Item } from "./types"; export const value = () => import("./lazy.tsx");',
    );
    await Bun.write(join(root, "modules/lib/src/types.ts"), "export type Item = string;");
    // A checked-in helper outside src can close a cycle back into a production entry.
    await Bun.write(
      join(root, "modules/lib/src/lazy.tsx"),
      'import "../../../shared/helper.ts"; export const node = <p>Hello</p>;',
    );
    await Bun.write(join(root, "shared/helper.ts"), 'import "../modules/app/src/index.ts";');
    await Bun.write(join(root, "shared/unused.ts"), "export const ignored = 1;");
    const graph = await moduleGraph(root);
    expect(graph.get("modules/app/src/index.ts")).toEqual(["modules/lib/src/index.ts"]);
    expect(graph.get("modules/lib/src/index.ts")).toEqual(["modules/lib/src/lazy.tsx"]);
    expect(graph.get("shared/helper.ts")).toEqual(["modules/app/src/index.ts"]);
    expect(graph.has("shared/unused.ts")).toBe(false);
    expect(firstCycle(graph)).toEqual([
      "modules/app/src/index.ts",
      "modules/lib/src/index.ts",
      "modules/lib/src/lazy.tsx",
      "shared/helper.ts",
      "modules/app/src/index.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
