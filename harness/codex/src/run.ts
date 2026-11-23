import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { createAdapter } from "./agent.ts";
import { nativeBinary } from "./binary.ts";
import type { AdapterConfig } from "./server.ts";

export async function runAdapter(shipped?: string) {
  const config = JSON.parse(process.env.CYCLE_ADAPTER_CONFIG ?? "null") as AdapterConfig | null;
  if (!config?.env) throw new Error("CYCLE_ADAPTER_CONFIG must contain an explicit environment");
  const adapter = createAdapter({
    ...config,
    codexExecutable: shipped ?? config.codexExecutable ?? nativeBinary(),
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
