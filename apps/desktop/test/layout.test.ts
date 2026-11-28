import { expect, test } from "bun:test";
import { daemonCommand, loginShellPath } from "../src/main/layout.ts";

const base = { platform: "darwin", arch: "arm64", managedDir: "/Users/u/.cycle/daemon/bin" };
const has =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

test("packaged: the daemon in its own folder, seeded from the app's, and never Bun or the source", () => {
  const files = has(
    "/App/Resources/app/build.json",
    "/App/Resources/app/bin/cycle",
    "/App/Resources/app/bin/claude",
    "/App/Resources/app/bin/codex",
    "/App/Resources/app/bin/codex-code-mode-host",
  );
  expect(
    daemonCommand({
      ...base,
      here: "/App/Resources/app/dist",
      env: { CYCLE_DAEMON_BIN: "/elsewhere" },
      exists: files,
    }),
  ).toEqual(["/Users/u/.cycle/daemon/bin/cycle"]);
});

test("packaged but missing a part: an error that names it, not a quiet fall back", () => {
  const noDaemon = has("/App/Resources/app/build.json");
  expect(() =>
    daemonCommand({ ...base, here: "/App/Resources/app/dist", env: {}, exists: noDaemon }),
  ).toThrow(/missing its daemon/);
  const noClaude = has("/App/Resources/app/build.json", "/App/Resources/app/bin/cycle");
  expect(() =>
    daemonCommand({ ...base, here: "/App/Resources/app/dist", env: {}, exists: noClaude }),
  ).toThrow(/missing an agent's binary: .*bin\/claude/);
  // Codex runs without it, but every tool call in code mode fails, so no tool is ever shown.
  const noHost = has(
    "/App/Resources/app/build.json",
    "/App/Resources/app/bin/cycle",
    "/App/Resources/app/bin/claude",
    "/App/Resources/app/bin/codex",
  );
  expect(() =>
    daemonCommand({ ...base, here: "/App/Resources/app/dist", env: {}, exists: noHost }),
  ).toThrow(/missing an agent's binary: .*bin\/codex-code-mode-host/);
});

test("in development: the named binary, then the built one, then the source with bun", () => {
  const here = "/repo/apps/desktop/dist";
  expect(
    daemonCommand({ ...base, here, env: { CYCLE_DAEMON_BIN: "/x/d" }, exists: has() }),
  ).toEqual(["/x/d"]);
  expect(
    daemonCommand({
      ...base,
      here,
      env: {},
      exists: has("/repo/apps/daemon/dist/cycle-darwin-arm64/cycle"),
    }),
  ).toEqual(["/repo/apps/daemon/dist/cycle-darwin-arm64/cycle"]);
  expect(daemonCommand({ ...base, here, env: {}, exists: has() })).toEqual([
    "bun",
    "/repo/apps/daemon/src/main.ts",
  ]);
});

test("the login shell's PATH is read from between markers, and a failing shell gives nothing", async () => {
  const noisy = async () =>
    "Welcome back!\n__CYCLE_PATH__/opt/homebrew/bin:/usr/bin__CYCLE_PATH__\nbye";
  expect(await loginShellPath("/bin/zsh", noisy)).toBe("/opt/homebrew/bin:/usr/bin");
  expect(
    await loginShellPath("/bin/zsh", async () => {
      throw new Error("timed out");
    }),
  ).toBeUndefined();
  expect(await loginShellPath(undefined, noisy)).toBeUndefined();
  expect(await loginShellPath("/bin/zsh", async () => "no markers")).toBeUndefined();
});
