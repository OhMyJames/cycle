// `bun cloud/loop/src/supervisor/main.ts [--data-dir DIR]`: resident deterministic supervisor (CYC-484).
// Writes `<dataDir>/loop-supervisor.pid`, keeps Work loop (`cli.ts`) alive, checks heartbeats every 60s, cancels an
// overdue run once via `loop/run/cancel`, and escalates on a second overdue detection.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LOOP_RUN_CANCEL } from "@cycle/protocol/loop";
import { loadConfigFiles } from "../config-file.ts";
import { importLegacyState, needsImport } from "../db/import.ts";
import { SqliteStore } from "../db/store.ts";
import { runCommand } from "../runner.ts";
import { acquireLock } from "../store.ts";
import { pidFileOf, rpcSocket } from "./ctl.ts";
import { LoopUpdater } from "./updater.ts";
import { type ManagedProcess, type ProcessControl, SupervisorWatchdog } from "./watchdog.ts";

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const dataDir = arg("--data-dir") ?? process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
const runtimeDir = arg("--runtime-dir") ?? join(dataDir, "loop-runtime");
const configPath = join(dataDir, "loop.json");
const socketPath = join(dataDir, "loop.sock");
let activeCliPath = resolve(import.meta.dir, "../cli.ts");
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const files = await loadConfigFiles(configPath);
const projects: { projectKey: string; store: SqliteStore }[] = [];
for (const file of files) {
  if (needsImport(file.stateDir)) {
    const release = await acquireLock(file.stateDir);
    try {
      if (needsImport(file.stateDir)) {
        const imported = await importLegacyState(file.stateDir, () => new Date());
        log(
          `[${file.projectKey}] imported ${imported.runs} runs, ${imported.events} events and ${imported.plans} plans into loop.db`,
        );
      }
    } finally {
      await release();
    }
  }
  projects.push({
    projectKey: file.projectKey,
    store: SqliteStore.open(file.stateDir, () => new Date()),
  });
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const pidFile = pidFileOf(dataDir);
writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
chmodSync(pidFile, 0o600);

const proc: ProcessControl = {
  spawn(): ManagedProcess {
    const child = Bun.spawn([process.execPath, activeCliPath, "--data-dir", dataDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    return { pid: child.pid, exited: child.exited };
  },
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone.
    }
  },
};

const watchdog = new SupervisorWatchdog({
  projects,
  proc,
  cancelRun: async (project, key) => {
    try {
      const res = (await rpcSocket(socketPath, LOOP_RUN_CANCEL, {
        project,
        key,
        actor: "supervisor",
        actorKind: "supervisor",
      })) as { cancelled?: boolean };
      return res?.cancelled === true;
    } catch {
      return false;
    }
  },
  log,
});

const repoUrl = arg("--runtime-repo") ?? files.find((f) => f.repo?.url !== undefined)?.repo?.url;
const updater =
  repoUrl === undefined
    ? null
    : new LoopUpdater({
        runtimeDir,
        repoUrl,
        configPath,
        projects,
        exec: runCommand,
        env: process.env,
        drainStop: () => watchdog.drainStop(false),
        startWorkLoop: (versionDir) => {
          activeCliPath = join(versionDir, "cloud/loop/src/cli.ts");
          watchdog.start();
        },
        stopWorkLoop: async () => {
          await watchdog.drainStop();
        },
        awaitHeartbeat: async (sinceMs, timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const fresh = projects.some((p) =>
              p.store.heartbeats().some((hb) => Date.parse(hb.at) >= sinceMs),
            );
            if (fresh) return true;
            await Bun.sleep(2_000);
          }
          return false;
        },
        log,
      });

if (updater !== null) {
  try {
    await updater.ensureInitialized();
    if (updater.currentPath !== null) {
      activeCliPath = join(updater.currentPath, "cloud/loop/src/cli.ts");
    }
  } catch (error) {
    log(`updater: init skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

watchdog.start();
let stopping = false;
let updating = false;
const timer = setInterval(() => {
  if (!stopping && !updating) void watchdog.tick();
}, 60_000);
const updateTimer =
  updater === null
    ? null
    : setInterval(() => {
        if (stopping || updating) return;
        updating = true;
        void updater
          .checkOnce()
          .catch((err) =>
            log(`updater: check failed (${err instanceof Error ? err.message : String(err)})`),
          )
          .finally(() => {
            updating = false;
          });
      }, 5 * 60_000);

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (updateTimer !== null) clearInterval(updateTimer);
  await watchdog.drainStop();
  rmSync(pidFile, { force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
