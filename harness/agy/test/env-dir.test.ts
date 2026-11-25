import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_ENV_FILE,
  clearSessionEnvDirs,
  envFileText,
  shellWord,
  writeSessionEnvDir,
} from "../src/env-dir.ts";
import { agyProcessEnv } from "../src/server.ts";

test("a value is one shell word with nothing expanded, a quote included", () => {
  expect(shellWord("it's")).toBe("'it'\\''s'");
  const out = Bun.spawnSync([
    "/bin/sh",
    "-c",
    `printf %s ${shellWord("it's $HOME `x`")}`,
  ]).stdout.toString();
  expect(out).toBe("it's $HOME `x`");
});

test("a name a shell cannot export is left out, and empty variables produce no file", () => {
  expect(envFileText({})).toBe("");
  expect(envFileText({ "NOT-OK": "2", "A;rm -rf /": "3" })).toBe("");
  const text = envFileText({ OK: "1", "NOT-OK": "2" });
  expect(text).toContain("export OK='1'\n");
  expect(text).not.toContain("NOT-OK");
  expect(text).toEndWith("unset ZDOTDIR BASH_ENV\n");
});

test("a session's env dir is private, removed when empty, rejects traversal, and clears on start", () => {
  const root = mkdtempSync(join(tmpdir(), "cycle-agy-env-dir-test-"));
  const dir = join(root, "agy-env");
  try {
    const sessionDir = writeSessionEnvDir(dir, "5b0c3a3e-8a52", { A: "1", B: "two words" });
    expect(sessionDir).toBe(join(dir, "5b0c3a3e-8a52"));
    const file = join(sessionDir as string, AGY_ENV_FILE);
    expect(readFileSync(file, "utf8")).toContain("export A='1'\nexport B='two words'\n");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(sessionDir as string).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // The same session's next launch with none: nothing is left of the old values.
    expect(writeSessionEnvDir(dir, "5b0c3a3e-8a52", {})).toBeUndefined();
    expect(() => statSync(sessionDir as string)).toThrow();

    // Not a session id: nothing is written, wherever it would point.
    expect(writeSessionEnvDir(dir, "../escape", { A: "1" })).toBeUndefined();
    writeSessionEnvDir(dir, "other", { A: "1" });
    clearSessionEnvDirs(dir);
    expect(() => statSync(dir)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agyProcessEnv hands only ZDOTDIR and BASH_ENV to agy, never the session variables themselves", () => {
  const base = { HOME: "/tmp/agy-home", PATH: "/usr/bin:/bin" };
  expect(agyProcessEnv({ env: base, agyExecutable: "/bin/agy" })).toEqual(base);
  const withSession = agyProcessEnv({
    env: base,
    agyExecutable: "/bin/agy",
    sessionEnvDir: "/tmp/data/agy-env/s1",
  });
  expect(withSession).toEqual({
    ...base,
    ZDOTDIR: "/tmp/data/agy-env/s1",
    BASH_ENV: "/tmp/data/agy-env/s1/.zshenv",
  });
  // Base config.env is never mutated (planUsage and pluginReader keep it clean).
  expect(base).not.toHaveProperty("ZDOTDIR");
  expect(base).not.toHaveProperty("BASH_ENV");
});

test("zsh -c and bash -c source the session variables, preserve $HOME/.zshenv, and unset ZDOTDIR/BASH_ENV for child shells", () => {
  const root = mkdtempSync(join(tmpdir(), "cycle-agy-env-shell-test-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".zshenv"), "export FROM_HOME='kept'\nexport OVERRIDDEN='from_home'\n");
  const sessionDir = writeSessionEnvDir(join(root, "agy-env"), "sess-1", {
    GH_TOKEN: "ghp_test'quote",
    OVERRIDDEN: "from_session",
  });
  expect(sessionDir).toBeDefined();
  const procEnv = agyProcessEnv({
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    agyExecutable: "/bin/agy",
    sessionEnvDir: sessionDir as string,
  });
  // The agent process itself does not have the variables.
  expect(procEnv).not.toHaveProperty("GH_TOKEN");
  expect(procEnv).not.toHaveProperty("OVERRIDDEN");

  try {
    const zsh = Bun.which("zsh");
    if (zsh !== null) {
      const res = Bun.spawnSync(
        [
          zsh,
          "-c",
          'printf "%s|%s|%s|%s|%s|" "$GH_TOKEN" "$FROM_HOME" "$OVERRIDDEN" "$ZDOTDIR" "$BASH_ENV"; GH_TOKEN=child zsh -c \'printf "%s" "$GH_TOKEN"\'',
        ],
        { env: procEnv },
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString()).toBe("ghp_test'quote|kept|from_session|||child");
    }

    const bash = Bun.which("bash");
    if (bash !== null) {
      const res = Bun.spawnSync(
        [
          bash,
          "-c",
          'printf "%s|%s|%s|%s|" "$GH_TOKEN" "$OVERRIDDEN" "$ZDOTDIR" "$BASH_ENV"; GH_TOKEN=child bash -c \'printf "%s" "$GH_TOKEN"\'',
        ],
        { env: procEnv },
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString()).toBe("ghp_test'quote|from_session|||child");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
