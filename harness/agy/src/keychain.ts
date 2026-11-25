/**
 * Dedicated macOS keychain under agy's isolated HOME (`<HOME>/Library/Keychains/login.keychain-db`, CYC-327).
 *
 * When agy runs with an isolated HOME, macOS has no default keychain there and prompts "A keychain cannot be found
 * to store 'antigravity'". Before starting agy on darwin, ensure a private login keychain exists, is set as the
 * default keychain for that HOME, and is unlocked. Never touches the host HOME or host keychain, never reads or logs
 * keychain contents, and never blocks agy startup on failure.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const SECURITY_BIN = "/usr/bin/security";
const DEFAULT_TIMEOUT_MS = 10_000;

export type KeychainCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type KeychainCommandRunner = (
  command: readonly string[],
  options: { env: Record<string, string> },
) => Promise<KeychainCommandResult>;

export type KeychainLogger = {
  warn: (
    event: string,
    fields?: Record<string, string | number | boolean | undefined | null>,
  ) => void;
};

export type EnsureKeychainOptions = {
  /** Executes `security` commands; injectable so tests use a fake without touching the host. */
  run?: KeychainCommandRunner;
  /** Overrides `process.platform` (for tests). */
  platform?: NodeJS.Platform;
  /** Optional structured logger for non-fatal warnings; never receives keychain content. */
  log?: KeychainLogger;
};

/** Where the isolated keychain file lives under agy's HOME. */
export const keychainPathFor = (home: string): string =>
  join(home, "Library", "Keychains", "login.keychain-db");

const defaultRunner: KeychainCommandRunner = async (command, { env }) => {
  const proc = Bun.spawn([...command], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, DEFAULT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: timedOut ? null : code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** Parses `security default-keychain` output (e.g. `    "/path/to/login.keychain-db"\n`). */
const parseDefaultKeychain = (stdout: string): string | undefined => {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return unquoted === "" ? undefined : unquoted;
};

const samePath = (a: string, b: string): boolean => {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Ensures agy's isolated HOME has an unlocked default keychain on macOS.
 * No-op on non-darwin platforms; logs and returns on any failure without throwing.
 */
export const ensureKeychain = async (
  home: string,
  options: EnsureKeychainOptions = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return;
  if (!home || !isAbsolute(home)) {
    options.log?.warn("agy_keychain_skipped", { reason: "invalid_home" });
    return;
  }

  const run = options.run ?? defaultRunner;
  const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin" };
  const keychainsDir = join(home, "Library", "Keychains");
  const keychainPath = keychainPathFor(home);

  const exec = async (
    step: string,
    args: readonly string[],
  ): Promise<KeychainCommandResult | undefined> => {
    try {
      return await run([SECURITY_BIN, ...args], { env });
    } catch (error) {
      options.log?.warn("agy_keychain_failed", {
        step,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  const runChecked = async (step: string, args: readonly string[]): Promise<boolean> => {
    const result = await exec(step, args);
    if (result === undefined) return false;
    if (result.code !== 0) {
      options.log?.warn("agy_keychain_failed", {
        step,
        code: result.code ?? -1,
      });
      return false;
    }
    return true;
  };

  if (existsSync(keychainPath)) {
    const check = await exec("default_keychain_read", ["default-keychain"]);
    if (check === undefined) return;
    const current = check.code === 0 ? parseDefaultKeychain(check.stdout) : undefined;
    if (current !== undefined && samePath(current, keychainPath)) {
      await runChecked("unlock_keychain", ["unlock-keychain", "-p", "", keychainPath]);
      return;
    }
    if (!(await runChecked("default_keychain_set", ["default-keychain", "-s", keychainPath]))) {
      return;
    }
    await runChecked("unlock_keychain", ["unlock-keychain", "-p", "", keychainPath]);
    return;
  }

  try {
    mkdirSync(keychainsDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    options.log?.warn("agy_keychain_failed", {
      step: "mkdir",
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!(await runChecked("create_keychain", ["create-keychain", "-p", "", keychainPath]))) return;
  if (!(await runChecked("default_keychain_set", ["default-keychain", "-s", keychainPath]))) return;
  await runChecked("unlock_keychain", ["unlock-keychain", "-p", "", keychainPath]);
};
