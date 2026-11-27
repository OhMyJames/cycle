// The workspace over `git` and `bun` (CYC-477, CYC-478). Every git carries full `GIT_SAFE` and clean config env;
// when `delivery` is configured, authenticated git commands run ONLY inside `<stateDir>/delivery.git` after verifying
// both the shared repo `.git/config` and `delivery.git/config` hashes.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ensureVerifyDirs,
  GIT_SAFE,
  gitCleanEnv,
  gitDeliverAuthArgs,
  gitDeliverEnv,
  verifyEnv,
} from "../env.ts";
import { withRepoLock } from "../git-lock.ts";
import type { Exec } from "../types.ts";
import type { At } from "./forge.ts";
import type { Done, Workspace } from "./workspace.ts";

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

export const hashGitConfig = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * Checks a git config file for directives that can redirect remotes, include arbitrary files, or run commands on
 * fetch/push (CYC-478): `include.*`, `includeIf.*`, `url.*.insteadOf`, `remote.*.pushurl`, `core.sshCommand`.
 */
export const inspectGitConfig = (
  text: string,
): { ok: true; hash: string } | { ok: false; reason: string } => {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, "").trim();
    if (line === "") continue;
    const sec = /^\[([^\s\]]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (sec !== null) {
      section = (sec[1] ?? "").toLowerCase();
      if (section === "include" || section === "includeif" || section === "filter") {
        return { ok: false, reason: `git config contains forbidden section [${sec[1]}]` };
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (key === "sshcommand") {
      return { ok: false, reason: "git config contains forbidden key core.sshCommand" };
    }
    if (key === "insteadof" || key === "pushinsteadof") {
      return { ok: false, reason: `git config contains forbidden key url.*.${key}` };
    }
    if (key === "pushurl") {
      return { ok: false, reason: "git config contains forbidden key remote.*.pushurl" };
    }
    if (key === "uploadpack" || key === "receivepack") {
      return { ok: false, reason: `git config contains forbidden key remote.*.${key}` };
    }
    if (section === "include" || section === "includeif" || section === "filter") {
      return { ok: false, reason: `git config contains forbidden directive in [${section}]` };
    }
  }
  return { ok: true, hash: hashGitConfig(text) };
};

/** Reads `[remote "origin"] url = ...` from a git config file (used as fallback when `repo.url` is omitted). */
export const originUrlFromGitConfig = (text: string): string | undefined => {
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, "").trim();
    if (line === "") continue;
    const sec = /^\[([^\s\]]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (sec !== null) {
      inOrigin = (sec[1] ?? "").toLowerCase() === "remote" && sec[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim().toLowerCase() === "url") {
      const url = line.slice(eq + 1).trim();
      if (url !== "") return url;
    }
  }
  return undefined;
};

/** Locates the shared `.git/config` for a checkout or worktree. */
export const repoGitConfigPath = (repoRoot: string): string | undefined => {
  const dotGit = join(repoRoot, ".git");
  if (!existsSync(dotGit)) return undefined;
  const st = statSync(dotGit);
  if (st.isDirectory()) {
    const cfg = join(dotGit, "config");
    return existsSync(cfg) ? cfg : undefined;
  }
  const text = readFileSync(dotGit, "utf8");
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  const rawDir = m?.[1]?.trim();
  if (rawDir === undefined || rawDir === "") return undefined;
  const gitDir = isAbsolute(rawDir) ? rawDir : resolve(repoRoot, rawDir);
  const commonFile = join(gitDir, "commondir");
  if (existsSync(commonFile)) {
    const rel = readFileSync(commonFile, "utf8").trim();
    const common = isAbsolute(rel) ? rel : resolve(gitDir, rel);
    const cfg = join(common, "config");
    if (existsSync(cfg)) return cfg;
  }
  const cfg = join(gitDir, "config");
  return existsSync(cfg) ? cfg : undefined;
};

export type DeliveryRepo = {
  dir: string;
  configPath: string;
  configHash: string;
};

/**
 * Creates or refreshes `<stateDir>/delivery.git` as a clean bare repository whose `config` holds only
 * `remote.origin.url = repoUrl` (CYC-478). Returns its path and config digest.
 */
export const initDeliveryRepo = async (
  stateDir: string,
  repoUrl: string,
  exec: Exec,
  env: Record<string, string | undefined>,
): Promise<DeliveryRepo> => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dir = join(stateDir, "delivery.git");
  const head = join(dir, "HEAD");
  if (!existsSync(head)) {
    const init = await exec(["git", ...GIT_SAFE, "init", "--bare", dir], {
      cwd: stateDir,
      env: gitCleanEnv(env, stateDir),
      timeoutMs: 30_000,
    });
    if (init.code !== 0) {
      throw new Error(`failed to initialize delivery.git: ${init.output.trim()}`);
    }
  }
  const configPath = join(dir, "config");
  const configText = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = true",
    '[remote "origin"]',
    `\turl = ${repoUrl}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    "",
  ].join("\n");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, configText, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { dir, configPath, configHash: hashGitConfig(configText) };
};

export type DeliveryConfig = {
  repo: DeliveryRepo;
  /** Expected sha256 of the shared `repoRoot/.git/config` read at startup. */
  repoConfigHash: string;
  /** Called whenever a config tamper is detected (e.g. to record a Notice). */
  onTamper?: (reason: string) => void;
};

export const gitWorkspace = (deps: {
  exec: Exec;
  env: Record<string, string | undefined>;
  /** The main checkout, where worktrees are made and fetches are serialised. */
  repoRoot: string;
  remote: string;
  stateDir?: string;
  delivery?: DeliveryConfig;
}): Workspace => {
  const { exec, env, repoRoot, remote, stateDir, delivery } = deps;
  const git = (at: At, args: string[]) =>
    exec(["git", ...GIT_SAFE, ...args], {
      cwd: at.cwd,
      env: gitCleanEnv(env, stateDir),
      timeoutMs: at.timeoutMs,
    });
  const gitDeliver = (at: At, args: string[]) =>
    exec(["git", ...GIT_SAFE, ...gitDeliverAuthArgs(env), ...args], {
      cwd: at.cwd,
      env: gitDeliverEnv(env, stateDir),
      timeoutMs: at.timeoutMs,
    });
  const checkRepoConfig = (): Done => {
    if (delivery === undefined) return { ok: true };
    const cfgPath = repoGitConfigPath(repoRoot);
    if (cfgPath === undefined) {
      const reason = "仓库配置被改动，未推送";
      delivery.onTamper?.(`${reason}（找不到 .git/config）`);
      return { ok: false, error: reason };
    }
    const text = readFileSync(cfgPath, "utf8");
    const inspected = inspectGitConfig(text);
    if (!inspected.ok || inspected.hash !== delivery.repoConfigHash) {
      const detail = inspected.ok ? "digest changed since startup" : inspected.reason;
      const reason = "仓库配置被改动，未推送";
      delivery.onTamper?.(`${reason}（${detail}）`);
      return { ok: false, error: reason };
    }
    return { ok: true };
  };
  const checkDeliveryConfig = (): Done => {
    if (delivery === undefined) return { ok: true };
    if (!existsSync(delivery.repo.configPath)) {
      const reason = "delivery.git 配置缺失，拒绝带凭据执行";
      delivery.onTamper?.(reason);
      return { ok: false, error: reason };
    }
    const text = readFileSync(delivery.repo.configPath, "utf8");
    const inspected = inspectGitConfig(text);
    if (!inspected.ok || inspected.hash !== delivery.repo.configHash) {
      const reason = "delivery.git 配置被改动，拒绝带凭据执行";
      delivery.onTamper?.(reason);
      return { ok: false, error: reason };
    }
    return { ok: true };
  };
  const done = (r: { code: number; output: string }) =>
    r.code === 0 ? ({ ok: true } as const) : ({ ok: false, error: r.output } as const);
  const mergeHead = async (at: At) =>
    (await git(at, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
  const freeKb: Workspace["freeKb"] = async (at) => {
    try {
      const out = await exec(["df", "-kP", at.cwd], {
        cwd: at.cwd,
        env: verifyEnv(env),
        timeoutMs: 10_000,
      });
      if (out.code !== 0) return undefined;
      // POSIX format: the Capacity column ("12%") sits right after Available, so anchor on it; a device name or
      // mount point with spaces cannot shift it. The header must name the column.
      const rows = out.output.trim().split("\n");
      if (rows.length !== 2 || !/avail/i.test(rows[0] ?? "")) return undefined;
      const row = (rows[1] ?? "").trim().split(/\s+/);
      const cap = row.findIndex((t) => /^\d+%$/.test(t));
      const field = cap > 0 ? (row[cap - 1] ?? "") : "";
      const free = /^\d+$/.test(field) ? Number(field) : Number.NaN;
      return Number.isSafeInteger(free) ? free : undefined;
    } catch {
      return undefined;
    }
  };

  const fetchMain: Workspace["fetchMain"] = (at) =>
    withRepoLock(repoRoot, async () => {
      if (delivery === undefined) return gitDeliver(at, ["fetch", remote]);
      const valid = checkDeliveryConfig();
      if (!valid.ok) return { code: 1, output: valid.error, timedOut: false };
      const dAt: At = { cwd: stateDir ?? dirname(delivery.repo.dir), timeoutMs: at.timeoutMs };
      const fetched = await gitDeliver(dAt, [
        "--git-dir",
        delivery.repo.dir,
        "fetch",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      if (fetched.code !== 0 || fetched.timedOut) return fetched;
      // Refresh repoRoot's origin/main from delivery.git without credentials.
      return git({ cwd: repoRoot, timeoutMs: at.timeoutMs }, [
        "fetch",
        delivery.repo.dir,
        "+refs/remotes/origin/main:refs/remotes/origin/main",
      ]);
    });

  return {
    fetchMain,
    push: async (at, branch) => {
      if (delivery === undefined)
        return gitDeliver(at, ["push", remote, `HEAD:refs/heads/${branch}`]);
      const repoOk = checkRepoConfig();
      if (!repoOk.ok) return { code: 1, output: repoOk.error, timedOut: false };
      const delOk = checkDeliveryConfig();
      if (!delOk.ok) return { code: 1, output: delOk.error, timedOut: false };
      const dAt: At = { cwd: stateDir ?? dirname(delivery.repo.dir), timeoutMs: at.timeoutMs };
      const stageRef = `refs/loop/${branch.replace(/[^A-Za-z0-9._/-]/g, "_")}`;
      const moved = await git(dAt, [
        "--git-dir",
        delivery.repo.dir,
        "fetch",
        at.cwd,
        `+HEAD:${stageRef}`,
      ]);
      if (moved.code !== 0 || moved.timedOut) return moved;
      const rev = await git(dAt, ["--git-dir", delivery.repo.dir, "rev-parse", stageRef]);
      if (rev.code !== 0 || rev.timedOut) return rev;
      const sha = rev.output.trim();
      return gitDeliver(dAt, [
        "--git-dir",
        delivery.repo.dir,
        "push",
        "origin",
        `${sha}:refs/heads/${branch}`,
      ]);
    },
    async head(at) {
      const r = await git(at, ["rev-parse", "HEAD"]);
      return r.code === 0 ? { ok: true, sha: r.output.trim() } : { ok: false, error: r.output };
    },
    async diff(at, base) {
      return (await git(at, ["diff", `${base}...HEAD`])).output;
    },
    async changedFiles(at, base) {
      const r = await git(at, ["diff", "--name-only", `${base}...HEAD`]);
      return r.output.split("\n").filter((line) => line.trim() !== "");
    },
    async log(at, base) {
      return (await git(at, ["log", "--oneline", `${base}..HEAD`])).output;
    },
    async commitSubjects(at, base) {
      return (await git(at, ["log", "--reverse", "--no-merges", "--format=%s", `${base}..HEAD`]))
        .output;
    },
    async snapshot(at) {
      const head = await git(at, ["rev-parse", "HEAD"]);
      const status = await git(at, ["status", "--porcelain"]);
      return `${head.output.trim()}\n${status.output}`;
    },
    async status(at) {
      const r = await git(at, ["status", "--porcelain"]);
      return r.code === 0 ? { ok: true, porcelain: r.output } : { ok: false, error: r.output };
    },
    async checkpoint(at, message) {
      const dirty = await git(at, ["status", "--porcelain"]);
      if (dirty.output.trim() === "") return;
      await git(at, ["add", "-A"]);
      await git(at, ["commit", "-m", message]);
    },
    mergeInProgress: mergeHead,
    async mergeMain(at, base) {
      return done(await git(at, ["merge", "--no-edit", base]));
    },
    async abortMerge(at) {
      return done(await git(at, ["merge", "--abort"]));
    },
    async resetHard(at, sha) {
      return done(await git(at, ["reset", "--hard", sha]));
    },
    async isAncestor(at, ref) {
      return (await git(at, ["merge-base", "--is-ancestor", ref, "HEAD"])).code === 0;
    },
    async unmergedFiles(at) {
      return lines((await git(at, ["diff", "--name-only", "--diff-filter=U"])).output);
    },
    async theirCommits(at, preMergeSha, base, files) {
      return lines(
        (await git(at, ["log", "--format=%s", `${preMergeSha}..${base}`, "--", ...files])).output,
      );
    },
    async conflictMarkers(at, files) {
      // Anchored at the start of a line, with the files taken literally.
      const r = await git(at, [
        "--literal-pathspecs",
        "grep",
        "--no-index",
        "-l",
        "-E",
        "-e",
        `^(${"<".repeat(7)}|${">".repeat(7)})( |$)`,
        "--",
        ...files,
      ]);
      if (r.code === 0)
        return { kind: "found", files: r.output.split("\n").filter((l) => l.trim() !== "") };
      if (r.code === 1) return { kind: "clean" };
      return { kind: "error", output: r.output };
    },
    async stage(at, files) {
      await git(at, ["--literal-pathspecs", "add", "-A", "--", ...files]);
    },
    async commitMerge(at) {
      return done(await git(at, ["commit", "--no-edit"]));
    },
    async conflictProbe(at, base) {
      await fetchMain(at);
      const merged = await git(at, [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "HEAD",
        base,
      ]);
      if (merged.code !== 1) return [];
      return lines(merged.output.split("\n").slice(1).join("\n"));
    },
    async install(at, runKey) {
      const isolation =
        stateDir !== undefined && runKey !== undefined ? { stateDir, key: runKey } : undefined;
      if (isolation !== undefined) ensureVerifyDirs(isolation);
      return done(
        await exec(["bun", "install"], {
          cwd: at.cwd,
          env: verifyEnv(env, isolation),
          timeoutMs: at.timeoutMs,
        }),
      );
    },
    async nodeModulesDirs(at) {
      const status = await git(at, ["status", "--porcelain"]);
      if (status.code !== 0) return { ok: false, reason: "status_failed" };
      if (status.output.trim() !== "") return { ok: false, reason: "dirty" };
      const listed = await git(at, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ]);
      if (listed.code !== 0) return { ok: false, reason: "list_failed" };
      const dirs = listed.output
        .split("\0")
        .map((l) => l.trim().replace(/\/+$/, ""))
        .filter(
          (d) =>
            d !== "" &&
            !d.startsWith("/") &&
            !d.split("/").includes("..") &&
            d.split("/").at(-1) === "node_modules",
        );
      return { ok: true, dirs };
    },
    async releaseNodeModules(at, dirs) {
      return done(
        await exec(["rm", "-rf", "--", ...dirs], {
          cwd: at.cwd,
          env: verifyEnv(env),
          timeoutMs: at.timeoutMs,
        }),
      );
    },
    freeKb,
    async remove(at, worktree, branches) {
      const status = await git({ ...at, cwd: worktree }, ["status", "--porcelain"]);
      if (status.code !== 0) return "failed";
      if (status.output.trim() !== "") return "dirty";
      // No --force: git itself refuses a worktree with changes in it.
      const removed = await git(at, ["worktree", "remove", worktree]);
      if (removed.code !== 0) return "failed";
      for (const branch of branches) {
        const exists = await git(at, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (exists.code !== 0) continue;
        const deleted = await git(at, ["branch", "-D", branch]);
        if (deleted.code !== 0) return "failed";
      }
      return "removed";
    },
    async configClean() {
      return checkRepoConfig();
    },
  };
};
