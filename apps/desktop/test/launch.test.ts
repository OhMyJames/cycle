import { expect, test } from "bun:test";
import { daemonLaunch } from "../src/launch";
import { codexTarget, packagedLayout } from "../src/shared/layout";

const BUNDLE_APP = "/Applications/Cycle Codex.app/Contents/Resources/app";

test("a packaged app runs the daemon and codex it carries, and nothing from a repository", () => {
  const launch = daemonLaunch({ appPath: BUNDLE_APP, packaged: true, bun: "/opt/bun" });
  expect(launch).toEqual({
    command: `${BUNDLE_APP}/bin/cycle-daemon`,
    args: [],
    env: {
      CYCLE_DAEMON_PORT: "0",
      CYCLE_UI_DIR: `${BUNDLE_APP}/dist/renderer`,
      CYCLE_CODEX_BIN: `${BUNDLE_APP}/codex/bin/codex`,
    },
  });
});

test("a repository run starts the daemon's source under Bun and leaves codex to the harness", () => {
  const launch = daemonLaunch({ appPath: "/repo/apps/desktop", packaged: false, bun: undefined });
  expect(launch).toEqual({
    command: "bun",
    args: ["/repo/apps/daemon/src/main.ts"],
    env: { CYCLE_DAEMON_PORT: "0", CYCLE_UI_DIR: "/repo/apps/desktop/dist/renderer" },
  });
  expect(
    daemonLaunch({ appPath: "/repo/apps/desktop", packaged: false, bun: "/opt/bun" }).command,
  ).toBe("/opt/bun");
});

test("neither kind of launch says where the data is", () => {
  for (const packaged of [true, false]) {
    const { env } = daemonLaunch({ appPath: BUNDLE_APP, packaged, bun: undefined });
    expect(Object.keys(env)).not.toContain("CYCLE_HOME");
    expect(Object.keys(env)).not.toContain("CODEX_HOME");
  }
});

test.each([
  ["darwin", "arm64", "@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
  ["darwin", "x64", "@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  ["linux", "x64", "@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
  ["linux", "arm64", "@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
])("codex for %s %s is %s", (platform, arch, name, triple) => {
  expect(codexTarget(platform, arch)).toEqual({ package: name, triple });
});

test("a platform codex or the packaging does not cover has no target", () => {
  expect(codexTarget("freebsd", "x64")).toBeUndefined();
  expect(packagedLayout("win32", "x64")).toBeUndefined();
});

test("the macOS bundle keeps Electron's layout, and Linux the same parts in a folder", () => {
  expect(packagedLayout("darwin", "arm64")).toEqual({
    root: "Cycle Codex.app",
    executable: "Contents/MacOS/Electron",
    appPath: "Contents/Resources/app",
    resources: "Contents/Resources",
  });
  expect(packagedLayout("linux", "x64")).toEqual({
    root: "Cycle Codex-linux-x64",
    executable: "cycle-codex",
    appPath: "resources/app",
    resources: "resources",
  });
});
