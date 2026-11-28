import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CYCLE_PROTOCOL_VERSION, type DaemonUpdateState } from "@cycle/protocol";
import { captureConfigMtime } from "./agent-setup.ts";
import { builtinPlugins } from "./builtin-plugins.ts";
import { type Config, ConfigSchema, loadConfig, type Paths, secureConfigFile } from "./config.ts";
import { Daemon, defaultTerminals } from "./daemon.ts";
import { agentsFor, HARNESSES } from "./harnesses.ts";
import { errorText, type FileLogger, fileLogger } from "./logger.ts";
import { RELEASE_KEYS, verifySignature } from "./release-keys.ts";
import { compiled, selfCommand } from "./self.ts";
import {
  QUIET_MS,
  recordBad,
  SelfUpdate,
  type Staged,
  swapBack,
  swapIn,
  whyNotUpdatable,
} from "./self-update.ts";
import { checkFolder, startAndWait } from "./self-update-host.ts";
import { agentHomesOf } from "./storage.ts";
import { listenUnix } from "./transport/server.ts";
import { installOf } from "./update.ts";
import { VERSION } from "./version.ts";

export type ServeOptions = {
  /** Each line the log writes is also given here (the foreground `cycle serve` at a terminal). */
  echo?: (line: string) => void;
  /** What is done once the daemon has stopped because it was idle (docs/daemon.md "空闲退出"). Default: exit with 0. */
  idleExit?: () => void;
  /** How often idle agents and an idle daemon are looked for. Default 30 s; tests make it short. */
  sweepMs?: number;
  /** What is done once the daemon has handed over to another version (docs/daemon.md "自动更新"). Default: exit with 0. */
  switched?: () => void;
};

/** Minutes from the config as ms, or undefined for 0: off. */
const minutes = (value: number): number | undefined => (value > 0 ? value * 60_000 : undefined);

const loggerFor = (paths: Paths, config: Config, echo?: (line: string) => void): FileLogger =>
  fileLogger({ path: paths.log, ...config.log, ...(echo !== undefined ? { echo } : {}) });

/**
 * Runs the daemon until `close` is called. What it does and what goes wrong is in its log (docs/daemon.md "日志"),
 * which `log` is, for the caller to say why it is stopping.
 */
export const serve = async (paths: Paths, options: ServeOptions = {}) => {
  let config: Config;
  let configLoadedMtimeMs: number | undefined;
  try {
    configLoadedMtimeMs = captureConfigMtime(paths.config);
    config = await loadConfig(paths.config);
  } catch (error) {
    // The settings for the log are in what could not be read: the reason goes to a log with the defaults.
    const log = loggerFor(paths, ConfigSchema.parse({}), options.echo);
    log.error("start_failed", { error: errorText(error) });
    log.close();
    throw error;
  }
  const log = loggerFor(paths, config, options.echo);
  log.info("daemon_starting", { version: VERSION, pid: process.pid, level: config.log.level });
  try {
    const was = await secureConfigFile(paths.config);
    if (was !== undefined)
      log.warn("config_mode_tightened", { path: paths.config, was: was.toString(8) });
  } catch (error) {
    log.warn("config_mode_unsafe", { path: paths.config, error: errorText(error) });
  }
  let daemon: Daemon;
  // Its own updates (docs/daemon.md "自动更新"): only an installed release with a key to check the channel's signature.
  const executable = process.execPath;
  const installDir = dirname(executable);
  const notUpdating = whyNotUpdatable({
    version: VERSION,
    install: installOf(executable, compiled()),
    keys: RELEASE_KEYS,
    env: process.env,
  });
  let updater: SelfUpdate | undefined;
  const updateState = (): DaemonUpdateState => {
    const state = updater?.state;
    if (state === undefined || state.updates === "off") return { version: VERSION, updates: "off" };
    return {
      version: VERSION,
      updates: "on",
      ...(state.pending !== undefined ? { pending: { version: state.pending.version } } : {}),
    };
  };
  const builtin = builtinPlugins();
  const agentIdleMs = minutes(config.idle.agentMinutes);
  const attachedAgentIdleMs = minutes(config.idle.attachedAgentMinutes);
  // Set once the daemon starts to stop: a client that connects after that is let go at once, and reconnects to the
  // next daemon.
  let refusing = false;
  let server: Awaited<ReturnType<typeof listenUnix>>;
  // Written the moment the socket is bound, by the daemon that bound it and no other: one that loses a start to another
  // never touches it. `cycle stop` gives it a moment (main.ts).
  const pidFile = join(paths.dataDir, "daemon.pid");
  try {
    daemon = await Daemon.start({
      dataDir: paths.dataDir,
      // Made with the daemon's own AgentSettings, so a saved runtime change is what the next start reads.
      agents: agentsFor(config, paths.dataDir, process.env, log, HARNESSES, selfCommand()),
      agentHomes: () => agentHomesOf(HARNESSES, config, paths.dataDir, process.env),
      version: VERSION,
      log,
      ...(builtin !== undefined ? { builtinPlugins: builtin } : {}),
      terminals: defaultTerminals(process.env, config.terminal),
      configFile: {
        path: paths.config,
        ...(configLoadedMtimeMs !== undefined ? { loadedMtimeMs: configLoadedMtimeMs } : {}),
      },
      ...(agentIdleMs !== undefined ? { agentIdleMs } : {}),
      ...(attachedAgentIdleMs !== undefined ? { attachedAgentIdleMs } : {}),
      updateState,
    });
    let clients = 0;
    server = await listenUnix({
      path: paths.socket,
      onListening: () => writeFileSync(pidFile, `${process.pid}\n`),
      onConnection: ({ stream, close }) => {
        if (refusing) {
          close();
          return;
        }
        const id = ++clients;
        log.info("client_connected", { client: id });
        void daemon.accept(stream).closed.then(() => log.info("client_left", { client: id }));
      },
    });
  } catch (error) {
    log.error("start_failed", { error: errorText(error) });
    log.close();
    throw error;
  }
  log.info("listening", { socket: paths.socket });
  let closing: Promise<void> | undefined;
  // One stop, whoever asks for it (a signal, the idle exit): a second caller waits for the first.
  const close = (beforeRelease?: () => Promise<void>): Promise<void> => {
    closing ??= (async () => {
      // Before anything is awaited: from here no client gets in to start something that would be cut short.
      refusing = true;
      clearInterval(sweep);
      updater?.stop();
      const working = daemon.activity();
      log.info("daemon_stopping", {
        working: working.length,
        turns: working.filter((w) => w.turn).length,
      });
      // Everything is written while the socket is still held, so no second daemon can start on this data directory
      // (a client reconnecting through `cycle proxy`) until this one has finished with it.
      await daemon.close();
      // A switch of version is made here: whatever starts a daemon on this socket meanwhile waits, and then runs the new.
      if (beforeRelease !== undefined)
        await beforeRelease().catch((error: unknown) =>
          log.warn("self_update_swap_failed", { error: errorText(error) }),
        );
      await rm(pidFile, { force: true });
      server.close();
      log.info("daemon_stopped");
      log.close();
    })();
    return closing;
  };
  // Agents with nothing to do are let go, and a daemon with nothing at all stops (docs/daemon.md "空闲回收"、"空闲退出").
  const exitAfter = minutes(config.idle.exitMinutes);
  const sweep = setInterval(() => {
    if (closing !== undefined) return;
    daemon.reclaimIdleAgents();
    const since = daemon.idleSince();
    if (exitAfter === undefined || since === undefined || Date.now() - since < exitAfter) return;
    log.info("idle_exit", { idleMinutes: Math.round((Date.now() - since) / 60_000) });
    void close().then(options.idleExit ?? (() => process.exit(0)));
  }, options.sweepMs ?? 30_000);

  /**
   * Hands over to the staged version: stops, switches the folders, starts the new daemon. If it does not listen in time,
   * it is thrown away, remembered as bad, and the version before is started again. Either way this process then ends.
   */
  const switchTo = async (staged: Staged): Promise<void> => {
    const stateFile = join(paths.dataDir, "daemon-update.json");
    let swapped = false;
    await close(async () => {
      await swapIn(installDir);
      swapped = true;
    });
    const program = join(installDir, "cycle");
    if (swapped && (await startAndWait(paths, program))) {
      (options.switched ?? (() => process.exit(0)))();
      return;
    }
    if (swapped) {
      await swapBack(installDir).catch(() => {});
      await recordBad(stateFile, staged.version).catch(() => {});
    }
    await startAndWait(paths, program).catch(() => false);
    (options.switched ?? (() => process.exit(0)))();
  };

  if (notUpdating === undefined) {
    updater = new SelfUpdate({
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      protocol: CYCLE_PROTOCOL_VERSION,
      installDir,
      keys: RELEASE_KEYS,
      verify: verifySignature,
      fetch,
      stateFile: join(paths.dataDir, "daemon-update.json"),
      check: checkFolder(executable),
      idle: () => daemon.quietForUpdate(QUIET_MS),
      apply: switchTo,
      log,
    });
    await updater
      .start()
      .catch((error: unknown) => log.warn("self_update_start_failed", { error: errorText(error) }));
    log.info("self_update_on", {});
  } else {
    log.info("self_update_off", { why: notUpdating });
  }
  return { log, close: () => close() };
};

/**
 * A served daemon stops on SIGINT or SIGTERM, saying which; and what brings it down unexpectedly (an exception nothing
 * caught, a promise nothing awaited) is in its log with where in the code, before it exits with 1. That is the reason a
 * person looks for afterwards (docs/daemon.md "日志").
 */
export const onSignalsAndCrashes = (running: Awaited<ReturnType<typeof serve>>): void => {
  let stopping = false;
  const stop = (signal: string) => async () => {
    if (stopping) return;
    stopping = true;
    running.log.info("signal", { signal });
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));
  const died = (kind: string) => (error: unknown) => {
    running.log.error(kind, { error: errorText(error, true) });
    console.error(error);
    process.exit(1);
  };
  process.on("uncaughtException", died("uncaught_exception"));
  process.on("unhandledRejection", died("unhandled_rejection"));
};
