// The server's resident pipelines: every Project is set up first, then all of them run until stopped. Nothing here
// knows about clients on the socket, so a desktop that connects, disconnects or never comes changes nothing.

import type { Server } from "node:net";
import { join } from "node:path";
import type { ProjectUnit } from "./assemble.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { ConfigFile } from "./config-file.ts";
import { loadConfigFiles } from "./config-file.ts";
import { idleIntervalMs, runLoops, workerSpecs } from "./loop.ts";
import { listen } from "./server.ts";

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
  ready: () => Promise<void> = async () => {},
): Promise<Running> => {
  const projects: ProjectUnit[] = [];
  try {
    for (const file of files) projects.push(await setUp(file));
    await ready();
  } catch (error) {
    await Promise.allSettled(projects.map((p) => p.close()));
    throw error;
  }
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
  const running = await startPipelines(files, o.setUp, o.log, o.stopped, async () => {
    server = await listen(config, join(o.dataDir, "loop.sock"));
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
