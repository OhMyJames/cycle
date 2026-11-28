// The server's resident pipelines: every Project is set up first, then all of them run until stopped. Nothing here
// knows about clients on the socket, so a desktop that connects, disconnects or never comes changes nothing.

import type { Server } from "node:net";
import { join } from "node:path";
import type { LoopApi } from "./api.ts";
import type { ProjectUnit } from "./assemble.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { ConfigFile } from "./config-file.ts";
import { loadConfigFiles } from "./config-file.ts";
import { idleIntervalMs, runLoops, workerSpecs } from "./loop.ts";
import { listen } from "./server.ts";

/** How often the checker is offered a turn; the flow decides when it really looks. */
export const WATCH_TICK_MS = 5000;

export type Running = {
  /** Ask every loop to stop after its current step. */
  stop: () => void;
  /** Settles once every loop has ended and every Project is closed. */
  done: Promise<void>;
  projects: ProjectUnit[];
};

/** Sets up all Projects before any loop starts: one that fails closes the ones already up and rethrows. */
export const startPipelines = async (
  files: ConfigFile[],
  setUp: (file: ConfigFile) => Promise<ProjectUnit>,
  log: (line: string) => void,
  stopped: { value: boolean } = { value: false },
  /** Runs once every Project is set up and before any loop starts; a throw closes the Projects and fails startup. */
  ready: (projects: ProjectUnit[]) => Promise<void> = async () => {},
): Promise<Running> => {
  const projects: ProjectUnit[] = [];
  try {
    for (const file of files) projects.push(await setUp(file));
    await ready(projects);
  } catch (error) {
    await Promise.allSettled(projects.map((p) => p.close()));
    throw error;
  }
  const pulse = () => {
    for (const p of projects) p.beat?.();
  };
  pulse();
  const heartbeatTimer = setInterval(pulse, 60_000);
  heartbeatTimer.unref?.();
  // CYC-550: the CI checker of each Project; the flow throttles it to `ciPollIntervalMs`.
  const watchTimers = projects.map((p) => {
    const timer = setInterval(() => void p.pipeline.watch(), WATCH_TICK_MS);
    timer.unref?.();
    return timer;
  });
  const done = runLoops(
    projects.flatMap((p) =>
      workerSpecs(
        {
          step: () => p.pipeline.step(),
          once: false,
          intervalMs: () => idleIntervalMs(undefined, p.pipeline.intervalSeconds),
          log,
          stopped: () => stopped.value,
        },
        p.name,
        p.workers,
      ),
    ),
  ).finally(async () => {
    clearInterval(heartbeatTimer);
    for (const timer of watchTimers) clearInterval(timer);
    await Promise.allSettled(projects.map((p) => p.close()));
  });
  return {
    stop: () => {
      stopped.value = true;
    },
    done,
    projects,
  };
};

export type ServerOptions = {
  dataDir: string;
  setUp: (file: ConfigFile) => Promise<ProjectUnit>;
  log: (line: string) => void;
  stopped?: { value: boolean };
  /** What `loop/status` reports as the version. */
  version?: string;
  now?: () => Date;
};

/** A fixed word or message for why startup failed, for the one line the process prints. */
export const startupReason = (error: unknown): string =>
  error instanceof ConfigError ? error.reason : error instanceof Error ? error.message : "failed";

/**
 * The whole startup: read `loop.json` (Projects and pipelines in one file), set every Project up, and only then
 * open `loop.sock` and start the loops. Clients therefore never see a Project nothing is running, and a failure at
 * any step leaves nothing running and no socket open.
 */
export const startServer = async (
  o: ServerOptions,
): Promise<Running & { server: Server; projectCount: number }> => {
  const path = join(o.dataDir, "loop.json");
  const config = await loadConfig(path);
  // The same file: each Project's entry carries its pipeline fields, and one missing a required one fails here.
  const files = await loadConfigFiles(path);
  let server: Server | undefined;
  const now = o.now ?? (() => new Date());
  const startedAt = now();
  const running = await startPipelines(files, o.setUp, o.log, o.stopped, async (units) => {
    const api: LoopApi = {
      version: o.version ?? "unknown",
      startedAt,
      now,
      log: o.log,
      projects: units.flatMap((u) => (u.api === undefined ? [] : [u.api])),
    };
    server = await listen(
      config,
      join(o.dataDir, "loop.sock"),
      (key) => files.find((f) => f.projectKey === key)?.stateDir,
      api,
    );
  });
  const opened = server;
  if (opened === undefined) throw new Error("failed");
  return {
    ...running,
    done: running.done.finally(() => {
      opened.close();
    }),
    server: opened,
    projectCount: config.projects.length,
  };
};

/** Where stop requests come from: the process in production, an emitter in tests. */
export type SignalSource = { on: (signal: "SIGINT" | "SIGTERM", handler: () => void) => unknown };

/**
 * How the server is stopped (CYC-456): the process is the switch, `SIGINT` or `SIGTERM` from a terminal, a process
 * supervisor or `kill`. The first asks every loop to stop after its current step, so no new step starts; the second
 * releases every Project's lock and leaves now with `exit(130)`. A loop killed mid-run is picked up from its
 * run.json when the server starts again.
 */
export const handleStopSignals = (o: {
  running: Pick<Running, "stop" | "projects">;
  log: (line: string) => void;
  exit: (code: number) => void;
  source?: SignalSource;
}): void => {
  let asked = false;
  let leaving = false;
  const onSignal = () => {
    if (asked) {
      // A release that hangs must not trap the process: a third signal leaves without waiting for it.
      if (leaving) return o.exit(130);
      leaving = true;
      void Promise.allSettled(o.running.projects.map((p) => p.release())).finally(() =>
        o.exit(130),
      );
      return;
    }
    asked = true;
    o.running.stop();
    o.log("stopping after this step (again to leave now)");
  };
  const source = o.source ?? process;
  for (const signal of ["SIGINT", "SIGTERM"] as const) source.on(signal, onSignal);
};
