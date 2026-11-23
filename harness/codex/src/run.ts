import { mkdir } from "node:fs/promises";
import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { createAdapter } from "./agent.ts";
import { nativeBinary } from "./binary.ts";
import type { AdapterConfig } from "./server.ts";

export async function runAdapter(shipped?: string) {
  const config = JSON.parse(process.env.CYCLE_ADAPTER_CONFIG ?? "null") as AdapterConfig | null;
  if (!config?.env) throw new Error("CYCLE_ADAPTER_CONFIG must contain an explicit environment");
  if (!config.env.CODEX_HOME) throw new Error("CODEX_HOME is required");
  await mkdir(config.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const adapter = createAdapter({
    ...config,
    codexExecutable: config.codexExecutable ?? shipped ?? nativeBinary(),
    // The daemon sees the adapter exit, ends the turn, and the next prompt starts and resumes a new one. A moment
    // first, for the turn's end to be written out.
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
