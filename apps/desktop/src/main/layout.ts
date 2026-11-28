import { dirname, join } from "node:path";

// What a packaged app is called and where its parts are. Paths are relative to the app's own folder,
// `Contents/Resources/app` in a macOS bundle and `resources/app` elsewhere.

export const APP_NAME = "Cycle";
export const BUNDLE_ID = "dev.cycle.app";
export const MAC_BUNDLE = `${APP_NAME}.app`;

/** Present only in a packaged app: its presence is how the main process knows it is one. */
export const BUILD_FILE = "build.json";
/** The daemon, compiled to one executable, with each agent's own binary beside it (the daemon looks there). */
export const DAEMON_BIN = "bin/cycle";
/**
 * Each agent's shipped binary and the executables it runs from beside it: what the daemon's build makes (a test holds
 * the two lists together).
 */
export const AGENT_BINS = ["bin/claude", "bin/codex", "bin/codex-code-mode-host"] as const;
/** The built main process, preload and page, laid out as `apps/desktop/dist` is. */
export const DIST_DIR = "dist";
export const MAIN = `${DIST_DIR}/main.mjs`;

/** The folder of the daemon the app carries (`<app>/bin`): the seed of the one that runs (main/daemon-home.ts). */
export const bundledDaemonDir = (here: string): string => join(here, "..", dirname(DAEMON_BIN));

/**
 * The command that runs the daemon for this computer. `here` is the folder the main process runs
 * from (`dist`). Packaged, it is the daemon in `managedDir` (`<CYCLE_HOME>/daemon/bin`, CYC-538), which the app
 * seeds from the one it carries; the app must carry one, and a user's machine has no Bun, so there is no fall back
 * to source, only an error that says what is missing. In development, the first that exists of CYCLE_DAEMON_BIN, the
 * built executable, or the source run with bun.
 */
export const daemonCommand = (options: {
  here: string;
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  exists: (path: string) => boolean;
  /** Where the packaged app runs its daemon from. */
  managedDir: string;
}): string[] => {
  const { here, env, exists } = options;
  const appDir = join(here, "..");
  if (exists(join(appDir, BUILD_FILE))) {
    const bundled = join(appDir, DAEMON_BIN);
    if (!exists(bundled)) throw new Error(`The app is missing its daemon: ${bundled}`);
    for (const bin of AGENT_BINS) {
      if (!exists(join(appDir, bin)))
        throw new Error(`The app is missing an agent's binary: ${join(appDir, bin)}`);
    }
    return [join(options.managedDir, "cycle")];
  }
  if (env.CYCLE_DAEMON_BIN !== undefined) return [env.CYCLE_DAEMON_BIN];
  const built = join(here, `../../daemon/dist/cycle-${options.platform}-${options.arch}/cycle`);
  if (exists(built)) return [built];
  return [env.CYCLE_BUN ?? "bun", env.CYCLE_DAEMON_MAIN ?? join(here, "../../daemon/src/main.ts")];
};

/**
 * The PATH of the user's login shell. An app started from Finder gets launchd's bare PATH, and the
 * daemon passes its PATH on to Claude, whose Bash would then not find node, git or bun. Only PATH is
 * taken from the shell; it is marked in the output because a shell's startup files may print.
 */
export const loginShellPath = async (
  shell: string | undefined,
  run: (shell: string, args: string[], timeoutMs: number) => Promise<string>,
): Promise<string | undefined> => {
  if (shell === undefined || shell === "") return undefined;
  try {
    const out = await run(shell, ["-ilc", 'printf "__CYCLE_PATH__%s__CYCLE_PATH__" "$PATH"'], 3000);
    return /__CYCLE_PATH__(.*?)__CYCLE_PATH__/s.exec(out)?.[1] || undefined;
  } catch {
    return undefined;
  }
};
