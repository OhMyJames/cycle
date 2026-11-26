// `bun cloud/loop/src/cli.ts [--data-dir DIR] [--pipelines FILE]`: serves the Projects in `<data-dir>/loop.json` on
// `<data-dir>/loop.sock` and runs each one's pipeline from `<data-dir>/auto-loop.json` (the file pipeline-cli.ts reads),
// resuming unfinished runs from their run.json. Every Project is set up before any starts.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setUpProject } from "./assemble.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { loadConfigFiles } from "./config-file.ts";
import { checkCovered, startPipelines } from "./runtime.ts";
import { listen } from "./server.ts";

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const dataDir = arg("--data-dir") ?? process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
const configPath = resolve(arg("--pipelines") ?? join(dataDir, "auto-loop.json"));
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const stopped = { value: false };

const fail = (reason: string): never => {
  console.error(`loop: cannot start (${reason})`);
  process.exit(1);
};

let config: Awaited<ReturnType<typeof loadConfig>>;
let files: Awaited<ReturnType<typeof loadConfigFiles>>;
try {
  config = await loadConfig(join(dataDir, "loop.json"));
  files = await loadConfigFiles(configPath);
  checkCovered(
    config.projects.map((p) => p.projectKey),
    files,
  );
} catch (error) {
  fail(
    error instanceof ConfigError ? error.reason : error instanceof Error ? error.message : "failed",
  );
  throw error;
}

let server: Awaited<ReturnType<typeof listen>>;
try {
  server = await listen(config, join(dataDir, "loop.sock"));
} catch (error) {
  fail(
    error instanceof Error && error.message === "already_running" ? "already_running" : "failed",
  );
  throw error;
}

let running: Awaited<ReturnType<typeof startPipelines>>;
try {
  running = await startPipelines(
    files,
    (file) =>
      setUpProject(file, {
        dataDir,
        configPath,
        once: false,
        dryRun: false,
        workersFlag: undefined,
        stopped: () => stopped.value,
        log,
      }),
    log,
    stopped,
  );
} catch (error) {
  server.close();
  fail(error instanceof Error ? error.message : "failed");
  throw error;
}
console.log(`loop: serving ${config.projects.length} project(s)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // The first asks to stop after this step; the second leaves now. A killed loop is picked up again on restart.
    if (stopped.value) {
      void Promise.allSettled(running.projects.map((p) => p.release())).finally(() =>
        process.exit(130),
      );
    }
    running.stop();
    log("stopping after this step (again to leave now)");
  });
}
await running.done;
process.exit(0);
