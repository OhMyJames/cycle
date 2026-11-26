// `bun cloud/loop/src/cli.ts [--data-dir DIR] [--pipelines FILE]`: serves the Projects in `<data-dir>/loop.json` on
// `<data-dir>/loop.sock` and runs each one's pipeline from `<data-dir>/auto-loop.json` (the file pipeline-cli.ts reads),
// resuming unfinished runs from their run.json. Every Project is set up before the socket opens or any loop starts.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setUpProject } from "./assemble.ts";
import { startServer, startupReason } from "./runtime.ts";

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const dataDir = arg("--data-dir") ?? process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
const configPath = resolve(arg("--pipelines") ?? join(dataDir, "auto-loop.json"));
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const stopped = { value: false };

let running: Awaited<ReturnType<typeof startServer>>;
try {
  running = await startServer({
    dataDir,
    pipelinesPath: configPath,
    stopped,
    log,
    setUp: (file) =>
      setUpProject(file, {
        dataDir,
        configPath,
        once: false,
        dryRun: false,
        workersFlag: undefined,
        stopped: () => stopped.value,
        log,
      }),
  });
} catch (error) {
  console.error(`loop: cannot start (${startupReason(error)})`);
  process.exit(1);
}
console.log(`loop: serving ${running.projectCount} project(s)`);

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
