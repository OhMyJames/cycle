// Self-updating Work loop runtime managed by the supervisor (CYC-485).
//
// Runtime layout under `runtimeDir` (default `~/.cycle/loop-runtime/`):
//   repo.git/        bare clone of the Loop codebase (fetched with clean git env)
//   versions/<sha>/  detached worktree per checked-out version with dependencies installed
//   current  -> versions/<sha>
//   previous -> versions/<sha>
//
// Only `current` and `previous` are kept. If `cloud/loop/src/supervisor/` changes, a Notice tells a person to restart
// the supervisor; the supervisor never replaces itself.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { SqliteStore } from "../db/store.ts";
import {
  ensureVerifyDirs,
  GIT_SAFE,
  gitCleanEnv,
  gitDeliverAuthArgs,
  gitDeliverEnv,
  runHomeDir,
  verifyEnv,
} from "../env.ts";
import type { Exec } from "../types.ts";

export type UpdateOutcome =
  | { status: "noop"; sha: string }
  | { status: "skipped_unrelated"; sha: string }
  | { status: "self_check_failed"; sha: string; step: "install" | "check"; reason: string }
  | { status: "drain_timeout"; sha: string }
  | { status: "updated"; from: string; to: string; supervisorChanged: boolean }
  | { status: "rolled_back"; sha: string; to: string };

export type UpdaterProject = {
  projectKey: string;
  store: SqliteStore;
};

export type LoopUpdaterOptions = {
  runtimeDir: string;
  repoUrl: string;
  /** Path to `loop.json` passed to `pipeline-cli.ts --dry-run --config` during self-check. */
  configPath?: string;
  projects: UpdaterProject[];
  exec: Exec;
  env: Record<string, string | undefined>;
  /** Stops the running Work loop gracefully; returns true if drained within budget. */
  drainStop: () => Promise<{ drained: boolean }>;
  /** Starts Work loop from the given version directory (`current`). */
  startWorkLoop: (versionDir: string) => Promise<void> | void;
  /** Stops the newly started Work loop when rolling back after no heartbeat. */
  stopWorkLoop: () => Promise<void> | void;
  /** Waits up to `heartbeatVerifyMs` for a fresh heartbeat after restart; returns true if alive. */
  awaitHeartbeat: (sinceMs: number, timeoutMs: number) => Promise<boolean>;
  /** Runs `bun install --frozen-lockfile` inside the new version worktree. Overridable in tests. */
  installDeps?: (versionDir: string) => Promise<{ ok: boolean; error?: string }>;
  /** Runs self-checks (`bun test ./cloud/loop/test` + `pipeline-cli.ts --dry-run`). Overridable in tests. */
  selfCheck?: (versionDir: string) => Promise<{ ok: boolean; error?: string }>;
  now?: () => Date;
  log?: (line: string) => void;
  /** How long to wait for a heartbeat after switching before rolling back (default 2 minutes). */
  heartbeatVerifyMs?: number;
};

const WORKSPACE_ROOTS = ["packages", "harness", "apps", "cloud"] as const;

/** Computes the path prefixes that trigger a Work loop self-update from `cloud/loop/package.json` workspace deps. */
export const watchPrefixesForLoop = (versionDir: string): string[] => {
  const prefixes = new Set<string>(["cloud/loop/", "bun.lock"]);
  const pkgPath = join(versionDir, "cloud/loop/package.json");
  if (!existsSync(pkgPath)) return [...prefixes];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const wsNames = new Set(
      Object.entries(pkg.dependencies ?? {})
        .filter(([, ver]) => ver.startsWith("workspace:"))
        .map(([name]) => name),
    );
    if (wsNames.size === 0) return [...prefixes];
    for (const root of WORKSPACE_ROOTS) {
      const rootDir = join(versionDir, root);
      if (!existsSync(rootDir)) continue;
      for (const entry of readdirSync(rootDir)) {
        const manifestPath = join(rootDir, entry, "package.json");
        if (!existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
          if (manifest.name !== undefined && wsNames.has(manifest.name)) {
            prefixes.add(`${root}/${entry}/`);
          }
        } catch {
          // Ignore malformed package.json in unrelated folders.
        }
      }
    }
  } catch {
    // Fall back to default prefixes.
  }
  return [...prefixes];
};

export const classifyChangedFiles = (
  changedFiles: readonly string[],
  watchPrefixes: readonly string[],
): { updateWorkLoop: boolean; supervisorChanged: boolean } => {
  const supervisorChanged = changedFiles.some((f) => f.startsWith("cloud/loop/src/supervisor/"));
  const updateWorkLoop = changedFiles.some((f) =>
    watchPrefixes.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)),
  );
  return { updateWorkLoop, supervisorChanged };
};

const replaceSymlink = (linkPath: string, target: string): void => {
  try {
    lstatSync(linkPath);
    rmSync(linkPath, { force: true });
  } catch {
    // Does not exist yet.
  }
  symlinkSync(target, linkPath, "dir");
};

const readLinkTarget = (linkPath: string): string | null => {
  try {
    return readlinkSync(linkPath);
  } catch {
    return null;
  }
};

export class LoopUpdater {
  readonly #o: LoopUpdaterOptions;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  readonly #repoDir: string;
  readonly #versionsDir: string;
  readonly #currentLink: string;
  readonly #previousLink: string;
  readonly #failedShas = new Set<string>();
  #lastSeenSha: string | null = null;

  constructor(options: LoopUpdaterOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => {});
    this.#repoDir = join(options.runtimeDir, "repo.git");
    this.#versionsDir = join(options.runtimeDir, "versions");
    this.#currentLink = join(options.runtimeDir, "current");
    this.#previousLink = join(options.runtimeDir, "previous");
  }

  get currentPath(): string | null {
    return readLinkTarget(this.#currentLink);
  }

  get previousPath(): string | null {
    return readLinkTarget(this.#previousLink);
  }

  get currentSha(): string | null {
    const target = this.currentPath;
    return target === null ? null : basename(target);
  }

  /** Initializes `repo.git` and checks out initial `current` version if not already present. */
  async ensureInitialized(): Promise<string> {
    mkdirSync(this.#o.runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#versionsDir, { recursive: true, mode: 0o700 });
    if (!existsSync(join(this.#repoDir, "HEAD"))) {
      const cloned = await this.#o.exec(
        [
          "git",
          ...GIT_SAFE,
          ...gitDeliverAuthArgs(this.#o.env),
          "clone",
          "--bare",
          this.#o.repoUrl,
          this.#repoDir,
        ],
        {
          cwd: this.#o.runtimeDir,
          env: gitDeliverEnv(this.#o.env, this.#o.runtimeDir),
          timeoutMs: 120_000,
        },
      );
      if (cloned.code !== 0) throw new Error(`updater clone failed: ${cloned.output.trim()}`);
    }
    if (this.currentSha === null) {
      const sha = await this.#fetchOriginMain();
      const dir = await this.#checkoutVersion(sha);
      const installed = await this.#installDeps(dir);
      if (!installed.ok) {
        await this.#removeVersion(dir);
        throw new Error(`updater initial install failed: ${installed.error ?? "unknown"}`);
      }
      replaceSymlink(this.#currentLink, dir);
      this.#lastSeenSha = sha;
      return sha;
    }
    this.#lastSeenSha = this.currentSha;
    return this.currentSha;
  }

  /** One update check cycle (every 5 minutes). */
  async checkOnce(): Promise<UpdateOutcome> {
    const currentSha = this.currentSha ?? (await this.ensureInitialized());
    const newSha = await this.#fetchOriginMain();
    if (newSha === currentSha || newSha === this.#lastSeenSha || this.#failedShas.has(newSha)) {
      return { status: "noop", sha: newSha };
    }

    const diffOut = await this.#o.exec(
      [
        "git",
        ...GIT_SAFE,
        "--git-dir",
        this.#repoDir,
        "diff",
        "--name-only",
        `${currentSha}..${newSha}`,
      ],
      {
        cwd: this.#o.runtimeDir,
        env: gitCleanEnv(this.#o.env, this.#o.runtimeDir),
        timeoutMs: 30_000,
      },
    );
    if (diffOut.code !== 0) {
      throw new Error(`updater diff failed: ${diffOut.output.trim()}`);
    }
    const changed = diffOut.output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const currentDir = this.currentPath ?? join(this.#versionsDir, currentSha);
    const prefixes = watchPrefixesForLoop(currentDir);
    const { updateWorkLoop, supervisorChanged } = classifyChangedFiles(changed, prefixes);

    if (supervisorChanged) {
      for (const proj of this.#o.projects) {
        proj.store.notice(
          proj.projectKey,
          "supervisor",
          `守护者有新版本（${newSha.slice(0, 8)}），需要你重启它。`,
          `supervisor:new-version:${proj.projectKey}:${newSha}`,
        );
      }
      this.#log(`updater: supervisor changed in ${newSha.slice(0, 8)}; posted Notice`);
    }

    if (!updateWorkLoop) {
      this.#lastSeenSha = newSha;
      return { status: "skipped_unrelated", sha: newSha };
    }

    // 1. Build new version worktree & install deps.
    const newDir = await this.#checkoutVersion(newSha);
    const installed = await this.#installDeps(newDir);
    if (!installed.ok) {
      await this.#removeVersion(newDir);
      this.#failedShas.add(newSha);
      return {
        status: "self_check_failed",
        sha: newSha,
        step: "install",
        reason: installed.error ?? "install failed",
      };
    }

    // 2. Run self-checks before touching running Work loop.
    const checked = await this.#runSelfCheck(newDir);
    if (!checked.ok) {
      await this.#removeVersion(newDir);
      this.#failedShas.add(newSha);
      return {
        status: "self_check_failed",
        sha: newSha,
        step: "check",
        reason: checked.error ?? "self-check failed",
      };
    }

    // 3. Drain running Work loop (up to 30m). Timeout aborts this update without blacklisting sha.
    const drain = await this.#o.drainStop();
    if (!drain.drained) {
      await this.#removeVersion(newDir);
      return { status: "drain_timeout", sha: newSha };
    }

    // 4. Flip symlinks: previous = current, current = new, and start new Work loop.
    const prevDir = currentDir;
    replaceSymlink(this.#previousLink, prevDir);
    replaceSymlink(this.#currentLink, newDir);
    const switchMs = this.#now().getTime();
    await this.#o.startWorkLoop(newDir);

    // 5. Verify heartbeat within 2 minutes; otherwise roll back to previous.
    const alive = await this.#o.awaitHeartbeat(switchMs, this.#o.heartbeatVerifyMs ?? 2 * 60_000);
    if (alive) {
      this.#lastSeenSha = newSha;
      await this.#pruneOldVersions(newDir, prevDir);
      for (const proj of this.#o.projects) {
        await proj.store.event("supervisor", "self_updated", {
          from: currentSha,
          to: newSha,
        });
      }
      this.#log(`updater: updated work loop ${currentSha.slice(0, 8)} -> ${newSha.slice(0, 8)}`);
      return { status: "updated", from: currentSha, to: newSha, supervisorChanged };
    }

    // Roll back to previous and blacklist this sha.
    await this.#o.stopWorkLoop();
    replaceSymlink(this.#currentLink, prevDir);
    await this.#o.startWorkLoop(prevDir);
    this.#failedShas.add(newSha);
    await this.#removeVersion(newDir);
    for (const proj of this.#o.projects) {
      proj.store.notice(
        proj.projectKey,
        "supervisor",
        `Work loop 自更新到 ${newSha.slice(0, 8)} 后 2 分钟内无心跳，已回滚到 ${currentSha.slice(0, 8)}。`,
        `supervisor:rollback:${proj.projectKey}:${newSha}`,
      );
      await proj.store.event("supervisor", "self_update_rolled_back", {
        from: currentSha,
        to: newSha,
      });
    }
    this.#log(`updater: rolled back ${newSha.slice(0, 8)} -> ${currentSha.slice(0, 8)}`);
    return { status: "rolled_back", sha: newSha, to: currentSha };
  }

  async #fetchOriginMain(): Promise<string> {
    const fetched = await this.#o.exec(
      [
        "git",
        ...GIT_SAFE,
        ...gitDeliverAuthArgs(this.#o.env),
        "--git-dir",
        this.#repoDir,
        "fetch",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ],
      {
        cwd: this.#o.runtimeDir,
        env: gitDeliverEnv(this.#o.env, this.#o.runtimeDir),
        timeoutMs: 60_000,
      },
    );
    if (fetched.code !== 0) throw new Error(`updater fetch failed: ${fetched.output.trim()}`);
    const rev = await this.#o.exec(
      ["git", ...GIT_SAFE, "--git-dir", this.#repoDir, "rev-parse", "refs/remotes/origin/main"],
      {
        cwd: this.#o.runtimeDir,
        env: gitCleanEnv(this.#o.env, this.#o.runtimeDir),
        timeoutMs: 15_000,
      },
    );
    if (rev.code !== 0) throw new Error(`updater rev-parse failed: ${rev.output.trim()}`);
    return rev.output.trim();
  }

  async #checkoutVersion(sha: string): Promise<string> {
    const dir = join(this.#versionsDir, sha);
    if (existsSync(dir)) return dir;
    const added = await this.#o.exec(
      ["git", ...GIT_SAFE, "--git-dir", this.#repoDir, "worktree", "add", "--detach", dir, sha],
      {
        cwd: this.#o.runtimeDir,
        env: gitCleanEnv(this.#o.env, this.#o.runtimeDir),
        timeoutMs: 60_000,
      },
    );
    if (added.code !== 0) throw new Error(`updater worktree add failed: ${added.output.trim()}`);
    return dir;
  }

  async #removeVersion(dir: string): Promise<void> {
    await this.#o.exec(
      ["git", ...GIT_SAFE, "--git-dir", this.#repoDir, "worktree", "remove", "--force", dir],
      {
        cwd: this.#o.runtimeDir,
        env: gitCleanEnv(this.#o.env, this.#o.runtimeDir),
        timeoutMs: 30_000,
      },
    );
    rmSync(dir, { recursive: true, force: true });
  }

  async #pruneOldVersions(currentDir: string, previousDir: string): Promise<void> {
    const keep = new Set([basename(currentDir), basename(previousDir)]);
    const removals: Promise<void>[] = [];
    for (const entry of readdirSync(this.#versionsDir)) {
      if (keep.has(entry)) continue;
      const target = join(this.#versionsDir, entry);
      removals.push(this.#removeVersion(target));
    }
    await Promise.allSettled(removals);
  }

  async #installDeps(versionDir: string): Promise<{ ok: boolean; error?: string }> {
    if (this.#o.installDeps !== undefined) return this.#o.installDeps(versionDir);
    const isolation = { stateDir: this.#o.runtimeDir, key: `update-${basename(versionDir)}` };
    ensureVerifyDirs(isolation);
    try {
      const res = await this.#o.exec(["bun", "install", "--frozen-lockfile"], {
        cwd: versionDir,
        env: verifyEnv(this.#o.env, isolation),
        timeoutMs: 180_000,
      });
      return res.code === 0 && !res.timedOut
        ? { ok: true }
        : { ok: false, error: res.output.trim() };
    } finally {
      rmSync(runHomeDir(isolation.stateDir, isolation.key), { recursive: true, force: true });
    }
  }

  async #runSelfCheck(versionDir: string): Promise<{ ok: boolean; error?: string }> {
    if (this.#o.selfCheck !== undefined) return this.#o.selfCheck(versionDir);
    const isolation = { stateDir: this.#o.runtimeDir, key: `check-${basename(versionDir)}` };
    ensureVerifyDirs(isolation);
    const env = verifyEnv(this.#o.env, isolation);
    try {
      const tests = await this.#o.exec(["bun", "test", "./cloud/loop/test"], {
        cwd: versionDir,
        env,
        timeoutMs: 180_000,
      });
      if (tests.code !== 0 || tests.timedOut) return { ok: false, error: tests.output.trim() };
      const dryArgs = [
        "bun",
        "cloud/loop/src/pipeline-cli.ts",
        "--dry-run",
        ...(this.#o.configPath !== undefined ? ["--config", this.#o.configPath] : []),
      ];
      const dry = await this.#o.exec(dryArgs, {
        cwd: versionDir,
        env,
        timeoutMs: 60_000,
      });
      return dry.code === 0 && !dry.timedOut
        ? { ok: true }
        : { ok: false, error: dry.output.trim() };
    } finally {
      rmSync(runHomeDir(isolation.stateDir, isolation.key), { recursive: true, force: true });
    }
  }
}
