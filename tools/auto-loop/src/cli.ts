#!/usr/bin/env bun
// bun tools/auto-loop/src/cli.ts [--once] [--dry-run] [--interval SECONDS]
// bun tools/auto-loop/src/cli.ts stats
//
// Configuration is a file (mode 0600), not environment variables: --config <path>, or <dataDir>/auto-loop.json.
// See config-file.ts for the fields. CYCLE_HOME / CYCLE_SOCKET still locate the daemon.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfigFile } from "./config-file.ts";
import { Pipeline } from "./pipeline.ts";
import { PlanTracker } from "./plan-mcp.ts";
import { resolveProject } from "./project.ts";
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
const file = await loadConfigFile(configPath).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
const { stateDir } = file;
const clock = { now: () => new Date() };
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

if (args[0] === "stats") {
  const events = await new RunStore(stateDir, clock.now).events();
  console.log(JSON.stringify(computeStats(events), null, 2));
  process.exit(0);
}

const tracker = new PlanTracker({
  url: file.planUrl,
  key: file.planKey,
  projectKey: file.projectKey,
});
const setup = resolveProject(await tracker.getProject(), file);
tracker.setColumns(setup.columns);
const config = {
  ...defaultConfig({ repoRoot: file.repoRoot, stateDir, ...setup }),
  ...(file.devAgent !== undefined ? { devAgent: file.devAgent } : {}),
  ...(file.qaAgent !== undefined ? { qaAgent: file.qaAgent } : {}),
  ...(file.reviewAgent !== undefined ? { reviewAgent: file.reviewAgent } : {}),
  dryRun: flag("--dry-run"),
};
const store = new RunStore(stateDir, clock.now);
const release = config.dryRun ? async () => {} : await acquireLock(stateDir);
const sessions = new DaemonSessions(
  process.env.CYCLE_SOCKET ?? join(dataDir, "daemon.sock"),
  (sessionId, title) => {
    log(`waiting for a person in session ${sessionId}: ${title}`);
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
);
if (!config.dryRun) await sessions.start();
const pipeline = new Pipeline({
  config,
  tracker,
  sessions,
  exec: runCommand,
  store,
  clock,
  log,
  env: process.env,
});

const seconds = Number(value("--interval") ?? 60);
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error("--interval takes a number of seconds above 0.");
  process.exit(2);
}
const interval = seconds * 1000;
let stop = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // The first asks to stop after this step; the second leaves now. A killed loop is picked up again on restart.
    if (stop) {
      void release().finally(() => process.exit(130));
    }
    stop = true;
    log("stopping after this step (again to leave now)");
  });
}
try {
  do {
    let pause = false;
    try {
      const result = await pipeline.step();
      log(JSON.stringify(result));
      pause = result.status === "idle";
    } catch (error) {
      if (flag("--once") || config.dryRun) throw error;
      // A tracker or daemon hiccup must not end an unattended loop: log it, wait, try again.
      log(`step failed: ${error instanceof Error ? error.message : String(error)}`);
      pause = true;
    }
    if (flag("--once") || config.dryRun) break;
    if (pause && !stop) await Bun.sleep(interval);
  } while (!stop);
} finally {
  await release();
  if (!config.dryRun) await sessions.close();
}
process.exit(0);
