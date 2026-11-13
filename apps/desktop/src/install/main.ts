// `bun run desktop:install`: packages the app, then puts it in /Applications, and writes nothing
// there but that one bundle. macOS only.
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { packageApp } from "../package/package-app";
import { BUNDLE_ID, MAC_BUNDLE, MAC_EXECUTABLE } from "../shared/layout";
import {
  type InstallPlan,
  type RunningProcess,
  type TreeEntry,
  destinationIn,
  inBundle,
  parseInstallArgs,
  parseProcessList,
  planInstall,
  treeDifferences,
} from "./plan";

const STOP_TIMEOUT_MS = 15_000;
const STOP_POLL_MS = 100;

class Refusal extends Error {}

const readPlistValue = (bundle: string, key: string): string | undefined => {
  const { stdout, success } = Bun.spawnSync(
    ["/usr/bin/plutil", "-extract", key, "raw", join(bundle, "Contents", "Info.plist")],
    { stdout: "pipe", stderr: "ignore" },
  );
  return success ? stdout.toString().trim() : undefined;
};

const runningProcesses = (): RunningProcess[] =>
  parseProcessList(
    Bun.spawnSync(["/bin/ps", "-axo", "pid=,command="], { stdout: "pipe" }).stdout.toString(),
  );

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** What is there now. Read again after packaging, which takes long enough for it to change. */
function plan(to: string, force: boolean): Extract<InstallPlan, { kind: "install" }> {
  const directoryExists = existsSync(to);
  const directory = directoryExists ? realpathSync(to) : to;
  const destination = destinationIn(directory);
  const decided = planInstall({
    platform: process.platform,
    directory,
    directoryExists,
    existing: existsSync(destination)
      ? { identifier: readPlistValue(destination, "CFBundleIdentifier") }
      : undefined,
    processes: process.platform === "darwin" ? runningProcesses() : [],
    force,
  });
  if (decided.kind === "refuse") throw new Refusal(decided.reason);
  return decided;
}

/** Asks exactly these processes to quit, and waits until nothing runs from the bundle. */
async function stop(
  pids: readonly number[],
  wait: readonly number[],
  bundle: string,
): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It left on its own.
    }
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  const left = (): boolean => wait.some(isAlive) || inBundle(runningProcesses(), bundle).length > 0;
  while (left() && Date.now() < deadline) await Bun.sleep(STOP_POLL_MS);
  if (left()) throw new Refusal(`${bundle} did not stop. Nothing was installed.`);
}

const treeOf = (root: string): TreeEntry[] =>
  readdirSync(root, { recursive: true, encoding: "utf8" }).map((path) => {
    const stat = lstatSync(join(root, path));
    return {
      path: relative(root, join(root, path)),
      size: stat.isDirectory() ? 0 : stat.size,
      mode: stat.mode & 0o777,
    };
  });

function verifyCopy(source: string, copy: string, version: string): void {
  const differences = treeDifferences(treeOf(source), treeOf(copy));
  if (differences.length > 0) {
    throw new Error(`The copy differs from the build: ${differences.slice(0, 5).join("; ")}`);
  }
  if (readPlistValue(copy, "CFBundleIdentifier") !== BUNDLE_ID) {
    throw new Error("The copy has the wrong bundle identifier.");
  }
  if (readPlistValue(copy, "CFBundleVersion") !== version) {
    throw new Error("The copy has the wrong version.");
  }
  if ((lstatSync(join(copy, MAC_EXECUTABLE)).mode & 0o111) === 0) {
    throw new Error("The copy's executable is not executable.");
  }
}

/** The new bundle takes the name in one rename, and the old one goes only after that has happened. */
function swapIntoPlace(copy: string, destination: string, previous: string): void {
  const replacing = existsSync(destination);
  if (replacing) renameSync(destination, previous);
  try {
    renameSync(copy, destination);
  } catch (error) {
    if (replacing) renameSync(previous, destination);
    throw error;
  }
  if (replacing) rmSync(previous, { recursive: true, force: true });
}

async function install(argv: readonly string[]): Promise<void> {
  const { to, force } = parseInstallArgs(argv);
  // Once before the minutes of packaging, so a refusal costs nothing, and once after.
  plan(to, force);
  const built = packageApp();
  const { destination, stop: pids, wait } = plan(to, force);
  if (wait.length > 0) await stop(pids, wait, destination);

  const directory = join(destination, "..");
  // Not ending in `.app`, so that nothing takes a half-copied bundle for an app.
  const copy = join(directory, `.${MAC_BUNDLE}.installing-${process.pid}`);
  const previous = join(directory, `.${MAC_BUNDLE}.previous-${process.pid}`);
  try {
    const copied = Bun.spawnSync(["/usr/bin/ditto", built.app, copy], { stderr: "inherit" });
    if (!copied.success) throw new Error(`Could not copy ${built.app} to ${copy}.`);
    verifyCopy(built.app, copy, built.info.version);
    swapIntoPlace(copy, destination, previous);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  console.log(`Installed ${built.info.name} ${built.info.version} at ${destination}`);
}

try {
  await install(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
