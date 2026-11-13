import path from "node:path";
import { CODEX_BIN, DAEMON_BIN, PAGE_DIR } from "./shared/layout";

export type DaemonLaunch = {
  readonly command: string;
  readonly args: readonly string[];
  /** What the daemon gets on top of the app's own environment. */
  readonly env: Readonly<Record<string, string>>;
};

/**
 * How the app starts its daemon. From the repository it runs the daemon's source under Bun, which
 * finds codex in `node_modules`. A packaged app has neither, so it runs the daemon it carries and
 * tells it where the codex it carries is. Either way the daemon takes a free port and serves the
 * page, and its data stays wherever `CYCLE_HOME` says, which the app does not set.
 */
export function daemonLaunch(input: {
  appPath: string;
  packaged: boolean;
  /** `CYCLE_BUN_BIN`, for a repository run. */
  bun: string | undefined;
}): DaemonLaunch {
  const { appPath, packaged, bun } = input;
  const env = { CYCLE_DAEMON_PORT: "0", CYCLE_UI_DIR: path.join(appPath, PAGE_DIR) };
  if (packaged) {
    return {
      command: path.join(appPath, DAEMON_BIN),
      args: [],
      env: { ...env, CYCLE_CODEX_BIN: path.join(appPath, CODEX_BIN) },
    };
  }
  // Paths hang off the app root (apps/desktop): the bundler rewrites __dirname.
  return {
    command: bun ?? "bun",
    args: [path.resolve(appPath, "../daemon/src/main.ts")],
    env,
  };
}
