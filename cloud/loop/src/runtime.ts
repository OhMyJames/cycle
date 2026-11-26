// The server's resident pipelines: every Project is set up first, then all of them run until stopped. Nothing here
// knows about clients on the socket, so a desktop that connects, disconnects or never comes changes nothing.

import type { ProjectUnit } from "./assemble.ts";
import type { ConfigFile } from "./config-file.ts";
import { idleIntervalMs, runLoops, workerSpecs } from "./loop.ts";

export class PipelineConfigError extends Error {}

/** Every Project in the server's config needs a pipeline file entry, or the process would serve one it never works. */
export const checkCovered = (projectKeys: string[], files: ConfigFile[]): void => {
  const have = new Set(files.map((f) => f.projectKey));
  const missing = projectKeys.filter((k) => !have.has(k));
  if (missing.length > 0)
    throw new PipelineConfigError(`no pipeline config for Project ${missing.join(", ")}`);
};

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
): Promise<Running> => {
  const projects: ProjectUnit[] = [];
  try {
    for (const file of files) projects.push(await setUp(file));
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
