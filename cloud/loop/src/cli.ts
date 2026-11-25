// `bun cloud/loop/src/cli.ts [--data-dir DIR]`: serves the Projects in `<data-dir>/loop.json` on `<data-dir>/loop.sock`.

import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./config.ts";
import { listen } from "./server.ts";

const flag = process.argv.indexOf("--data-dir");
const dataDir =
  (flag === -1 ? undefined : process.argv[flag + 1]) ??
  process.env.CYCLE_HOME ??
  join(homedir(), ".cycle");

try {
  const config = await loadConfig(join(dataDir, "loop.json"));
  await listen(config, join(dataDir, "loop.sock"));
  console.log(`loop: serving ${config.projects.length} project(s)`);
} catch (error) {
  console.error(
    `loop: cannot start (${error instanceof ConfigError ? error.reason : error instanceof Error && error.message === "already_running" ? "already_running" : "failed"})`,
  );
  process.exit(1);
}
