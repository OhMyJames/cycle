// Assembles the app from Electron's own distribution and Cycle's files. No packager: the app is a
// copy of Electron with its default app replaced by a folder, `app`, which is where Electron looks
// when there is no asar.
//
//   Cycle.app/Contents/Resources/app/{package.json, build.json, dist/, bin/cycle, bin/<each agent's binary>}
//
// On macOS the copy is a bundle with its Info.plist changed and an ad hoc signature, so that it runs
// at all on Apple silicon; a release then signs it with a Developer ID and notarizes it (sign.ts).
// On Linux the same files make a folder. That is what the tests launch.
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  AGENT_BINS,
  APP_NAME,
  BUILD_FILE,
  BUNDLE_ID,
  DAEMON_BIN,
  DIST_DIR,
  MAC_BUNDLE,
  MAIN,
} from "../src/main/layout.ts";
import { shellOfBuild } from "../src/main/ui-crypto.ts";
import { POSTHOG_HOST, POSTHOG_KEY } from "../src/shared/posthog.ts";
import { plistVersions } from "../src/shared/release.ts";
import { removePlistDict, setPlistString } from "./plist.ts";

const DESKTOP = new URL("..", import.meta.url).pathname;
const ROOT = join(DESKTOP, "../..");
/** Where packaged apps go: apps/desktop/build. */
export const BUILD_DIR = join(DESKTOP, "build");

const run = (command: string[], cwd = ROOT) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (!result.success) throw new Error(`${command.join(" ")} failed`);
};

const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/** The daemon is compiled with the Bun running this, so it must be the one the repository pins. */
const requirePinnedBun = () => {
  const pinned = String(json(join(ROOT, "package.json")).packageManager);
  if (`bun@${Bun.version}` !== pinned) {
    throw new Error(`This is Bun ${Bun.version}; the app must carry the pinned ${pinned}.`);
  }
};

/** Electron's distribution: its installer unpacks it from its cache, or downloads it, on first use. */
const electronDist = (): { dist: string; version: string } => {
  const packageDir = dirname(Bun.resolveSync("electron/package.json", DESKTOP));
  const dist = join(packageDir, "dist");
  if (!existsSync(join(dist, "version"))) run([process.execPath, "install.js"], packageDir);
  if (!existsSync(join(dist, "version"))) throw new Error(`Electron's installer left no ${dist}`);
  return { dist, version: readFileSync(join(dist, "version"), "utf8").trim().replace(/^v/, "") };
};

/** A copy that keeps symbolic links and modes. On APFS it is a clone, which takes no space. */
const copyTree = (from: string, to: string) =>
  run(process.platform === "darwin" ? ["/bin/cp", "-cR", from, to] : ["/bin/cp", "-a", from, to]);

/**
 * The PostHog project the build reports to: the one in src/shared/posthog.ts, or CYCLE_POSTHOG_KEY (and
 * CYCLE_POSTHOG_HOST) when the build is made for another project. The key is public (it can only add events), so it may
 * sit in build.json. `CYCLE_POSTHOG_KEY=` (empty) makes a build that reports nowhere (docs/analytics.md).
 */
const posthogProject = (): { posthogKey?: string; posthogHost?: string } => {
  const key = (process.env.CYCLE_POSTHOG_KEY ?? POSTHOG_KEY).trim();
  if (key === "") return {};
  const host = (process.env.CYCLE_POSTHOG_HOST ?? POSTHOG_HOST).trim();
  return { posthogKey: key, ...(host ? { posthogHost: host } : {}) };
};

export type Packaged = { app: string; appDir: string; executable: string; version: string };

export const packageApp = (outDir = BUILD_DIR): Packaged => {
  const { platform, arch } = process;
  if (platform !== "darwin" && platform !== "linux")
    throw new Error(`Packaging is for macOS and Linux, not ${platform}.`);
  requirePinnedBun();
  const version = String(json(join(DESKTOP, "package.json")).version);
  const plistVersion = plistVersions(version);
  if (!plistVersion) throw new Error(`${version} is not a version.`);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: ROOT })
      .stdout.toString()
      .trim();
  const commit = git("rev-parse", "--short", "HEAD");
  const subject = git("log", "-1", "--format=%s");
  const electron = electronDist();
  // Which interface bundles this app can take (shared/ui-bundle.ts): bundles are for the shell they were built with.
  const uiVersion = Number(git("rev-list", "--count", "HEAD")) || 0;

  // The main process, preload and page; and the daemon with the agents' binaries beside it, for this platform.
  run([process.execPath, "scripts/build.ts"], DESKTOP);
  run([process.execPath, "scripts/build.ts", "--no-tarball"], join(ROOT, "apps/daemon"));
  const daemonDir = join(ROOT, "apps/daemon/dist", `cycle-${platform}-${arch}`);

  mkdirSync(outDir, { recursive: true });
  const staging = join(outDir, ".app-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, dirname(DAEMON_BIN)), { recursive: true });
  cpSync(join(DESKTOP, "dist"), join(staging, DIST_DIR), { recursive: true });
  const shell = shellOfBuild(join(DESKTOP, "dist"));
  cpSync(join(daemonDir, "cycle"), join(staging, DAEMON_BIN));
  chmodSync(join(staging, DAEMON_BIN), 0o755);
  for (const bin of AGENT_BINS) {
    cpSync(join(daemonDir, basename(bin)), join(staging, bin));
    chmodSync(join(staging, bin), 0o755);
  }
  cpSync(join(daemonDir, "codex-resources"), join(staging, "bin/codex-resources"), {
    recursive: true,
  });
  cpSync(join(daemonDir, "clawdot-plugins"), join(staging, "bin/clawdot-plugins"), {
    recursive: true,
  });
  // Electron takes the app's name, and so the folder for its own data, from here.
  writeFileSync(
    join(staging, "package.json"),
    `${JSON.stringify({ name: "cycle", productName: APP_NAME, version, main: MAIN }, null, 2)}\n`,
  );
  writeFileSync(
    join(staging, BUILD_FILE),
    `${JSON.stringify({ name: APP_NAME, identifier: BUNDLE_ID, version, ...(commit ? { commit } : {}), ...(subject ? { subject } : {}), platform, arch, electron: electron.version, shell, uiVersion, ...posthogProject() }, null, 2)}\n`,
  );

  const app = join(outDir, platform === "darwin" ? MAC_BUNDLE : "Cycle");
  rmSync(app, { recursive: true, force: true });
  copyTree(platform === "darwin" ? join(electron.dist, "Electron.app") : electron.dist, app);
  const resources =
    platform === "darwin" ? join(app, "Contents/Resources") : join(app, "resources");
  rmSync(join(resources, "default_app.asar"), { force: true });
  const appDir = join(resources, "app");
  renameSync(staging, appDir);

  let executable: string;
  if (platform === "darwin") {
    const plistPath = join(app, "Contents/Info.plist");
    let plist = readFileSync(plistPath, "utf8");
    for (const [key, value] of [
      ["CFBundleIdentifier", BUNDLE_ID],
      ["CFBundleName", APP_NAME],
      ["CFBundleDisplayName", APP_NAME],
      ["CFBundleShortVersionString", plistVersion.CFBundleShortVersionString],
      ["CFBundleVersion", plistVersion.CFBundleVersion],
    ] as const) {
      plist = setPlistString(plist, key, value);
    }
    // The Info.plist already names electron.icns: put Cycle's icon in its place.
    copyFileSync(join(import.meta.dir, "../assets/icon.icns"), join(resources, "electron.icns"));
    // It names default_app.asar, which is gone; Cycle's code is a folder, which Electron does not check.
    writeFileSync(plistPath, removePlistDict(plist, "ElectronAsarIntegrity"));
    // Changing the bundle broke Electron's own signature, and Apple silicon runs nothing unsigned.
    run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", app]);
    executable = join(app, "Contents/MacOS/Electron");
  } else {
    executable = join(app, "cycle");
    renameSync(join(app, "electron"), executable);
  }
  return { app, appDir, executable, version };
};

if (import.meta.main) {
  const result = packageApp();
  console.log(JSON.stringify(result));
}
