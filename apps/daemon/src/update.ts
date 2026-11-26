// `cycle update`: installs the release that goes with the desktop app, and moves a running daemon onto it.
// docs/daemon.md "cycle update".
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { appVersionPath } from "./data-dir.ts";
import { VERSION_FORMAT } from "./facing/connection.ts";

/** Where releases are published: the same repository `install.sh` and the desktop app use. */
const RELEASE_REPO = "OhMyJames/cycle";

export const releaseUrl = (version: string, file: string): string =>
  `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${file}`;

/** The release the desktop app last said it is, or undefined when none has connected (or it said something odd). */
export const recordedVersion = async (dataDir: string): Promise<string | undefined> => {
  const text = await readFile(appVersionPath(dataDir), "utf8").catch(() => "");
  const version = text.trim();
  return VERSION_FORMAT.test(version) ? version : undefined;
};

export type Install =
  /** In the desktop app's bundle (macOS): it is updated with the app. */
  | { kind: "bundled" }
  /** Run from source: there is no installed program to replace. */
  | { kind: "source" }
  /** Compiled, but not where `install.sh` puts it. */
  | { kind: "unknown" }
  /** Where `install.sh` puts it: `<prefix>/share/cycle/cycle`. */
  | { kind: "installed"; prefix: string };

export const installOf = (execPath: string, compiled: boolean): Install => {
  if (execPath.includes(".app/Contents/")) return { kind: "bundled" };
  if (!compiled) return { kind: "source" };
  const share = dirname(dirname(execPath));
  if (
    basename(execPath) === "cycle" &&
    basename(dirname(execPath)) === "cycle" &&
    basename(share) === "share"
  )
    return { kind: "installed", prefix: dirname(share) };
  return { kind: "unknown" };
};

export type UpdateDeps = {
  /** This build's version. */
  version: string;
  /** `--version`. */
  requested: string | undefined;
  now: boolean;
  install: Install;
  /** The app version the daemon was last told. */
  recorded: () => Promise<string | undefined>;
  download: (url: string) => Promise<Uint8Array>;
  /** Runs `install.sh` (a file in `dir`) for a release tag; resolves with its exit code. */
  runInstaller: (dir: string, tag: string, prefix: string | undefined) => Promise<number>;
  isRunning: () => Promise<boolean>;
  /** Stops the running daemon (waiting for work unless `force`); the exit code `stopDaemon` gives. */
  stop: (force: boolean) => Promise<number>;
  /** Starts a daemon and resolves once it is listening; false when it did not. */
  start: () => Promise<boolean>;
  say: (line: string) => void;
  /** Where the installer's script is put. Default: a new temporary directory. */
  workDir?: () => Promise<string>;
};

/** Exit codes: 0 done (or nothing to do), 1 failed, 2 nothing was asked for that can be done. */
export const runUpdate = async (deps: UpdateDeps): Promise<number> => {
  const { say } = deps;
  if (deps.install.kind === "bundled") {
    say("This daemon is part of the desktop app and is updated with it. Nothing was changed.");
    return 2;
  }
  if (deps.install.kind !== "installed") {
    say(
      deps.install.kind === "source"
        ? "This daemon runs from source: there is no installed program to replace."
        : "This program is not where the installer puts it (<prefix>/share/cycle/cycle): not replacing it.",
    );
    return 2;
  }
  const target = deps.requested ?? (await deps.recorded());
  if (target === undefined) {
    say("No desktop app has connected to this daemon yet, so there is no version to match.");
    say("Say which: cycle update --version <x.y.z>");
    return 2;
  }
  if (!VERSION_FORMAT.test(target)) {
    say(`${target} is not a release version (expected x.y.z).`);
    return 2;
  }
  say(
    `Target: ${target}${deps.requested === undefined ? " (the desktop app's version)" : ""}; this is ${deps.version}.`,
  );
  if (target === deps.version) {
    say(`Already ${target}. Nothing to do.`);
    return 0;
  }

  const dir = await (deps.workDir ?? (() => mkdtemp(join(tmpdir(), "cycle-update-"))))();
  try {
    say(`Downloading install.sh for v${target}...`);
    let script: Uint8Array;
    let sums: string;
    try {
      script = await deps.download(releaseUrl(target, "install.sh"));
      sums = new TextDecoder().decode(await deps.download(releaseUrl(target, "install.sh.sha256")));
    } catch (error) {
      say(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
      say("Nothing was changed; the current version stays.");
      return 1;
    }
    say("Verifying the sha256...");
    const expected = sums.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const actual = createHash("sha256").update(script).digest("hex");
    if (expected !== actual) {
      say(
        `The sha256 of install.sh does not match (expected ${expected || "none"}, got ${actual}).`,
      );
      say("Nothing was changed; the current version stays.");
      return 1;
    }
    await writeFile(join(dir, "install.sh"), script, { mode: 0o755 });
    say(`Installing v${target}...`);
    const code = await deps.runInstaller(dir, `v${target}`, deps.install.prefix);
    if (code !== 0) {
      say(
        `The installer failed (exit ${code}). The current version stays unless the installer got as far as replacing it.`,
      );
      return 1;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  if (!(await deps.isRunning())) {
    say(`Installed ${target}. No daemon is running; the next connection starts it.`);
    return 0;
  }
  say(
    deps.now
      ? "Switching now: sessions that are working are interrupted."
      : "Waiting for sessions to finish, then switching to the new version...",
  );
  const stopped = await deps.stop(deps.now);
  if (stopped !== 0) {
    say(
      `Installed ${target}, but the running daemon was not stopped, so it still runs the old version.`,
    );
    say(
      "Run `cycle stop --wait` (or `cycle stop --force`); the next connection starts the new one.",
    );
    return 1;
  }
  say("Starting the new version...");
  if (!(await deps.start())) {
    say(
      "The new daemon did not start listening. See `cycle logs`; the next connection tries again.",
    );
    return 1;
  }
  say(`Updated to ${target}; the daemon is listening.`);
  return 0;
};

/** The default way to fetch a file: HTTPS, a non-2xx is an error. */
export const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** The default way to run the installer: its own output is shown, and it installs under the prefix this program is in. */
export const runInstallerScript = async (
  dir: string,
  tag: string,
  prefix: string | undefined,
): Promise<number> => {
  const child = Bun.spawn(["sh", join(dir, "install.sh"), tag], {
    cwd: dir,
    env: { ...process.env, ...(prefix !== undefined ? { CYCLE_PREFIX: prefix } : {}) },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
};
