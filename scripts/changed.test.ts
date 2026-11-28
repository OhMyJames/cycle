import { describe, expect, test } from "bun:test";
import { loadPackages, type Pkg, select } from "./changed.ts";

const pkgs: Pkg[] = [
  { name: "@x/protocol", dir: "packages/protocol", deps: [] },
  { name: "@x/client", dir: "packages/client", deps: ["@x/protocol"] },
  { name: "@x/desktop", dir: "apps/desktop", deps: ["@x/client"] },
  { name: "@x/other", dir: "packages/other", deps: [] },
];

describe("select", () => {
  test("a file in a package selects it and everything depending on it, transitively", () => {
    expect(select(["packages/protocol/src/a.ts"], pkgs)).toEqual({
      full: false,
      dirs: ["apps/desktop", "packages/client", "packages/protocol"],
    });
  });

  test("a leaf package selects only itself", () => {
    expect(select(["apps/desktop/src/a.ts"], pkgs)).toEqual({
      full: false,
      dirs: ["apps/desktop"],
    });
  });

  test("a directory name that merely shares a prefix is not the package", () => {
    expect(select(["packages/protocol-extra/a.ts"], pkgs)).toEqual({ full: false, dirs: [] });
  });

  test.each([
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "tsconfig.renderer.json",
    "biome.json",
    "bunfig.toml",
    ".github/workflows/ci.yml",
    "scripts/check.ts",
    "scripts/check-extra.ts",
    "scripts/boundaries.ts",
    "scripts/workspaces.ts",
  ])("%s selects everything", (file) => {
    expect(select([file, "packages/other/a.ts"], pkgs)).toEqual({ full: true });
  });

  test("a package's own package.json or tsconfig is not a root file", () => {
    expect(select(["packages/other/package.json", "packages/other/tsconfig.json"], pkgs)).toEqual({
      full: false,
      dirs: ["packages/other"],
    });
  });

  test("files outside every package and the full list select nothing", () => {
    expect(select(["docs/testing.md", "README.md", "scripts/changed.ts"], pkgs)).toEqual({
      full: false,
      dirs: [],
    });
    expect(select([], pkgs)).toEqual({ full: false, dirs: [] });
  });
});

test("loadPackages reads the real workspace and its reverse dependencies", async () => {
  const real = await loadPackages(new URL("..", import.meta.url).pathname);
  const protocol = real.find((p) => p.dir === "packages/protocol");
  expect(protocol).toBeDefined();
  const client = real.find((p) => p.dir === "packages/client");
  expect(client?.deps).toContain(protocol?.name ?? "");
});
