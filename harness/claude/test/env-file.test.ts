import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionEnvFiles,
  envFileText,
  shellWord,
  writeSessionEnvFile,
} from "../src/env-file.ts";

test("a value is one shell word with nothing expanded, a quote included", () => {
  expect(shellWord("it's")).toBe("'it'\\''s'");
  // What the shell makes of it is the value as it was.
  const out = Bun.spawnSync([
    "/bin/sh",
    "-c",
    `printf %s ${shellWord("it's $HOME `x`")}`,
  ]).stdout.toString();
  expect(out).toBe("it's $HOME `x`");
});

test("a name a shell cannot export is left out", () => {
  expect(envFileText({ OK: "1", "NOT-OK": "2", "A;rm -rf /": "3" })).toBe("export OK='1'\n");
});

test("a session's file is its own and private, gone when it has none, and all gone when cleared", () => {
  const root = mkdtempSync(join(tmpdir(), "cycle-env-file-test-"));
  const dir = join(root, "claude-env");
  try {
    const file = writeSessionEnvFile(dir, "5b0c3a3e-8a52", { A: "1", B: "two words" });
    expect(file).toBe(join(dir, "5b0c3a3e-8a52.sh"));
    expect(readFileSync(file as string, "utf8")).toBe("export A='1'\nexport B='two words'\n");
    expect(statSync(file as string).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // The same session's next launch with none: nothing is left of the old values.
    expect(writeSessionEnvFile(dir, "5b0c3a3e-8a52", {})).toBeUndefined();
    expect(() => statSync(file as string)).toThrow();
    // Not a session id: nothing is written, wherever it would point.
    expect(writeSessionEnvFile(dir, "../escape", { A: "1" })).toBeUndefined();
    writeSessionEnvFile(dir, "other", { A: "1" });
    clearSessionEnvFiles(dir);
    expect(() => statSync(dir)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
