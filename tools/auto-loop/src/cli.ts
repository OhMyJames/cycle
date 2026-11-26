#!/usr/bin/env bun
// bun tools/auto-loop/src/cli.ts [--once] [--dry-run] [--interval SECONDS] [--workers N]
// bun tools/auto-loop/src/cli.ts stats [--project KEY]
//
// Configuration is a file (mode 0600), not environment variables: --config <path>, or <dataDir>/auto-loop.json.
// See config-file.ts for the fields. CYCLE_HOME / CYCLE_SOCKET still locate the daemon.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ConfigFile, loadConfigFiles, readTuning } from "./config-file.ts";
import { effectiveWorkers, idleIntervalMs, parseWorkers, runLoops, workerSpecs } from "./loop.ts";
import { Pipeline } from "./pipeline.ts";
import { PlanTracker } from "./plan-mcp.ts";
import { type LoopFields, resolveLoopFields, resolveProject } from "./project.ts";
import { runCommand } from "./runner.ts";
import { DaemonSessions } from "./sessions.ts";
import { computeStats } from "./stats.ts";
import { acquireLock, RunStore } from "./store.ts";
import { defaultConfig } from "./types.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const dataDir = process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
const configPath = resolve(value("--config") ?? join(dataDir, "auto-loop.json"));
const files = await loadConfigFiles(configPath).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
const clock = { now: () => new Date() };
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

if (args[0] === "stats") {
  const wanted = value("--project");
  const chosen = wanted === undefined ? files : files.filter((f) => f.projectKey === wanted);
  const [only] = chosen;
  if (chosen.length !== 1 || only === undefined) {
    console.error(
      `stats needs one Project: pass --project <key> (one of ${files.map((f) => f.projectKey).join(", ")}).`,
    );
    process.exit(2);
  }
  const events = await new RunStore(only.stateDir, clock.now).events();
  console.log(JSON.stringify(computeStats(events), null, 2));
  process.exit(0);
}

const intervalFlag = value("--interval");
const seconds = intervalFlag === undefined ? undefined : Number(intervalFlag);
if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
  console.error("--interval takes a number of seconds above 0.");
  process.exit(2);
}
const once = flag("--once") || flag("--dry-run");
const dryRun = flag("--dry-run");
let workersFlag: number | undefined;
try {
  workersFlag = flag("--workers") ? parseWorkers(value("--workers") ?? "") : undefined;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
let stop = false;

// Everything one Project owns: tracker, store, lock, daemon connection, pipeline.
const setUp = async (file: ConfigFile) => {
  const { stateDir } = file;
  const name = file.projectKey;
  const plog = (line: string) => log(`[${name}] ${line}`);
  const tracker = new PlanTracker({
    url: file.planUrl,
    key: file.planKey,
    projectKey: file.projectKey,
  });
  // Research (CYC-447) is resolved only when it is on; the folder is a document, which `get_project` does not list.
  const research = file.research?.enabled === true ? file.research : null;
  const { research: found, ...setup } = resolveProject(
    await tracker.getProject(),
    file,
    research === null
      ? undefined
      : {
          type: research.type,
          folder: research.folder,
          documents: await tracker.listDocuments(),
        },
  );
  tracker.setColumns(setup.columns);
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
    stopped: () => stop,
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

// Set up every Project before any loop starts, so a bad one stops the process rather than half of it.
const projects: Awaited<ReturnType<typeof setUp>>[] = [];
try {
  for (const file of files) projects.push(await setUp(file));
} catch (error) {
  for (const p of projects) await p.close().catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // The first asks to stop after this step; the second leaves now. A killed loop is picked up again on restart.
    if (stop) {
      void Promise.allSettled(projects.map((p) => p.release())).finally(() => process.exit(130));
    }
    stop = true;
    log("stopping after this step (again to leave now)");
  });
}
try {
  await runLoops(
    projects.flatMap((p) =>
      workerSpecs(
        {
          step: () => p.pipeline.step(),
          once,
          intervalMs: () => idleIntervalMs(seconds, p.pipeline.intervalSeconds),
          log,
          stopped: () => stop,
        },
        p.name,
        p.workers,
      ),
    ),
  );
} finally {
  await Promise.allSettled(projects.map((p) => p.close()));
}
process.exit(0);
