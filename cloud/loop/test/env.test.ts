import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverEnv, ensureVerifyDirs, runHomeDir, verifyEnv } from "../src/env.ts";
import { runCommand } from "../src/runner.ts";

const source = {
  PATH: process.env.PATH ?? "/bin",
  HOME: "/home/u",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  TMPDIR: "/tmp",
  TZ: "UTC",
  GH_TOKEN: "gh",
  GITHUB_TOKEN: "gh2",
  SSH_AUTH_SOCK: "/s",
  AUTO_LOOP_PLAN_KEY: "secret",
  ANTHROPIC_API_KEY: "secret",
};

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) {
    await rm(temps.pop() as string, { recursive: true, force: true });
  }
});

test("commands that run session-written code see no credentials", () => {
  const env = verifyEnv(source);
  expect(env.HOME).toBe("/home/u");
  expect(env.CI).toBe("1");
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.SSH_AUTH_SOCK).toBeUndefined();
  expect(env.AUTO_LOOP_PLAN_KEY).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("isolated verifyEnv gives each run its own temp HOME and shared caches with no credentials (CYC-473)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-env-"));
  temps.push(stateDir);
  const dirs = ensureVerifyDirs({ stateDir, key: "CYC-473" });
  expect(dirs.home).toBe(runHomeDir(stateDir, "CYC-473"));
  expect(existsSync(dirs.home)).toBe(true);
  expect(existsSync(dirs.bunCache)).toBe(true);
  expect(existsSync(dirs.playwright)).toBe(true);
  expect(existsSync(dirs.electron)).toBe(true);

  const env = verifyEnv(source, { stateDir, key: "CYC-473" });
  expect(env).toEqual({
    PATH: source.PATH,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: "/tmp",
    TZ: "UTC",
    HOME: join(stateDir, "home", "CYC-473"),
    BUN_INSTALL_CACHE_DIR: join(stateDir, "cache", "bun"),
    PLAYWRIGHT_BROWSERS_PATH: join(stateDir, "cache", "ms-playwright"),
    ELECTRON_CACHE: join(stateDir, "cache", "electron"),
    CI: "1",
  });

  // Real subprocess verification: a spawned command sees the isolated HOME and zero credential vars.
  const out = await runCommand(
    [
      process.execPath,
      "-e",
      "console.log(JSON.stringify({HOME:process.env.HOME,BUN_INSTALL_CACHE_DIR:process.env.BUN_INSTALL_CACHE_DIR,GH_TOKEN:process.env.GH_TOKEN,GITHUB_TOKEN:process.env.GITHUB_TOKEN,SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK,CI:process.env.CI}))",
    ],
    { cwd: stateDir, env, timeoutMs: 10_000 },
  );
  expect(out.code).toBe(0);
  expect(JSON.parse(out.output.trim())).toEqual({
    HOME: join(stateDir, "home", "CYC-473"),
    BUN_INSTALL_CACHE_DIR: join(stateDir, "cache", "bun"),
    CI: "1",
  });
});

test("push and pr create see git's credentials and nothing of the tracker's or a model's", () => {
  const env = deliverEnv(source);
  expect(env.GH_TOKEN).toBe("gh");
  expect(env.SSH_AUTH_SOCK).toBe("/s");
  expect(Object.keys(env)).not.toContain("AUTO_LOOP_PLAN_KEY");
  expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
});
