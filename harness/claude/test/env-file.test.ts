import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFileText, sessionEnvFile, shellWord } from "../src/env-file.ts";

test("a value is one shell word with nothing expanded, a quote included", () => {
  expect(shellWord("a b $HOME `x` \\n")).toBe("'a b $HOME `x` \\n'");
  expect(shellWord("it's")).toBe("'it'\\''s'");
  // What the shell makes of it is the value as it was.
  const out = Bun.spawnSync([
    "/bin/sh",
    "-c",
    `printf %s ${shellWord("it's $HOME")}`,
  ]).stdout.toString();
  expect(out).toBe("it's $HOME");
});

test("a name a shell cannot export is left out", () => {
  expect(envFileText({ OK: "1", "NOT-OK": "2", "A;rm -rf /": "3" })).toBe("export OK='1'\n");
});

test("the file is written once per adapter, and none when there is nothing in it", () => {
  const root = mkdtempSync(join(tmpdir(), "cycle-env-file-test-"));
  try {
    const owner = {};
    const file = sessionEnvFile(owner, { A: "1" }, root);
    expect(file).toBeDefined();
    expect(sessionEnvFile(owner, { A: "1" }, root)).toBe(file);
    expect(sessionEnvFile({}, {}, root)).toBeUndefined();
    expect(sessionEnvFile({}, undefined, root)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
