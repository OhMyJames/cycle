// `bun run alpha`: build one local alpha from the current code. `bun run alpha:watch`: every 5 minutes, fetch
// origin/main and build an alpha when it has a commit the repository does not have yet.
//
//   bun scripts/alpha.ts [--watch] [--interval <seconds>]
//
// An alpha is signed with the fixed local certificate "Cycle Alpha (local)" (made on first use, in the login
// keychain) and put into the alpha repository, `<CYCLE_HOME>/alpha/<version>/` (`+` written `_`): the zip and
// a `manifest.json`. The newest 3 are kept, and the installed one is never removed. The installed app's updater
// reads that folder (apps/desktop/src/main/updater.ts). Git, the build, signing and the certificate are passed
// in (`Deps`), so the tests run none of them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MAC_BUNDLE } from "../apps/desktop/src/main/layout.ts";
import {
  archiveName,
  isNewer,
  manifestFor,
  parseVersion,
} from "../apps/desktop/src/shared/release.ts";

export const CERT_NAME = "Cycle Alpha (local)";
export const KEEP = 3;
export const WATCH_INTERVAL_MS = 5 * 60 * 1000;
export const INSTALLED_APP = "/Applications/Cycle.app";

export type Described = {
  short: string;
  count: number;
  subject: string;
  dirty: boolean;
  /** `version` in apps/desktop/package.json. */
  baseVersion: string;
};

export type Git = {
  fetch: () => void;
  /** The full commit origin/main is at. */
  remote: () => string;
  /** Puts the alpha worktree (made when missing) at `commit`, detached; returns its folder. */
  checkout: (commit: string) => string;
  /** Describes the code in `dir`. */
  describe: (dir: string) => Described;
};

export type Built = { app: string; platform: string; arch: string };

export type Deps = {
  /** `<CYCLE_HOME>/alpha`. */
  repo: string;
  /** The folder of the current code, for `alpha`. */
  root: string;
  git: Git;
  /** Packages the code in `dir` as `version`. */
  build: (dir: string, version: string) => Promise<Built>;
  /** Makes sure the certificate exists (generating it when not), and returns when it can sign. */
  ensureCert: () => void;
  sign: (app: string) => void;
  archive: (app: string, zip: string) => { sha256: string; size: number };
  /** The version of the installed app, when there is one. */
  installed: () => string | undefined;
  isAlive: (pid: number) => boolean;
  pid: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

/** The next patch of a release, then `-alpha.<commits>` and `+<commit>[.dirty]`. */
export const alphaVersion = (d: Described): string => {
  const base = parseVersion(d.baseVersion);
  if (!base || base.alpha !== undefined)
    throw new Error(`${d.baseVersion} is not a release version.`);
  return `${base.major}.${base.minor}.${base.patch + 1}-alpha.${d.count}+${d.short}${d.dirty ? ".dirty" : ""}`;
};

export const folderOf = (version: string): string => version.replaceAll("+", "_");
const versionOf = (folder: string): string => folder.replace("_", "+");

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

type Failures = Record<string, { version: string; error: string; at: string }>;

export const failuresOf = (repo: string): Failures => readJson(join(repo, "failures.json"), {});

const recordFailure = (d: Deps, commit: string, version: string, error: string) => {
  const failures = failuresOf(d.repo);
  failures[commit] = { version, error, at: d.now().toISOString() };
  writeFileSync(join(d.repo, "failures.json"), `${JSON.stringify(failures, null, 2)}\n`);
};

/** The versions in the repository: folders with a manifest (a `.partial` one is not done). */
export const versionsIn = (repo: string): string[] => {
  if (!existsSync(repo)) return [];
  return readdirSync(repo)
    .filter((n) => !n.startsWith(".") && existsSync(join(repo, n, "manifest.json")))
    .map(versionOf);
};

/** Newest first; the same alpha number (a dirty rebuild) by name. */
const newestFirst = (a: string, b: string): number =>
  isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : b.localeCompare(a);

/** Keeps the newest `KEEP` and the installed one; returns what it removed. */
export const prune = (repo: string, installed: string | undefined): string[] => {
  const removed: string[] = [];
  const all = versionsIn(repo).sort(newestFirst);
  for (const [i, version] of all.entries()) {
    if (i < KEEP || version === installed) continue;
    rmSync(join(repo, folderOf(version)), { recursive: true, force: true });
    removed.push(version);
  }
  return removed;
};

const LOCK = ".lock";

/** Takes the lock, or says why not. A lock whose process is gone is taken over. */
const lock = (d: Deps): boolean => {
  mkdirSync(d.repo, { recursive: true });
  const path = join(d.repo, LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(d.pid), { flag: "wx" });
      return true;
    } catch {
      const holder = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && d.isAlive(holder)) {
        d.log(`Another alpha build is running (pid ${holder}); not building.`);
        return false;
      }
      rmSync(path, { force: true });
    }
  }
  return false;
};

const unlock = (d: Deps) => rmSync(join(d.repo, LOCK), { force: true });

/** Builds, signs and files the alpha for the code in `dir`. */
const make = async (d: Deps, dir: string, info: Described, commit: string, version: string) => {
  const built = await d.build(dir, version);
  d.ensureCert();
  d.sign(built.app);
  const final = join(d.repo, folderOf(version));
  const partial = `${final}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const file = archiveName(version, built.platform, built.arch);
  const archive = d.archive(built.app, join(partial, file));
  const manifest = {
    ...manifestFor({ version, platform: built.platform, arch: built.arch }, archive),
    commit,
    subject: info.subject,
    builtAt: d.now().toISOString(),
  };
  writeFileSync(join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(final, { recursive: true, force: true });
  renameSync(partial, final);
};

const sweepPartials = (repo: string) => {
  for (const n of readdirSync(repo)) {
    if (n.endsWith(".partial")) rmSync(join(repo, n), { recursive: true, force: true });
  }
};

export type ManualResult = "built" | "older" | "locked" | "failed";

/** `bun run alpha`: one alpha of the code as it is now. */
export const buildNow = async (d: Deps): Promise<ManualResult> => {
  const info = d.git.describe(d.root);
  const version = alphaVersion(info);
  const installed = d.installed();
  if (installed && isNewer(installed, version)) {
    d.log(`Not building: the installed Cycle is ${installed}, newer than this code (${version}).`);
    return "older";
  }
  if (!lock(d)) return "locked";
  try {
    sweepPartials(d.repo);
    await make(d, d.root, info, info.short, version);
    d.log(`Built ${version} into ${join(d.repo, folderOf(version))}.`);
    if (installed && !isNewer(version, installed)) {
      d.log(`It is the version installed (${installed}): reinstall it from Cycle's update menu.`);
    }
    for (const v of prune(d.repo, installed)) d.log(`Removed ${v}.`);
    return "built";
  } catch (e) {
    d.log(`Build failed: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  } finally {
    unlock(d);
  }
};

/**
 * One pass of `alpha:watch`: fetch, and while origin/main has a commit with no alpha and no recorded failure,
 * build it. A build takes minutes, so main is looked at again after each: only the newest is built next.
 */
export const watchOnce = async (d: Deps): Promise<string[]> => {
  const built: string[] = [];
  for (;;) {
    d.git.fetch();
    const commit = d.git.remote();
    if (commit in failuresOf(d.repo)) return built;
    const dir = d.git.checkout(commit);
    const info = d.git.describe(dir);
    const version = alphaVersion(info);
    if (versionsIn(d.repo).includes(version)) return built;
    if (!lock(d)) return built;
    try {
      sweepPartials(d.repo);
      d.log(`Building ${version}: ${info.subject}`);
      await make(d, dir, info, commit, version);
      built.push(version);
      d.log(`Built ${version}.`);
      for (const v of prune(d.repo, d.installed())) d.log(`Removed ${v}.`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      recordFailure(d, commit, version, error);
      d.log(`Build of ${version} failed (recorded; it is not retried): ${error}`);
      return built;
    } finally {
      unlock(d);
    }
  }
};

export const watch = async (
  d: Deps,
  stop: () => boolean = () => false,
  intervalMs = WATCH_INTERVAL_MS,
) => {
  while (!stop()) {
    try {
      await watchOnce(d);
    } catch (e) {
      d.log(`Watch pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (stop()) return;
    await d.sleep(intervalMs);
  }
};

// The certificate -------------------------------------------------------------------------------------------

export type Run = (command: string, args: string[]) => { code: number; out: string };

/** Whether the certificate is in the keychains. Not `find-identity -v`: it lists only trusted identities, and this one is self-signed. */
export const certExists = (run: Run): boolean =>
  run("/usr/bin/security", ["find-certificate", "-c", CERT_NAME]).code === 0;

/**
 * Makes the certificate when there is none, as the owner did by hand: a self-signed, code-signing-only
 * certificate valid 10 years, imported into the login keychain so that only /usr/bin/codesign may use its key.
 */
export const ensureCert = (
  run: Run,
  log: (line: string) => void,
  scratch: () => string,
  home = homedir(),
): void => {
  if (certExists(run)) return;
  log(
    `There is no "${CERT_NAME}" certificate. Making one: a self-signed code-signing certificate, valid 10 years, ` +
      `imported into your login keychain with its key usable only by /usr/bin/codesign. Every alpha is signed with it, ` +
      `so the keychain recognises each new alpha as the same app and asks only once.`,
  );
  const dir = scratch();
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const p12 = join(dir, "cert.p12");
  const password = createHash("sha256").update(`${Math.random()}${Date.now()}`).digest("hex");
  const step = (command: string, args: string[]) => {
    const r = run(command, args);
    if (r.code !== 0) throw new Error(`${command} ${args[0]} failed: ${r.out}`);
  };
  try {
    step("/usr/bin/openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "3650",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      `/CN=${CERT_NAME}`,
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=critical,codeSigning",
    ]);
    step("/usr/bin/openssl", [
      "pkcs12",
      "-export",
      "-legacy",
      "-inkey",
      key,
      "-in",
      cert,
      "-out",
      p12,
      "-name",
      CERT_NAME,
      "-passout",
      `pass:${password}`,
    ]);
    step("/usr/bin/security", [
      "import",
      p12,
      "-k",
      join(home, "Library/Keychains/login.keychain-db"),
      "-P",
      password,
      "-T",
      "/usr/bin/codesign",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!certExists(run))
    throw new Error(`"${CERT_NAME}" is still not in the keychain after import.`);
};

// The real things ---------------------------------------------------------------------------------------------

const sh = (command: string, args: string[], cwd?: string, env?: Record<string, string>) => {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

const must = (command: string, args: string[], cwd?: string, env?: Record<string, string>) => {
  const r = sh(command, args, cwd, env);
  if (r.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${r.out.slice(-2000)}`);
  return r.out;
};

const realGit = (root: string): Git => {
  const tree = join(root, ".agents/worktree/alpha");
  const git = (cwd: string, ...args: string[]) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
    );
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  return {
    fetch: () => void git(root, "fetch", "origin", "main"),
    remote: () => git(root, "rev-parse", "origin/main"),
    checkout: (commit) => {
      if (!existsSync(tree)) git(root, "worktree", "add", "--detach", tree, commit);
      else git(tree, "checkout", "--detach", "--force", commit);
      return tree;
    },
    describe: (dir) => ({
      short: git(dir, "rev-parse", "--short", "HEAD"),
      count: Number(git(dir, "rev-list", "--count", "HEAD")),
      subject: git(dir, "log", "-1", "--format=%s"),
      dirty: git(dir, "status", "--porcelain") !== "",
      baseVersion: String(
        JSON.parse(readFileSync(join(dir, "apps/desktop/package.json"), "utf8")).version,
      ),
    }),
  };
};

const realDeps = (root: string): Deps => {
  const home = process.env.CYCLE_HOME?.trim() || join(homedir(), ".cycle");
  const run: Run = (command, args) => sh(command, args);
  return {
    repo: join(home, "alpha"),
    root,
    git: realGit(root),
    build: async (dir, version) => {
      if (process.platform !== "darwin") throw new Error("Alphas are built on macOS.");
      if (dir !== root) must("bun", ["install", "--frozen-lockfile"], dir);
      must("bun", ["apps/desktop/scripts/package.ts"], dir, { CYCLE_VERSION: version });
      return {
        app: join(dir, "apps/desktop/build", MAC_BUNDLE),
        platform: process.platform,
        arch: process.arch,
      };
    },
    ensureCert: () =>
      ensureCert(run, console.log, () => mkdtempSync(join(tmpdir(), "cycle-alpha-cert-"))),
    sign: (app) => {
      must("/usr/bin/codesign", ["--force", "--deep", "--sign", CERT_NAME, app]);
      must("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    },
    archive: (app, zip) => {
      must("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
      return {
        sha256: createHash("sha256").update(readFileSync(zip)).digest("hex"),
        size: statSync(zip).size,
      };
    },
    installed: () => {
      const file = join(INSTALLED_APP, "Contents/Resources/app/build.json");
      const v = readJson<{ version?: string }>(file, {}).version;
      return typeof v === "string" ? v : undefined;
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    pid: process.pid,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
  };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const deps = realDeps(root);
  try {
    if (args.includes("--watch")) {
      const i = args.indexOf("--interval");
      const seconds = i >= 0 ? Number(args[i + 1]) : WATCH_INTERVAL_MS / 1000;
      deps.log(`Watching origin/main every ${seconds}s.`);
      await watch(deps, () => false, seconds * 1000);
    } else {
      const result = await buildNow(deps);
      process.exit(result === "built" ? 0 : 1);
    }
  } catch (e) {
    console.error(`alpha: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
