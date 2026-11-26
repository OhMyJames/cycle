#!/usr/bin/env bun
// bun cloud/loop/src/pipeline-cli.ts [--once] [--dry-run] [--interval SECONDS] [--workers N]
// bun cloud/loop/src/pipeline-cli.ts stats [--project KEY]
//
// Configuration is a file (mode 0600), not environment variables: --config <path>, or <dataDir>/loop.json.
// See config-file.ts for the fields. CYCLE_HOME / CYCLE_SOCKET still locate the daemon.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setUpProject } from "./assemble.ts";
import { type ConfigFile, loadConfigFiles } from "./config-file.ts";
import { idleIntervalMs, parseWorkers, runLoops, workerSpecs } from "./loop.ts";
import { readStats } from "./stats.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const dataDir = process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
const configPath = resolve(value("--config") ?? join(dataDir, "loop.json"));
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
  console.log(JSON.stringify(await readStats(only.stateDir, clock.now), null, 2));
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

const setUp = (file: ConfigFile) =>
  setUpProject(file, {
    dataDir,
    configPath,
    once,
    dryRun,
    workersFlag,
    stopped: () => stop,
    log,
  });

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
