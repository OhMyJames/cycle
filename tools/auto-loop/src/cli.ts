#!/usr/bin/env bun
// bun tools/auto-loop/src/cli.ts [--once] [--dry-run] [--interval SECONDS]
// bun tools/auto-loop/src/cli.ts stats
//
// Environment: AUTO_LOOP_PLAN_KEY (required), AUTO_LOOP_PLAN_URL, AUTO_LOOP_PROJECT (default CYC),
// AUTO_LOOP_TYPE_IDS (comma-separated issue type ids, default 20,25), AUTO_LOOP_STATE (default <dataDir>/auto-loop),
// CYCLE_HOME / CYCLE_SOCKET for the daemon.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Pipeline } from "./pipeline.ts";
import { PlanTracker } from "./plan-mcp.ts";
import { runCommand } from "./runner.ts";
import { DaemonSessions } from "./sessions.ts";
import { computeStats } from "./stats.ts";
import { acquireLock, RunStore } from "./store.ts";
import { defaultConfig, parseAllowedTypeIds } from "./types.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const dataDir = process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
const stateDir = resolve(process.env.AUTO_LOOP_STATE ?? join(dataDir, "auto-loop"));
const clock = { now: () => new Date() };
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

if (args[0] === "stats") {
  const events = await new RunStore(stateDir, clock.now).events();
  console.log(JSON.stringify(computeStats(events), null, 2));
  process.exit(0);
}

const key = process.env.AUTO_LOOP_PLAN_KEY;
if (key === undefined || key === "") {
  console.error("AUTO_LOOP_PLAN_KEY is not set.");
  process.exit(2);
}
const repoRoot = resolve(import.meta.dir, "../../..");
const rawTypeIds = process.env.AUTO_LOOP_TYPE_IDS;
const allowedTypeIds =
  rawTypeIds !== undefined && rawTypeIds.trim() !== ""
    ? parseAllowedTypeIds(rawTypeIds)
    : undefined;
const config = {
  ...defaultConfig({ repoRoot, stateDir }),
  ...(allowedTypeIds !== undefined ? { allowedTypeIds } : {}),
  dryRun: flag("--dry-run"),
};
const tracker = new PlanTracker({
  url: process.env.AUTO_LOOP_PLAN_URL ?? "https://plan.ops.shrimpdot.ai/api/mcp",
  key,
  projectKey: process.env.AUTO_LOOP_PROJECT ?? "CYC",
  columns: config.columns,
});
const store = new RunStore(stateDir, clock.now);
const release = config.dryRun ? async () => {} : await acquireLock(stateDir);
const sessions = new DaemonSessions(
  process.env.CYCLE_SOCKET ?? join(dataDir, "daemon.sock"),
  (sessionId, title) => {
    log(`waiting for a person in session ${sessionId}: ${title}`);
    void store.unfinished().then((runs) => {
      const run = runs.find((r) => r.devSessionId === sessionId || r.qaSessionId === sessionId);
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
