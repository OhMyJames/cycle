// The decisions `bun run desktop:install` makes, apart from the disk and processes they are about.
import { BUNDLE_ID, MAC_BUNDLE } from "../shared/layout";

export type InstallArgs = { to: string; force: boolean };

export const USAGE = "Usage: bun run desktop:install [--to <dir>] [--force]";

export function parseInstallArgs(argv: readonly string[]): InstallArgs {
  const args: InstallArgs = { to: "/Applications", force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      args.force = true;
    } else if (argument === "--to") {
      const value = argv[index + 1];
      if (!value) throw new Error(`--to needs a directory. ${USAGE}`);
      args.to = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${String(argument)}. ${USAGE}`);
    }
  }
  return args;
}

/** Always this app's own name, so no folder given can make it `Cycle.app`, which is old-cycle's. */
export const destinationIn = (directory: string): string =>
  `${directory.replace(/\/+$/, "")}/${MAC_BUNDLE}`;

export type RunningProcess = { pid: number; command: string };

/** Reads `ps -axo pid=,command=`. */
export const parseProcessList = (output: string): RunningProcess[] =>
  output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match?.[1] && match[2] ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });

/** Exactly this bundle: `/Applications/Cycle.app` is not `/Applications/Cycle Codex.app`. */
export const inBundle = (processes: readonly RunningProcess[], bundle: string): RunningProcess[] =>
  processes.filter(({ command }) => command.startsWith(`${bundle}/`));

/** The app itself, which stops its daemon, and so codex, when asked to quit. */
export const appProcesses = (
  processes: readonly RunningProcess[],
  bundle: string,
): RunningProcess[] =>
  processes.filter(
    ({ command }) =>
      command === `${bundle}/Contents/MacOS/Electron` ||
      command.startsWith(`${bundle}/Contents/MacOS/Electron `),
  );

export type InstallPlan =
  | { kind: "refuse"; reason: string }
  /** `stop` is asked to quit first, and `wait` must all be gone before anything is replaced. */
  | { kind: "install"; destination: string; stop: number[]; wait: number[] };

export function planInstall(input: {
  platform: string;
  /** The folder to install into, already resolved. */
  directory: string;
  directoryExists: boolean;
  /** Whether something is at the destination, and the bundle identifier it gave, if it gave one. */
  existing: { identifier: string | undefined } | undefined;
  processes: readonly RunningProcess[];
  force: boolean;
}): InstallPlan {
  const { platform, directory, directoryExists, existing, processes, force } = input;
  if (platform !== "darwin") {
    return {
      kind: "refuse",
      reason: `desktop:install is for macOS. On ${platform}, run the app from apps/desktop/build.`,
    };
  }
  if (!directoryExists) return { kind: "refuse", reason: `${directory} does not exist.` };
  const destination = destinationIn(directory);
  if (existing && existing.identifier !== BUNDLE_ID) {
    return {
      kind: "refuse",
      reason:
        existing.identifier === undefined
          ? `${destination} exists and has no readable bundle identifier, so it is not replaced.`
          : `${destination} is another app (${existing.identifier}, expected ${BUNDLE_ID}), so it is not replaced.`,
    };
  }
  const running = inBundle(processes, destination);
  if (running.length === 0) return { kind: "install", destination, stop: [], wait: [] };
  const pids = running.map(({ pid }) => pid);
  if (!force) {
    return {
      kind: "refuse",
      reason:
        `${destination} is running (pid ${pids.join(", ")}). Quit it first, ` +
        "or pass --force to quit it, which stops any turn that is running.",
    };
  }
  const apps = appProcesses(running, destination).map(({ pid }) => pid);
  // With no app to ask, what is left is a daemon or codex it did not stop: those are told directly.
  return { kind: "install", destination, stop: apps.length > 0 ? apps : pids, wait: pids };
}

export type TreeEntry = { path: string; size: number; mode: number };

/** What differs between a copy and its source. Empty means they hold the same files. */
export function treeDifferences(
  source: readonly TreeEntry[],
  copy: readonly TreeEntry[],
): string[] {
  const copied = new Map(copy.map((entry) => [entry.path, entry]));
  const differences: string[] = [];
  for (const entry of source) {
    const other = copied.get(entry.path);
    if (!other) differences.push(`${entry.path} is missing`);
    else if (other.size !== entry.size) differences.push(`${entry.path} has a different size`);
    else if (other.mode !== entry.mode) differences.push(`${entry.path} has a different mode`);
    copied.delete(entry.path);
  }
  for (const path of copied.keys()) differences.push(`${path} is extra`);
  return differences;
}
