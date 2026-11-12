import { CodexHarness } from "@cycle/harness-codex";
import { DEFAULT_DAEMON_PORT } from "@cycle/protocol";
import { startDaemon } from "./daemon.ts";

const port = Number(process.env.CYCLE_DAEMON_PORT ?? DEFAULT_DAEMON_PORT);
const verbose = process.env.CYCLE_DEBUG === "1";

/** CYCLE_CODEX_CONFIG: JSON object of `codex -c` overrides, e.g. {"model":"gpt-5"} */
const config = process.env.CYCLE_CODEX_CONFIG ? JSON.parse(process.env.CYCLE_CODEX_CONFIG) : undefined;

const daemon = await startDaemon({
  port,
  harness: new CodexHarness({
    config,
    onLog: verbose ? (line) => console.error(`[codex] ${line}`) : undefined,
  }),
});

// Machine-readable readiness line; apps/desktop waits for it.
console.log(JSON.stringify({ type: "listening", port: daemon.port, url: daemon.url }));

const shutdown = async () => {
  await daemon.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
