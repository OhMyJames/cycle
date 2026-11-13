// What a packaged app is called and where its parts are, shared by the build, the installer and
// the main process. Paths are relative to the app's own folder, which Electron calls the app path:
// `Contents/Resources/app` in a macOS bundle, `resources/app` on Linux.

export const APP_NAME = "Cycle Codex";
export const BUNDLE_ID = "dev.cycle.codex";
export const MAC_BUNDLE = `${APP_NAME}.app`;
/** Electron's own executable in the macOS bundle, which keeps its name as its helpers do. */
export const MAC_EXECUTABLE = "Contents/MacOS/Electron";
export const LINUX_EXECUTABLE = "cycle-codex";

/** Present only in a packaged app, so its presence is how the main process knows it is one. */
export const BUILD_FILE = "build.json";
/** The daemon, compiled to one executable. */
export const DAEMON_BIN = "bin/cycle-daemon";
/** codex's platform package, whole, because codex finds its helpers beside itself. */
export const CODEX_DIR = "codex";
export const CODEX_BIN = `${CODEX_DIR}/bin/codex`;
/** The built main process, preload and page, laid out as `apps/desktop/dist` is. */
export const DIST_DIR = "dist";
export const PAGE_DIR = `${DIST_DIR}/renderer`;
export const PRELOAD = `${DIST_DIR}/preload.cjs`;
export const MAIN = `${DIST_DIR}/main.cjs`;
/** The window's icon where the bundle has none of its own. */
export const LINUX_ICON = "icon.png";

export type BuildInfo = {
  readonly name: string;
  readonly identifier: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly electron: string;
  readonly codex: string;
};

export type CodexTarget = {
  /** The optional dependency of `@openai/codex` that holds this platform's binary. */
  readonly package: string;
  /** The folder under its `vendor/`. */
  readonly triple: string;
};

const CODEX_TARGETS: Readonly<Record<string, CodexTarget>> = {
  "darwin-arm64": { package: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" },
  "darwin-x64": { package: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" },
  "linux-arm64": { package: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" },
  "linux-x64": { package: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" },
};

/** Where `@openai/codex` keeps the binary for a platform, as its own launcher looks for it. */
export const codexTarget = (platform: string, arch: string): CodexTarget | undefined =>
  CODEX_TARGETS[`${platform}-${arch}`];

/** The packaged app's folder name in the build's output, and where its executable and app path are. */
export function packagedLayout(
  platform: string,
  arch: string,
): { root: string; executable: string; appPath: string; resources: string } | undefined {
  if (platform === "darwin") {
    const resources = "Contents/Resources";
    return {
      root: MAC_BUNDLE,
      executable: MAC_EXECUTABLE,
      appPath: `${resources}/app`,
      resources,
    };
  }
  if (platform === "linux") {
    return {
      root: `${APP_NAME}-linux-${arch}`,
      executable: LINUX_EXECUTABLE,
      appPath: "resources/app",
      resources: "resources",
    };
  }
  return undefined;
}
