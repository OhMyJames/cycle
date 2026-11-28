// `cycle update`: installs the newest daemon on the release channel now, and moves a running daemon onto it.
// docs/daemon.md "cycle update". The daemon does the same by itself when it is idle (self-update.ts); this is for a
// person who wants it at once, or for a daemon too old to update itself.
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { appVersionPath } from "./data-dir.ts";
import { type Staged, swapIn } from "./self-update.ts";
import { VERSION_FORMAT } from "./version.ts";

/** The release the desktop app last said it is, or undefined when none has connected (or it said something odd). */
export const recordedVersion = async (dataDir: string): Promise<string | undefined> => {
  const text = await readFile(appVersionPath(dataDir), "utf8").catch(() => "");
  const version = text.trim();
  return VERSION_FORMAT.test(version) ? version : undefined;
};

export type Install =
  /** In the desktop app's bundle: an app before CYC-538 ran it from there. Only the app replaces it. */
  | { kind: "bundled" }
  /** Where the desktop app puts it, `<CYCLE_HOME>/daemon/bin/cycle` (docs/desktop.md "本机 daemon"). */
  | { kind: "managed" }
  /** The installer only supports Linux (macOS builds are inside the app). */
  | { kind: "unsupported"; platform: string }
  /** Run from source: there is no installed program to replace. */
  | { kind: "source" }
  /** Compiled, but not where `install.sh` puts it. */
  | { kind: "unknown" }
  /** Where `install.sh` puts it: `<prefix>/share/cycle/cycle`. */
  | { kind: "installed"; prefix: string };

export const installOf = (
  execPath: string,
  compiled: boolean,
  platform: string = process.platform,
): Install => {
  if (execPath.includes(".app/Contents/")) return { kind: "bundled" };
  if (!compiled) return { kind: "source" };
  if (
    basename(execPath) === "cycle" &&
    basename(dirname(execPath)) === "bin" &&
    basename(dirname(dirname(execPath))) === "daemon"
  )
    return { kind: "managed" };
  if (platform !== "linux") return { kind: "unsupported", platform };
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
  /** `--version`: no longer taken, the channel has only its newest. */
  requested: string | undefined;
  now: boolean;
  install: Install;
  /** The folder this program runs from. */
  installDir: string;
  /** Puts the newest version on the channel in `<installDir>.staged` when it is newer (self-update.ts). */
  stage: () => Promise<{ staged?: Staged; error?: string }>;
  isRunning: () => Promise<boolean>;
  /** Stops the running daemon (waiting for work unless `force`); the exit code `stopDaemon` gives. */
  stop: (force: boolean) => Promise<number>;
  /** Starts the installed program as a daemon and resolves once it is listening; false when it did not. */
  start: (installed: string) => Promise<boolean>;
  say: (line: string) => void;
  /** For the tests: the switch of folders. */
  swap?: (installDir: string) => Promise<void>;
};

/** Exit codes: 0 done (or nothing to do), 1 failed, 2 nothing was asked for that can be done. */
export const runUpdate = async (deps: UpdateDeps): Promise<number> => {
  const { say } = deps;
  if (deps.requested !== undefined) {
    say(
      "cycle update installs the newest version on the release channel; --version is no longer taken.",
    );
    return 2;
  }
  if (deps.install.kind === "bundled") {
    say("This daemon is part of the desktop app and is updated with it. Nothing was changed.");
    return 2;
  }
  if (deps.install.kind === "unsupported") {
    say(
      `cycle update installs Linux releases only; this is ${deps.install.platform}. Nothing was changed.`,
    );
    return 2;
  }
  if (deps.install.kind === "source" || deps.install.kind === "unknown") {
    say(
      deps.install.kind === "source"
        ? "This daemon runs from source: there is no installed program to replace."
        : "This program is not where the installer puts it (<prefix>/share/cycle/cycle): not replacing it.",
    );
    return 2;
  }
  say(`This is ${deps.version}. Looking for a newer version...`);
  const { staged, error } = await deps.stage();
  if (error !== undefined) {
    say(`The update could not be downloaded: ${error}`);
    say("Nothing was changed; the current version stays.");
    return 1;
  }
  if (staged === undefined) {
    say(`Already the newest: ${deps.version}. Nothing to do.`);
    return 0;
  }
  const swap = deps.swap ?? swapIn;
  if (!(await deps.isRunning())) {
    await swap(deps.installDir);
    say(`Installed ${staged.version}. No daemon is running; the next connection starts it.`);
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
      `${staged.version} is ready, but the running daemon was not stopped. It switches by itself once nothing is working.`,
    );
    return 1;
  }
  await swap(deps.installDir);
  say("Starting the new version...");
  if (!(await deps.start(join(deps.installDir, "cycle")))) {
    say(
      "The new daemon did not start listening. See `cycle logs`; the next connection tries again.",
    );
    return 1;
  }
  say(`Updated to ${staged.version}; the daemon is listening.`);
  return 0;
};
