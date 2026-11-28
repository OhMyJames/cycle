// The daemon updating itself (docs/daemon.md "自动更新", CYC-538): it looks at its release channel (channel.ts) from time
// to time, downloads a newer version beside its own folder, checks it, and switches to it once nothing is working. No
// person is asked. What goes wrong is logged and tried again later; the running version stays.
//
// The folder it runs from (`installDir`, the one with `cycle` and the agents' binaries) has two siblings while an update
// is under way, on the same volume so that a switch is a rename:
//
//   <installDir>.staged       the next version, complete and checked; `<installDir>.staged.json` says which it is
//   <installDir>.old          the version before, kept until the new one has run for a while
//
// The app may put a version in `.staged` too (the one it carries, when the installed one is older): it is taken the same
// way. Every step is injected, so the tests drive it with a fake channel and fake folders.
import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  blobName,
  channelBaseUrl,
  type DaemonManifest,
  daemonManifestName,
  daemonSignatureName,
  parseDaemonManifest,
  protocolMajor,
} from "./channel.ts";
import type { Logger } from "./logger.ts";
import type { ReleaseKeys } from "./release-keys.ts";
import { olderThan, VERSION_FORMAT } from "./version.ts";

/** How often the channel is looked at, and how soon after the start. */
export const CHECK_EVERY_MS = 30 * 60_000;
export const FIRST_CHECK_MS = 2 * 60_000;
/** How often, with a version ready, the daemon asks itself whether it is idle. */
export const APPLY_EVERY_MS = 30_000;
/** How long nothing may have happened in any session before the daemon counts as idle: not to switch between two messages. */
export const QUIET_MS = 15_000;
/** How long a new version is kept from being cleaned up as the one before, once it runs. */
export const KEEP_OLD_MS = 10 * 60_000;

const SMALL_DEADLINE_MS = 30_000;
const FILE_DEADLINE_MS = 30 * 60_000;

export const stagedDir = (installDir: string): string => `${installDir}.staged`;
export const stagedNote = (installDir: string): string => `${installDir}.staged.json`;
export const oldDir = (installDir: string): string => `${installDir}.old`;
/** Where one process builds a version: its own, so a daemon and `cycle update` at the same time do not meet. */
const stagingDir = (installDir: string, pid = process.pid): string =>
  `${installDir}.staging-${pid}`;
const badDir = (installDir: string): string => `${installDir}.bad`;

/** What `.staged` holds, as `<installDir>.staged.json` says. */
export type Staged = { version: string };

/** Why the newest version on the channel was not taken, when it was newer than this one. */
export type Skipped =
  | "manifest_invalid"
  | "signature_refused"
  | "wrong_platform"
  | "failed_before"
  | "needs_manual_update";

/** Where a version that is ready stands: looking for a quiet moment, or draining (no new turns; docs/daemon.md "自动更新"). */
export type UpdatePhase = {
  state: "waiting" | "draining";
  /** Epoch ms it entered `state`. */
  since: number;
  /** While draining and a force limit is set: epoch ms the daemon switches whatever is still working. */
  forceAt?: number;
};

export type SelfUpdateState =
  | { updates: "off"; why: string }
  | { updates: "on"; pending?: Staged; phase?: UpdatePhase; error?: string; skipped?: Skipped };

type Log = Pick<Logger, "info" | "warn">;

export type SelfUpdateDeps = {
  version: string;
  platform: string;
  arch: string;
  /** The Cycle protocol version this daemon speaks: a daemon only moves to one of the same major. */
  protocol: string;
  /** The folder this daemon runs from: `cycle` and the agents' binaries. */
  installDir: string;
  keys: ReleaseKeys;
  verify: (bytes: Uint8Array, signature: string, keyId: string, keys: ReleaseKeys) => boolean;
  fetch: typeof fetch;
  /** Replaces the channel's address; for the tests, a loopback one. */
  baseUrl?: string;
  /** Where the versions that would not start are remembered. */
  stateFile: string;
  /**
   * Checks a complete folder before it is staged: its `cycle version` is `version`, and on macOS every program in it is
   * signed by the same team as this one. Throws with the reason when it is not.
   */
  check: (dir: string, version: string) => Promise<void>;
  /** Whether the daemon has had nothing working for a while (`Daemon.quietForUpdate`). */
  idle: () => Promise<boolean>;
  /** While draining: whether nothing is left to wait for (`Daemon.drainedForUpdate`). */
  drained?: () => Promise<boolean>;
  /** Draining starts and ends (`Daemon.setDraining`). */
  setDraining?: (draining: boolean) => void;
  /** Before a forced switch: notes what it will cut short, and says how much (`Daemon.noteForcedStop`). */
  forced?: () => Promise<{ sessions: number; background: number }>;
  /** The state changed: clients that take it are told (`Daemon.announceUpdate`). */
  changed?: () => void;
  /** Minutes in waiting before draining, and in draining before forcing; undefined: not that step. */
  drainAfterMs?: number | undefined;
  forceAfterMs?: number | undefined;
  now?: () => number;
  /** Stops this daemon, switches folders and starts the new one (serve.ts). Does not return when it worked. */
  apply: (staged: Staged) => Promise<void>;
  log: Log;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

/** Why a daemon cannot update itself, or undefined when it can. */
export const whyNotUpdatable = (o: {
  version: string;
  install: { kind: string };
  keys: ReleaseKeys;
  env: Record<string, string | undefined>;
}): string | undefined => {
  if (!VERSION_FORMAT.test(o.version)) return "not a release build";
  if (o.env.CYCLE_DAEMON_UPDATES === "off") return "turned off (CYCLE_DAEMON_UPDATES=off)";
  if (Object.keys(o.keys).length === 0) return "no release key is built in";
  if (o.install.kind === "bundled") return "it runs from inside the app";
  if (o.install.kind === "source") return "it runs from source";
  if (o.install.kind !== "installed" && o.install.kind !== "managed")
    return "it is not where an installer puts it";
  return undefined;
};

const sha256OfFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

/** The versions that were switched to and did not start: never taken again. */
export const readBad = async (stateFile: string): Promise<string[]> => {
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8")) as { bad?: unknown };
    return Array.isArray(value.bad) ? value.bad.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
};

export const recordBad = async (stateFile: string, version: string): Promise<void> => {
  const bad = new Set(await readBad(stateFile));
  bad.add(version);
  await mkdir(dirname(stateFile), { recursive: true });
  const aside = `${stateFile}.${process.pid}.tmp`;
  await writeFile(aside, `${JSON.stringify({ bad: [...bad].slice(-20) })}\n`, { mode: 0o600 });
  await rename(aside, stateFile);
};

/** What `.staged` holds, when it is complete. */
export const readStaged = async (installDir: string): Promise<Staged | undefined> => {
  if (!existsSync(join(stagedDir(installDir), "cycle"))) return undefined;
  try {
    const value = JSON.parse(await readFile(stagedNote(installDir), "utf8")) as {
      version?: unknown;
    };
    return typeof value.version === "string" && VERSION_FORMAT.test(value.version)
      ? { version: value.version }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Puts a complete, checked folder in `.staged`: the old staged one goes first, the note last, so a reader sees either
 * nothing or all of it.
 */
export const putStaged = async (installDir: string, ready: string, version: string) => {
  await rm(stagedNote(installDir), { force: true });
  await rm(stagedDir(installDir), { recursive: true, force: true });
  await rename(ready, stagedDir(installDir));
  const aside = `${stagedNote(installDir)}.${process.pid}.tmp`;
  await writeFile(aside, `${JSON.stringify({ version })}\n`, { mode: 0o600 });
  await rename(aside, stagedNote(installDir));
};

/**
 * The switch: the running folder becomes `.old` and `.staged` takes its place. Called with the daemon stopped and its
 * socket still held, so nothing starts the daemon from a half-switched folder.
 */
export const swapIn = async (installDir: string): Promise<void> => {
  await rm(oldDir(installDir), { recursive: true, force: true });
  await rename(installDir, oldDir(installDir));
  try {
    await rename(stagedDir(installDir), installDir);
  } catch (error) {
    await rename(oldDir(installDir), installDir);
    throw error;
  }
  await rm(stagedNote(installDir), { force: true });
};

/** Undoes `swapIn` when the new version did not start: it is thrown away, and the one before is back. */
export const swapBack = async (installDir: string): Promise<void> => {
  await rm(badDir(installDir), { recursive: true, force: true });
  if (existsSync(installDir)) await rename(installDir, badDir(installDir));
  await rename(oldDir(installDir), installDir);
  await rm(badDir(installDir), { recursive: true, force: true });
};

/** Removes the half-built versions of processes that are gone (a crash, a kill during a download). */
const cleanStaleStaging = async (installDir: string): Promise<void> => {
  const parent = dirname(installDir);
  const prefix = `${basename(installDir)}.staging-`;
  for (const name of await readdir(parent)) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {}
    if (!alive) await rm(join(parent, name), { recursive: true, force: true });
  }
};

/** Throws away what is staged: a version that cannot be switched to. */
export const forgetStaged = async (installDir: string): Promise<void> => {
  await rm(stagedNote(installDir), { force: true });
  await rm(stagedDir(installDir), { recursive: true, force: true });
};

/** After a version has run for a while, the one before it is not needed to go back to. */
export const forgetOld = (installDir: string): Promise<void> =>
  rm(oldDir(installDir), { recursive: true, force: true });

/** A copy that costs no space where the volume can clone (APFS, btrfs), and a plain copy elsewhere. */
const cloneFile = (from: string, to: string) => copyFile(from, to, constants.COPYFILE_FICLONE);

export class SelfUpdate {
  readonly #d: SelfUpdateDeps;
  #pending: Staged | undefined;
  #error: string | undefined;
  #skipped: Skipped | undefined;
  #etag: string | undefined;
  #busy = false;
  #applying = false;
  #timers: unknown[] = [];
  #waitingSince: number | undefined;
  #drainingSince: number | undefined;
  #quietTimer: unknown;

  constructor(deps: SelfUpdateDeps) {
    this.#d = deps;
  }

  get state(): SelfUpdateState {
    return {
      updates: "on",
      ...(this.#pending !== undefined ? { pending: this.#pending } : {}),
      ...(this.#phase() !== undefined ? { phase: this.#phase() as UpdatePhase } : {}),
      ...(this.#error !== undefined ? { error: this.#error } : {}),
      ...(this.#skipped !== undefined ? { skipped: this.#skipped } : {}),
    };
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  #phase(): UpdatePhase | undefined {
    if (this.#pending === undefined) return undefined;
    if (this.#drainingSince !== undefined) {
      const forceAfter = this.#d.forceAfterMs;
      return {
        state: "draining",
        since: this.#drainingSince,
        ...(forceAfter !== undefined ? { forceAt: this.#drainingSince + forceAfter } : {}),
      };
    }
    return this.#waitingSince !== undefined
      ? { state: "waiting", since: this.#waitingSince }
      : undefined;
  }

  /** Back to no phase: nothing is pending, or the switch did not work. Draining ends. */
  #resetPhase(): void {
    const wasDraining = this.#drainingSince !== undefined;
    this.#waitingSince = undefined;
    this.#drainingSince = undefined;
    if (wasDraining) this.#d.setDraining?.(false);
    if (wasDraining) this.#d.changed?.();
  }

  /**
   * A turn or a background task has ended: look now instead of at the next poll. With a quiet time asked, the look
   * right after an end finds it not yet over, so one more is made when it is.
   */
  nudge(): void {
    void this.tryApply();
    const later = this.#d.setTimeout ?? setTimeout;
    const clear = this.#d.clearInterval ?? clearTimeout;
    if (this.#quietTimer !== undefined) clear(this.#quietTimer as never);
    if (this.#pending === undefined) return;
    this.#quietTimer = later(() => void this.tryApply(), QUIET_MS + 250);
  }

  /** Looks for a version staged before this daemon started (by the app, or by a daemon that stopped before switching). */
  async start(): Promise<void> {
    const d = this.#d;
    await cleanStaleStaging(d.installDir).catch(() => {});
    await this.#adoptStaged();
    const later = d.setTimeout ?? setTimeout;
    const every = d.setInterval ?? setInterval;
    this.#timers.push(
      later(() => void this.check(), FIRST_CHECK_MS),
      every(() => void this.check(), CHECK_EVERY_MS),
      every(() => void this.tryApply(), APPLY_EVERY_MS),
      // The version before this one is kept only until this one has proved itself.
      later(() => void forgetOld(d.installDir).catch(() => {}), KEEP_OLD_MS),
    );
  }

  stop(): void {
    const clear = this.#d.clearInterval ?? clearInterval;
    for (const timer of this.#timers) clear(timer as never);
    if (this.#quietTimer !== undefined) clear(this.#quietTimer as never);
    this.#quietTimer = undefined;
    this.#timers = [];
  }

  /** A staged version is taken if it is newer than this one and not one that failed. */
  async #adoptStaged(): Promise<void> {
    const staged = await readStaged(this.#d.installDir);
    if (staged === undefined) return;
    const bad = await readBad(this.#d.stateFile);
    if (!olderThan(this.#d.version, staged.version) || bad.includes(staged.version)) {
      await rm(stagedDir(this.#d.installDir), { recursive: true, force: true });
      await rm(stagedNote(this.#d.installDir), { force: true });
      return;
    }
    if (this.#pending === undefined || olderThan(this.#pending.version, staged.version))
      this.#pending = staged;
  }

  /** Once, with a version ready and the daemon idle, switches to it. */
  async tryApply(): Promise<boolean> {
    if (this.#applying || this.#busy) return false;
    // Taken before anything is awaited: a look at the channel must not start while the folders may be switched.
    this.#applying = true;
    let pending: Staged | undefined;
    try {
      await this.#adoptStaged().catch(() => {});
      pending = this.#pending;
      if (pending === undefined) {
        this.#resetPhase();
        return false;
      }
      const now = this.#now();
      if (this.#waitingSince === undefined) {
        this.#waitingSince = now;
        this.#d.changed?.();
      }
      if (
        this.#drainingSince === undefined &&
        this.#d.drainAfterMs !== undefined &&
        now - this.#waitingSince >= this.#d.drainAfterMs
      ) {
        this.#drainingSince = now;
        this.#d.setDraining?.(true);
        this.#d.log.info("self_update_draining", { to: pending.version });
        this.#d.changed?.();
      }
      if (this.#drainingSince === undefined) {
        if (!(await this.#d.idle())) return false;
      } else if (!(await (this.#d.drained ?? this.#d.idle)())) {
        if (this.#d.forceAfterMs === undefined || now - this.#drainingSince < this.#d.forceAfterMs)
          return false;
        const cut = (await this.#d.forced?.()) ?? { sessions: 0, background: 0 };
        this.#d.log.info("self_update_forced", {
          to: pending.version,
          sessions: cut.sessions,
          background: cut.background,
        });
      }
      this.#d.log.info("self_update_switching", { from: this.#d.version, to: pending.version });
      await this.#d.apply(pending);
      return true;
    } catch (error) {
      this.#resetPhase();
      this.#d.log.warn("self_update_switch_failed", {
        to: pending?.version ?? "",
        error: String(error),
      });
      this.#pending = undefined;
      return false;
    } finally {
      this.#applying = false;
    }
  }

  async #get(url: string, headers: Record<string, string>, ms: number): Promise<Response> {
    return this.#d.fetch(url, { headers, signal: AbortSignal.timeout(ms), redirect: "follow" });
  }

  /** Looks at the channel, and stages a newer version when there is one. Never throws. */
  async check(): Promise<SelfUpdateState> {
    if (this.#busy || this.#applying) return this.state;
    this.#busy = true;
    const d = this.#d;
    try {
      const base = d.baseUrl ?? channelBaseUrl();
      const answer = await this.#get(
        `${base}${daemonManifestName(d.platform, d.arch)}`,
        this.#etag !== undefined ? { "If-None-Match": this.#etag } : {},
        SMALL_DEADLINE_MS,
      );
      if (answer.status === 304 || answer.status === 404) {
        this.#error = undefined;
        if (answer.status === 404) this.#skipped = undefined;
        return this.state;
      }
      if (!answer.ok) throw new Error(`The daemon manifest answered ${answer.status}.`);
      const etag = answer.headers.get("etag") ?? undefined;
      const bytes = new Uint8Array(await answer.arrayBuffer());
      const sig = await this.#get(
        `${base}${daemonSignatureName(d.platform, d.arch)}`,
        {},
        SMALL_DEADLINE_MS,
      );
      if (!sig.ok) throw new Error(`The daemon manifest's signature answered ${sig.status}.`);
      const signature = await sig.text();
      // What follows does not change by asking again: the manifest is not fetched again until it changes.
      const settled = (skipped?: Skipped, fields: Record<string, string> = {}): SelfUpdateState => {
        this.#etag = etag;
        this.#error = undefined;
        this.#skipped = skipped;
        if (skipped !== undefined) d.log.warn(`self_update_${skipped}`, fields);
        return this.state;
      };
      const manifest = parseDaemonManifest(bytes);
      if (manifest === undefined) return settled("manifest_invalid");
      if (!d.verify(bytes, signature, manifest.keyId, d.keys))
        return settled("signature_refused", { keyId: manifest.keyId });
      if (manifest.platform !== d.platform || manifest.arch !== d.arch)
        return settled("wrong_platform");
      if (!olderThan(d.version, manifest.version)) return settled();
      if (this.#pending !== undefined && !olderThan(this.#pending.version, manifest.version))
        return settled();
      if ((await readBad(d.stateFile)).includes(manifest.version))
        return settled("failed_before", { to: manifest.version });
      if (protocolMajor(manifest.protocol) !== protocolMajor(d.protocol))
        return settled("needs_manual_update", { to: manifest.version });
      await this.#stage(manifest, base);
      this.#etag = etag;
      this.#error = undefined;
      this.#skipped = undefined;
      this.#pending = { version: manifest.version };
      d.log.info("self_update_staged", { from: d.version, to: manifest.version });
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      d.log.warn("self_update_check_failed", { error: this.#error });
    } finally {
      this.#busy = false;
    }
    return this.state;
  }

  /** Builds the folder a manifest describes, from the installed files where they are the same and the channel where not. */
  async #stage(manifest: DaemonManifest, base: string): Promise<void> {
    const d = this.#d;
    const into = stagingDir(d.installDir);
    await rm(into, { recursive: true, force: true });
    await mkdir(into, { recursive: true, mode: 0o755 });
    let fetched = 0;
    let reused = 0;
    try {
      for (const [path, file] of Object.entries(manifest.files)) {
        const target = join(into, path);
        await mkdir(dirname(target), { recursive: true });
        const installed = join(d.installDir, path);
        const same =
          existsSync(installed) &&
          (await stat(installed)).size === file.size &&
          (await sha256OfFile(installed)) === file.sha256;
        if (same) {
          await cloneFile(installed, target);
          reused++;
        } else {
          await this.#download(`${base}${blobName(file.sha256)}`, target, file.sha256, file.size);
          fetched++;
        }
        await chmod(target, file.mode);
      }
      await d.check(into, manifest.version);
      await putStaged(d.installDir, into, manifest.version);
      d.log.info("self_update_downloaded", { files: fetched, reused });
    } catch (error) {
      await rm(into, { recursive: true, force: true });
      throw error;
    }
  }

  /** One gzipped file of the channel, unpacked as it arrives, and refused unless it is the size and hash it should be. */
  async #download(url: string, target: string, sha256: string, size: number): Promise<void> {
    const answer = await this.#get(url, {}, FILE_DEADLINE_MS);
    if (!answer.ok || answer.body === null)
      throw new Error(`A daemon file answered ${answer.status}.`);
    const hash = createHash("sha256");
    const out = Bun.file(target).writer();
    let written = 0;
    try {
      for await (const chunk of answer.body.pipeThrough(new DecompressionStream("gzip"))) {
        written += chunk.byteLength;
        if (written > size) throw new Error("A daemon file is larger than its manifest says.");
        hash.update(chunk);
        out.write(chunk);
      }
    } finally {
      await out.end();
    }
    if (written !== size || hash.digest("hex") !== sha256)
      throw new Error("A daemon file is not what its manifest says.");
  }
}
