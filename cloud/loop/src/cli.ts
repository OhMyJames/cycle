// `bun cloud/loop/src/cli.ts [--data-dir DIR]`: serves the Projects in `<data-dir>/loop.json` on
// `<data-dir>/loop.sock` and runs each one's pipeline from the same file (pipeline-cli.ts reads it too),
// resuming unfinished runs from their run.json. Stop it with SIGINT/SIGTERM (see handleStopSignals). Every Project is set up before the socket opens or any loop starts.

import { homedir } from "node:os";
import { join } from "node:path";
import { setUpProject } from "./assemble.ts";
import { handleStopSignals, startServer, startupReason } from "./runtime.ts";

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const dataDir = arg("--data-dir") ?? process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
const configPath = join(dataDir, "loop.json");
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const stopped = { value: false };

let running: Awaited<ReturnType<typeof startServer>>;
try {
  running = await startServer({
    dataDir,
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

handleStopSignals({ running, log, exit: (code) => process.exit(code) });
await running.done;
process.exit(0);
