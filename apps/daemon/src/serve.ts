import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { captureConfigMtime } from "./agent-setup.ts";
import { builtinPlugins } from "./builtin-plugins.ts";
import { type Config, ConfigSchema, loadConfig, type Paths, secureConfigFile } from "./config.ts";
import { Daemon, defaultTerminals } from "./daemon.ts";
import { agentsFor, HARNESSES } from "./harnesses.ts";
import { errorText, type FileLogger, fileLogger } from "./logger.ts";
import { selfCommand } from "./self.ts";
import { listenUnix } from "./transport/server.ts";
import { VERSION } from "./version.ts";

export type ServeOptions = {
  /** Each line the log writes is also given here (the foreground `cycle serve` at a terminal). */
  echo?: (line: string) => void;
  /** What is done once the daemon has stopped because it was idle (docs/daemon.md "空闲退出"). Default: exit with 0. */
  idleExit?: () => void;
  /** How often idle agents and an idle daemon are looked for. Default 30 s; tests make it short. */
  sweepMs?: number;
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
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // Before anything is awaited: from here no client gets in to start something that would be cut short.
      refusing = true;
      clearInterval(sweep);
      const working = daemon.activity();
      log.info("daemon_stopping", {
        working: working.length,
        turns: working.filter((w) => w.turn).length,
      });
      // Everything is written while the socket is still held, so no second daemon can start on this data directory
      // (a client reconnecting through `cycle proxy`) until this one has finished with it.
      await daemon.close();
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
  return { log, close };
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
