import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutable } from "../src/run.ts";

const dir = mkdtempSync(join(tmpdir(), "cycle-agy-run-"));
const onPath = join(dir, "agy");
writeFileSync(onPath, "#!/bin/sh\n");
chmodSync(onPath, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("finding agy in the adapter", () => {
  const env = { HOME: join(dir, "home") };

  test("falls back to PATH when none was configured", () => {
    expect(resolveExecutable({ env, agyExecutable: "" }, dir)).toBe(onPath);
  });

  test("an explicitly configured agy that is missing does not fall back to PATH", () => {
    const missing = join(dir, "missing", "agy");
    expect(
      resolveExecutable(
        { env, agyExecutable: "", fallbackExecutables: [missing], searchPath: false },
        dir,
      ),
    ).toBeUndefined();
  });
});
