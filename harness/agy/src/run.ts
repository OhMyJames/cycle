import { mkdir } from "node:fs/promises";
import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { createAdapter } from "./agent.ts";
import type { AdapterConfig } from "./server.ts";

export async function runAdapter() {
  const config = JSON.parse(process.env.CYCLE_ADAPTER_CONFIG ?? "null") as AdapterConfig | null;
  if (!config?.env) throw new Error("CYCLE_ADAPTER_CONFIG must contain an explicit environment");
  if (!config.env.HOME) throw new Error("HOME is required for agy");
  if (!config.agyExecutable) throw new Error("agyExecutable is required");
  await mkdir(config.env.HOME, { recursive: true, mode: 0o700 });
  const adapter = createAdapter({
    ...config,
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
