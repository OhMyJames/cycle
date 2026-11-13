// Assembles the packaged app from Electron's own distribution and Cycle's files. No packager: the
// app is a copy of Electron with its default app replaced by a folder, `app`, where Electron looks
// when there is no asar. On macOS the copy is a bundle with its Info.plist and icon changed, signed
// ad hoc; on Linux it is the same files as a folder.
//
// shortcut: no update feed, no Developer ID and no notarization, so the app runs only on the Mac
// that built it and changes only through `bun run desktop:install`; upgrade when it is installed on
// a machine that does not have the repository.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  APP_NAME,
  BUILD_FILE,
  BUNDLE_ID,
  type BuildInfo,
  CODEX_BIN,
  CODEX_DIR,
  DAEMON_BIN,
  DIST_DIR,
  LINUX_ICON,
  MAIN,
  codexTarget,
  packagedLayout,
} from "../shared/layout";

const DESKTOP = join(import.meta.dir, "..", "..");
const ROOT = join(DESKTOP, "..", "..");
const ELECTRON_PACKAGE = join(DESKTOP, "node_modules", "electron");
const ELECTRON_DIST = join(ELECTRON_PACKAGE, "dist");
const DAEMON_ENTRY = join(ROOT, "apps", "daemon", "src", "main.ts");
const CODEX_HARNESS = join(ROOT, "harness", "codex");
const ICONSET = join(DESKTOP, "icon.iconset");

/** Where packaged apps go: `apps/desktop/build`. */
export const BUILD_DIR = join(DESKTOP, "build");

export type Packaged = {
  /** The bundle on macOS, the folder on Linux. */
  readonly app: string;
  readonly executable: string;
  readonly info: BuildInfo;
};

function run(command: readonly string[], cwd: string = ROOT): void {
  const result = Bun.spawnSync([...command], { cwd, stdout: "inherit", stderr: "inherit" });
  if (!result.success) throw new Error(`${command.join(" ")} failed`);
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function stringField(path: string, field: string): string {
  const value: unknown = readJson(path);
  const found =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[field]
      : undefined;
  if (typeof found !== "string" || found === "") throw new Error(`${path} has no ${field}.`);
  return found;
}

/** The daemon is compiled with the Bun running this, so it must be the one the repository pins. */
function requirePinnedBun(): void {
  const pinned = stringField(join(ROOT, "package.json"), "packageManager");
  if (`bun@${Bun.version}` !== pinned) {
    throw new Error(`This is Bun ${Bun.version}; the app must carry the pinned ${pinned}.`);
  }
}

/** Electron's distribution, which its installer unpacks from its cache, or downloads, on first use. */
function prepareElectron(): string {
  const version = join(ELECTRON_DIST, "version");
  if (!existsSync(version)) {
    run([process.execPath, "install.js"], ELECTRON_PACKAGE);
    if (!existsSync(version)) {
      throw new Error(`Electron's installer finished, but ${ELECTRON_DIST} is not there.`);
    }
  }
  return readFileSync(version, "utf8").trim().replace(/^v/, "");
}

/**
 * codex's folder for this platform: its binary with the helpers it finds beside itself. It is an
 * optional dependency of `@openai/codex`, so it is looked up from there, as codex's launcher does.
 */
function findCodex(platform: string, arch: string): { dir: string; version: string } {
  const target = codexTarget(platform, arch);
  if (!target) throw new Error(`codex has no build for ${platform} ${arch}.`);
  let manifest: string;
  try {
    const launcher = realpathSync(Bun.resolveSync("@openai/codex/package.json", CODEX_HARNESS));
    manifest = Bun.resolveSync(`${target.package}/package.json`, dirname(launcher));
  } catch {
    throw new Error(`${target.package} is not installed. Run \`bun install\`.`);
  }
  const dir = join(dirname(manifest), "vendor", target.triple);
  if (!existsSync(join(dir, "bin", "codex"))) throw new Error(`${dir} holds no codex.`);
  return { dir, version: stringField(manifest, "version") };
}

/** One executable holding the daemon and Bun, which reads no `.env` or `bunfig.toml` where it runs. */
function compileDaemon(outfile: string): void {
  run([
    process.execPath,
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--outfile",
    outfile,
    DAEMON_ENTRY,
  ]);
}

/** A copy that keeps symbolic links and modes. On APFS it is a clone, which takes no space. */
function copyTree(from: string, to: string, platform: string): void {
  run(platform === "darwin" ? ["/bin/cp", "-cR", from, to] : ["/bin/cp", "-a", from, to]);
}

function plist(bundle: string, ...edit: readonly string[]): boolean {
  const file = join(bundle, "Contents", "Info.plist");
  return Bun.spawnSync(["/usr/bin/plutil", ...edit, file], { stderr: "inherit" }).success;
}

function setPlist(bundle: string, key: string, value: string): void {
  if (!plist(bundle, "-replace", key, "-string", value)) {
    throw new Error(`Could not set ${key} in the bundle's Info.plist.`);
  }
}

/** Makes the copy of Electron.app Cycle's: its identity, its icon and a signature over the result. */
function finishMacBundle(bundle: string, version: string): void {
  const resources = join(bundle, "Contents", "Resources");
  run(["/usr/bin/iconutil", "-c", "icns", ICONSET, "-o", join(resources, "electron.icns")]);
  setPlist(bundle, "CFBundleIdentifier", BUNDLE_ID);
  setPlist(bundle, "CFBundleName", APP_NAME);
  setPlist(bundle, "CFBundleDisplayName", APP_NAME);
  setPlist(bundle, "CFBundleShortVersionString", version);
  setPlist(bundle, "CFBundleVersion", version);
  // It names default_app.asar, which is gone. Cycle's code is a folder, which Electron does not
  // check. An Electron that has no such key fails this, which is fine.
  plist(bundle, "-remove", "ElectronAsarIntegrity");
  // Changing the bundle broke Electron's own signature, and Apple silicon runs nothing unsigned.
  // The daemon is signed first, by name: under Resources it is sealed as a file, not signed as code.
  // codex keeps the signature it came with.
  run(["/usr/bin/codesign", "--force", "--sign", "-", join(resources, "app", DAEMON_BIN)]);
  run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", bundle]);
}

/** Builds the app for this machine's platform in `outDir`, replacing any earlier one. */
export function packageApp(outDir: string = BUILD_DIR): Packaged {
  const { platform, arch } = process;
  const layout = packagedLayout(platform, arch);
  if (!layout) throw new Error(`Packaging is for macOS and Linux, not ${platform}.`);
  requirePinnedBun();
  const version = stringField(join(DESKTOP, "package.json"), "version");
  const electron = prepareElectron();
  const codex = findCodex(platform, arch);

  // The main process, the preload and the page, as `bun run build` leaves them in dist.
  run([process.execPath, "run", "build.ts"], DESKTOP);

  mkdirSync(outDir, { recursive: true });
  const staging = join(outDir, ".app-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, dirname(DAEMON_BIN)), { recursive: true });
  cpSync(join(DESKTOP, "dist"), join(staging, DIST_DIR), { recursive: true });
  compileDaemon(join(staging, DAEMON_BIN));
  copyTree(codex.dir, join(staging, CODEX_DIR), platform);
  chmodSync(join(staging, CODEX_BIN), 0o755);
  if (platform === "linux") cpSync(join(ICONSET, "icon_512x512.png"), join(staging, LINUX_ICON));
  // Electron takes the app's name, and so the folder for its own data, from here.
  const manifest = { name: "cycle-codex", productName: APP_NAME, version, main: MAIN };
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const info: BuildInfo = {
    name: APP_NAME,
    identifier: BUNDLE_ID,
    version,
    platform,
    arch,
    electron,
    codex: codex.version,
  };
  writeFileSync(join(staging, BUILD_FILE), `${JSON.stringify(info, null, 2)}\n`);

  const app = join(outDir, layout.root);
  rmSync(app, { recursive: true, force: true });
  copyTree(
    platform === "darwin" ? join(ELECTRON_DIST, "Electron.app") : ELECTRON_DIST,
    app,
    platform,
  );
  const resources = join(app, layout.resources);
  rmSync(join(resources, "default_app.asar"), { force: true });
  renameSync(staging, join(app, layout.appPath));

  if (platform === "darwin") {
    // The licenses lie beside Electron.app, and on Linux came with the folder.
    for (const license of ["LICENSE", "LICENSES.chromium.html"]) {
      cpSync(join(ELECTRON_DIST, license), join(resources, `electron-${license}`));
    }
    finishMacBundle(app, version);
  } else {
    renameSync(join(app, "electron"), join(app, layout.executable));
  }
  return { app, executable: join(app, layout.executable), info };
}
