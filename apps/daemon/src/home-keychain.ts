/**
 * A keychain for a HOME that Cycle made up (macOS only).
 *
 * macOS looks for the default keychain at `$HOME/Library/Keychains/login.keychain-db`. A made-up HOME has none, so the
 * first program in it that stores a secret with `security add-generic-password` (Claude does, by bare name on PATH;
 * with no USER its account is "unknown") makes macOS open "A keychain cannot be found to store …" with Cancel / Reset
 * To Defaults. That window blocks until someone clicks it, and nothing is stored.
 *
 * Whoever makes a HOME up gives it a keychain: the daemon when it falls back to `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
 * because no HOME was inherited, and the tests for each temporary HOME they hand to a child. The keychain has an empty
 * password (it guards nothing the files beside it do not; see the agy note of 2026-11-25) and no auto-lock, so it never
 * turns into a password prompt either. It is only created at the default path: that is enough for macOS to take it as
 * the default, and the user's own search list and default keychain are never written.
 *
 * Never touches the account's real home; never reads or logs keychain contents; never throws.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type HomeKeychainResult = "created" | "unlocked" | "skipped" | "failed";

export type HomeKeychainOptions = {
  platform?: NodeJS.Platform;
  /** Runs `/usr/bin/security`; injectable for tests. Returns the exit code. */
  run?: (args: string[], env: Record<string, string>) => number;
  /** The account's real home (from the user database, not HOME); never given a keychain. */
  realHome?: string;
};

const SECURITY = "/usr/bin/security";

const runSecurity = (args: string[], env: Record<string, string>): number => {
  const proc = Bun.spawnSync([SECURITY, ...args], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: 10_000,
  });
  return proc.exitCode ?? -1;
};

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const accountHome = (): string | undefined => {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
};

/** Makes sure the made-up `home` has an unlocked default keychain with no auto-lock. */
export const ensureHomeKeychain = (
  home: string | undefined,
  options: HomeKeychainOptions = {},
): HomeKeychainResult => {
  if ((options.platform ?? process.platform) !== "darwin") return "skipped";
  if (!home || !isAbsolute(home)) return "skipped";
  const realHome = options.realHome ?? accountHome();
  if (realHome && real(home) === real(realHome)) return "skipped";
  const run = options.run ?? runSecurity;
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  const keychain = join(home, "Library", "Keychains", "login.keychain-db");
  try {
    if (existsSync(keychain)) {
      // After a restart it is locked again; an empty password opens it without asking anyone.
      return run(["unlock-keychain", "-p", "", keychain], env) === 0 ? "unlocked" : "failed";
    }
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true, mode: 0o700 });
    if (run(["create-keychain", "-p", "", keychain], env) !== 0) return "failed";
    // Without -t or -l: no 5-minute auto-lock and no lock on sleep, which would ask for the password later.
    if (run(["set-keychain-settings", keychain], env) !== 0) return "failed";
    return "created";
  } catch {
    return "failed";
  }
};
