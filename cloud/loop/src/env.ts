// What a process the loop starts may see of the loop's own environment. The loop holds a tracker key and a GitHub
// token; commands that run code a session wrote (tests, builds) get neither (AGENTS.md: environment variables go
// by an explicit allowlist, and no token reaches an agent).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_NO_HOME = ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"] as const;
const BASE = ["HOME", ...BASE_NO_HOME] as const;
/** What `git fetch`, `git push` and `gh` commands (PR / CI) need to authenticate, and only those commands get it. */
const DELIVER = ["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"] as const;
/** What `gh` commands get when isolated under `stateDir` (CYC-478): no HOME, no SSH_AUTH_SOCK, no GITHUB_TOKEN. */
const GH_ALLOWED = ["PATH", "GH_TOKEN", "GH_HOST"] as const;

export type VerifyIsolation = { stateDir: string; key: string };

/** Per-run temporary HOME for verification and dependency installation (CYC-473). */
export const runHomeDir = (stateDir: string, key: string): string => join(stateDir, "home", key);

/** Creates the per-run temporary HOME and shared download caches under `stateDir` (CYC-473). */
export const ensureVerifyDirs = (
  isolation: VerifyIsolation,
): { home: string; bunCache: string; playwright: string; electron: string } => {
  const home = runHomeDir(isolation.stateDir, isolation.key);
  const bunCache = join(isolation.stateDir, "cache", "bun");
  const playwright = join(isolation.stateDir, "cache", "ms-playwright");
  const electron = join(isolation.stateDir, "cache", "electron");
  for (const dir of [home, bunCache, playwright, electron]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return { home, bunCache, playwright, electron };
};

const pick = (
  source: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

/**
 * For git, bun and the tests: no credentials. When `isolation` is given (CYC-473), HOME is a per-run directory under
 * `<stateDir>/home/<key>` and download caches point at `<stateDir>/cache/`, so session-written code does not inherit
 * the user's real HOME.
 */
export const verifyEnv = (
  source: Record<string, string | undefined>,
  isolation?: VerifyIsolation,
): Record<string, string> => {
  if (isolation === undefined) {
    return {
      ...pick(source, BASE),
      CI: "1",
    };
  }
  return {
    ...pick(source, BASE_NO_HOME),
    HOME: runHomeDir(isolation.stateDir, isolation.key),
    BUN_INSTALL_CACHE_DIR: join(isolation.stateDir, "cache", "bun"),
    PLAYWRIGHT_BROWSERS_PATH: join(isolation.stateDir, "cache", "ms-playwright"),
    ELECTRON_CACHE: join(isolation.stateDir, "cache", "electron"),
    CI: "1",
  };
};

/** For `git fetch`, `git push` and `gh` commands (PR creation/update and CI status/logs) only. */
export const deliverEnv = (source: Record<string, string | undefined>): Record<string, string> => ({
  ...pick(source, BASE),
  ...pick(source, DELIVER),
});

const LOOP_GITCONFIG =
  "[user]\n\tname = Cycle Loop\n\temail = loop@cycle.local\n[safe]\n\tdirectory = *\n";

/** Writes the loop's own clean global gitconfig (`<stateDir>/gitconfig`, CYC-478) atomically and returns its path. */
export const ensureLoopGitConfig = (stateDir: string): string => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "gitconfig");
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === LOOP_GITCONFIG) {
        chmodSync(path, 0o600);
        return path;
      }
    } catch {
      // Rewrite below if unreadable.
    }
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, LOOP_GITCONFIG, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
};

/** Clean environment for local git commands (no credentials, no system/user gitconfig, CYC-478). */
export const gitCleanEnv = (
  source: Record<string, string | undefined>,
  stateDir?: string,
): Record<string, string> => ({
  ...verifyEnv(source),
  GIT_CONFIG_NOSYSTEM: "1",
  ...(stateDir !== undefined ? { GIT_CONFIG_GLOBAL: ensureLoopGitConfig(stateDir) } : {}),
});

/** Clean environment for authenticated git commands inside `delivery.git` only (CYC-478). */
export const gitDeliverEnv = (
  source: Record<string, string | undefined>,
  stateDir?: string,
): Record<string, string> => ({
  ...deliverEnv(source),
  GIT_CONFIG_NOSYSTEM: "1",
  ...(stateDir !== undefined ? { GIT_CONFIG_GLOBAL: ensureLoopGitConfig(stateDir) } : {}),
});

/**
 * Extra `-c` arguments for authenticated HTTPS git commands in Loop-owned repos (`delivery.git` and supervisor
 * `repo.git`). Reads `GH_TOKEN`/`GITHUB_TOKEN` from env without placing tokens in argv or reading untrusted gitconfig.
 */
export const gitDeliverAuthArgs = (source: Record<string, string | undefined>): string[] => {
  const hasToken =
    (source.GH_TOKEN !== undefined && source.GH_TOKEN !== "") ||
    (source.GITHUB_TOKEN !== undefined && source.GITHUB_TOKEN !== "");
  if (!hasToken) return [];
  const rawHost = source.GH_HOST?.trim() ?? "";
  const host = /^[A-Za-z0-9.-]+$/.test(rawHost) ? rawHost : "github.com";
  return [
    "-c",
    `credential.https://${host}.helper=`,
    "-c",
    `credential.https://${host}.helper=!f() { if [ "$1" = get ]; then printf "username=x-access-token\\npassword=%s\\n" "\${GH_TOKEN:-$GITHUB_TOKEN}"; fi; }; f`,
  ];
};

/** Creates `<stateDir>/gh-cwd` and `<stateDir>/gh` for isolated `gh` invocations (CYC-478). */
export const ensureGhDirs = (stateDir: string): { cwd: string; configDir: string } => {
  const cwd = join(stateDir, "gh-cwd");
  const configDir = join(stateDir, "gh");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return { cwd, configDir };
};

/** Minimal environment for `gh` (CYC-478): only PATH, GH_TOKEN (falling back to GITHUB_TOKEN), GH_HOST and an empty GH_CONFIG_DIR. */
export const ghEnv = (
  source: Record<string, string | undefined>,
  stateDir: string,
): Record<string, string> => {
  const { configDir } = ensureGhDirs(stateDir);
  const picked = pick(source, GH_ALLOWED);
  if (picked.GH_TOKEN === undefined && source.GITHUB_TOKEN !== undefined) {
    picked.GH_TOKEN = source.GITHUB_TOKEN;
  }
  return {
    ...picked,
    GH_CONFIG_DIR: configDir,
  };
};

/**
 * git's own switches that stop a repository's `.git/config` from running hooks, credential helpers, ssh commands,
 * or ext:: transports (CYC-318, CYC-478). Every git the loop runs carries these.
 * External diffs and textconv filters are disabled via `--no-ext-diff --no-textconv` on `git diff` calls and rejected
 * by `inspectGitConfig` (passing `-c diff.external=` tells git to execute an empty program name and breaks `git diff`).
 */
export const GIT_SAFE = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.sshCommand=ssh",
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
  "-c",
  "core.pager=cat",
  "-c",
  "protocol.ext.allow=never",
] as const;
