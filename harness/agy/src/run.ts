import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { createAdapter } from "./agent.ts";
import { logFileFor, pruneLogs } from "./logs.ts";
import type { AdapterConfig } from "./server.ts";

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The `agy` to run: the one resolved by the daemon, then its fallbacks, then `PATH` unless one was configured. */
export const resolveExecutable = (
  config: AdapterConfig,
  path: string = process.env.PATH ?? "",
): string | undefined => {
  if (config.agyExecutable && isExecutable(config.agyExecutable)) return config.agyExecutable;
  for (const candidate of config.fallbackExecutables ?? []) {
    if (isExecutable(candidate)) return candidate;
  }
  if (config.searchPath === false) return undefined;
  const fromPath = Bun.which("agy", { PATH: path });
  return fromPath && isExecutable(fromPath) ? fromPath : undefined;
};

export async function runAdapter() {
  const config = JSON.parse(process.env.CYCLE_ADAPTER_CONFIG ?? "null") as AdapterConfig | null;
  if (!config?.env) throw new Error("CYCLE_ADAPTER_CONFIG must contain an explicit environment");
  if (!config.env.HOME) throw new Error("HOME is required for agy");
  const agyExecutable = resolveExecutable(config);
  if (!agyExecutable) throw new Error("agy binary not found");
  await mkdir(config.env.HOME, { recursive: true, mode: 0o700 });
  // Each adapter's frontend has its own log (`agy-acp.<pid>.log`), and the logs of earlier runs are cleared away.
  const logFile = config.logFile ? logFileFor(config.logFile) : undefined;
  if (config.logFile && logFile) {
    await mkdir(dirname(config.logFile), { recursive: true, mode: 0o700 });
    pruneLogs(config.logFile, { current: logFile });
  }
  const adapter = createAdapter({
    ...config,
    ...(logFile !== undefined ? { logFile } : {}),
    agyExecutable,
    onServerExit: () => setTimeout(() => process.exit(1), 200),
  });
  try {
    await adapter.app.connect(
      ndJsonStream(
        new WritableStream({
          write(chunk) {
            process.stdout.write(chunk);
          },
        }),
        Bun.stdin.stream(),
      ),
    ).closed;
  } finally {
    adapter.close();
  }
}
