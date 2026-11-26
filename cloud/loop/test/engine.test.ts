import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = readFile(new URL("../src/engine/engine.ts", import.meta.url), "utf8");

test("the engine stays under 600 lines", async () => {
  expect((await source).trimEnd().split("\n").length).toBeLessThanOrEqual(600);
});

test("the engine does not import the dev flow, the github port or the git port", async () => {
  const specs = [...(await source).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
    (m) => m[1] ?? "",
  );
  expect(specs.length).toBeGreaterThan(0);
  for (const s of specs) {
    expect(s).not.toMatch(/flows\/dev|ports\/github|ports\/git(\.ts)?$/);
  }
});
