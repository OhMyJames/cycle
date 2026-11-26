// Everything one Project owns: tracker, store, lock, daemon connection, pipeline. Shared by the CLI and the server.

import { join } from "node:path";
import { type ConfigFile, readTuning } from "./config-file.ts";
import { effectiveWorkers } from "./loop.ts";
import { Pipeline } from "./pipeline.ts";
import { PlanTracker } from "./plan-mcp.ts";
import { type LoopFields, resolveLoopFields, resolveProject } from "./project.ts";
import { runCommand } from "./runner.ts";
import { DaemonSessions } from "./sessions.ts";
import { acquireLock, RunStore } from "./store.ts";
import { DEFAULT_CHECK_MINUTES, DEFAULT_MAX_ASK, defaultConfig } from "./types.ts";

export type SetUpOptions = {
  dataDir: string;
  configPath: string;
  once: boolean;
  dryRun: boolean;
  workersFlag: number | undefined;
  stopped: () => boolean;
  log: (line: string) => void;
};

export type ProjectUnit = {
  name: string;
  pipeline: Pick<Pipeline, "step" | "intervalSeconds">;
  release: () => Promise<void>;
  close: () => Promise<void>;
  workers: number;
};

export const setUpProject = async (file: ConfigFile, o: SetUpOptions): Promise<ProjectUnit> => {
  const { dataDir, configPath, once, dryRun, workersFlag } = o;
  const clock = { now: () => new Date() };
  const { stateDir } = file;
  const name = file.projectKey;
  const plog = (line: string) => o.log(`[${name}] ${line}`);
  const tracker = new PlanTracker({
    url: file.planUrl,
    key: file.planKey,
    projectKey: file.projectKey,
  });
  // Research (CYC-447) is resolved only when it is on; the folder is a document, which `get_project` does not list.
  const research = file.research?.enabled === true ? file.research : null;
  // The planning node (CYC-322), likewise only when it is on.
  const planning = file.planning?.enabled === true ? file.planning : null;
  const {
    research: found,
    planning: planned,
    ...setup
  } = resolveProject(
    await tracker.getProject(),
    file,
    research === null
      ? undefined
      : {
          type: research.type,
          folder: research.folder,
          documents: await tracker.listDocuments(),
        },
    planning ?? undefined,
  );
  tracker.setColumns(setup.columns);
  if (planned !== null) tracker.setBacklogColumn(planned.backlogColumn);
  // The phase fields only mirror the run: if they cannot be used, say why once and do not write them.
  let loopFields: LoopFields | null = null;
  try {
    const resolved = resolveLoopFields(await tracker.getCustomFields());
    if ("fields" in resolved) loopFields = resolved.fields;
    else plog(`warning: the phase fields are off: ${resolved.problem}`);
  } catch (error) {
    plog(
      `warning: the phase fields are off: list_custom_fields failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  tracker.setLoopFields(loopFields);
  const config = {
    ...defaultConfig({ repoRoot: file.repoRoot, stateDir, ...setup }),
    ...(file.devAgent !== undefined ? { devAgent: file.devAgent } : {}),
    ...(file.qaAgent !== undefined ? { qaAgent: file.qaAgent } : {}),
    ...(file.reviewAgent !== undefined ? { reviewAgent: file.reviewAgent } : {}),
    ...(file.devModel !== undefined ? { devModel: file.devModel } : {}),
    ...(file.qaModel !== undefined ? { qaModel: file.qaModel } : {}),
    ...(file.reviewModel !== undefined ? { reviewModel: file.reviewModel } : {}),
    ...(file.devEffort !== undefined ? { devEffort: file.devEffort } : {}),
    ...(file.qaEffort !== undefined ? { qaEffort: file.qaEffort } : {}),
    ...(file.reviewEffort !== undefined ? { reviewEffort: file.reviewEffort } : {}),
    research:
      research === null || found === null
        ? null
        : { ...found, readRoots: research.readRoots, maxFollowups: research.maxFollowups },
    planning:
      planning === null || planned === null
        ? null
        : {
            ...planned,
            maxPending: planning.maxPending,
            intervalMinutes: planning.intervalMinutes,
            maxSplit: planning.maxSplit,
            checkMinutes: planning.checkMinutes ?? DEFAULT_CHECK_MINUTES,
            maxAsk: planning.maxAsk ?? DEFAULT_MAX_ASK,
          },
    dryRun,
  };
  const tuning = {
    initial: file.tuning ?? {},
    reload: () => readTuning(configPath, file.projectKey),
  };
  const store = new RunStore(stateDir, clock.now);
  const release = dryRun ? async () => {} : await acquireLock(stateDir);
  const sessions = new DaemonSessions(
    process.env.CYCLE_SOCKET ?? join(dataDir, "daemon.sock"),
    (sessionId, title) => {
      plog(`waiting for a person in session ${sessionId}: ${title}`);
      void store.unfinished().then((runs) => {
        const run = runs.find(
          (r) =>
            r.devSessionId === sessionId ||
            r.qaSessionId === sessionId ||
            r.reviewSessionId === sessionId,
        );
        if (run !== undefined) return store.event(run.key, "permission_pending");
      });
    },
    (run, kind, data) => store.event(run, kind, data),
  );
  if (!dryRun) await sessions.start();
  const pipeline = new Pipeline({
    config,
    tracker,
    sessions,
    exec: runCommand,
    store,
    clock,
    log: plog,
    env: process.env,
    stopped: o.stopped,
    tuning,
  });
  const close = async () => {
    await release();
    if (!dryRun) await sessions.close();
  };
  const workers = effectiveWorkers({ once, dryRun, flag: workersFlag, file: file.workers });
  if (workers > 4)
    plog(`warning: ${workers} workers; each one holds a session and a worktree, watch memory`);
  return { name, pipeline, release, close, workers };
};
