// Where the app's own daemon runs from (docs/desktop.md "本机 daemon", CYC-538): `<CYCLE_HOME>/daemon/bin`, a folder of
// its own outside the app, so that the app can replace itself while the daemon works, and the daemon can update itself
// from its release channel when idle. The daemon inside the app is the seed: it is put there when there is none, or
// when the one there is older. A daemon that is running is never touched: the newer one is staged beside it, where the
// running daemon takes it once nothing is working (apps/daemon/src/self-update.ts reads the same names).
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNewer } from "../shared/release.ts";

/** True when version `a` is lower than `b`. */
const olderThan = (a: string, b: string): boolean => isNewer(b, a);

/** The managed folder, under the daemon's data directory. */
export const managedDaemonDir = (dataRoot: string): string => join(dataRoot, "daemon", "bin");

/** What `<dir>.staged` holds is said by `<dir>.staged.json`: the daemon's self-update uses the same names. */
export const stagedDir = (dir: string): string => `${dir}.staged`;
export const stagedNote = (dir: string): string => `${dir}.staged.json`;

export type SeedResult =
  /** The managed folder was missing or older and nothing ran from it: the app's daemon was put in its place. */
  | "installed"
  /** The managed daemon is older and running: the app's is staged, for it to switch to when idle. */
  | "staged"
  /** The managed daemon is as new as the app's, or newer (it updated itself): nothing was done. */
  | "current";

export type SeedDeps = {
  /** The app's own daemon folder (`<app>/bin`). */
  bundledDir: string;
  /** Its version (build.json `daemonVersion`). */
  bundledVersion: string;
  /** Where the daemon runs from (`managedDaemonDir`). */
  managedDir: string;
  /** What `<dir>/cycle version` says, or undefined when it does not run. */
  versionOf: (dir: string) => Promise<string | undefined>;
  /** Whether a daemon is listening on the app's socket. */
  running: () => Promise<boolean>;
  /** Copies a folder (a clone on APFS), and takes off what would make Gatekeeper look at it as downloaded. */
  copy: (from: string, to: string) => Promise<void>;
};

/** Puts the app's daemon where it runs from, when it should: see the top of this file. */
export const seedDaemon = async (d: SeedDeps): Promise<SeedResult> => {
  const installed = existsSync(join(d.managedDir, "cycle"))
    ? await d.versionOf(d.managedDir)
    : undefined;
  if (installed !== undefined && !olderThan(installed, d.bundledVersion)) return "current";
  const seeding = `${d.managedDir}.seeding`;
  await mkdir(dirname(d.managedDir), { recursive: true, mode: 0o700 });
  await rm(seeding, { recursive: true, force: true });
  await d.copy(d.bundledDir, seeding);
  if (installed === undefined || !(await d.running())) {
    const aside = `${d.managedDir}.replaced`;
    await rm(aside, { recursive: true, force: true });
    if (existsSync(d.managedDir)) await rename(d.managedDir, aside);
    await rename(seeding, d.managedDir);
    await rm(aside, { recursive: true, force: true });
    // What was staged for the daemon that was there is older than this, or is taken again from the channel.
    await rm(stagedDir(d.managedDir), { recursive: true, force: true });
    await rm(stagedNote(d.managedDir), { force: true });
    return "installed";
  }
  // Running and older: staged beside it, unless something as new is staged already.
  const note = await readFile(stagedNote(d.managedDir), "utf8")
    .then((text) => JSON.parse(text) as { version?: unknown })
    .catch(() => undefined);
  const staged = typeof note?.version === "string" ? note.version : undefined;
  if (
    staged !== undefined &&
    existsSync(join(stagedDir(d.managedDir), "cycle")) &&
    !olderThan(staged, d.bundledVersion)
  ) {
    await rm(seeding, { recursive: true, force: true });
    return "staged";
  }
  await rm(stagedNote(d.managedDir), { force: true });
  await rm(stagedDir(d.managedDir), { recursive: true, force: true });
  await rename(seeding, stagedDir(d.managedDir));
  await writeFile(stagedNote(d.managedDir), `${JSON.stringify({ version: d.bundledVersion })}\n`, {
    mode: 0o600,
  });
  return "staged";
};

/**
 * `seedDaemon`, said in the analytics as one fixed word (`local_daemon_seeded`), and `failed` when it could not: the app
 * then runs the daemon it carries. Never the reason, which can name paths.
 */
export const seedAndReport = async (
  deps: SeedDeps,
  track: (name: "local_daemon_seeded", props: { result: SeedResult | "failed" }) => void,
  warn: (message: string) => void = () => {},
): Promise<SeedResult | "failed"> => {
  const result = await seedDaemon(deps).catch((error: unknown) => {
    warn(`could not put the app's daemon in place: ${String(error)}`);
    return "failed" as const;
  });
  track("local_daemon_seeded", { result });
  return result;
};
