import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { configSchema, nativeBinary } from "@cycle/harness-codex";
import { runAdapter } from "@cycle/harness-codex/run";
import type { Harness } from "./harness.ts";
import { processAgent } from "./process-agent.ts";
import { shippedExecutable } from "./self.ts";

export const codexHarness: Harness = {
  id: "codex",
  name: "Codex",
  binary: "codex",
  runAdapter: () => runAdapter(shippedExecutable("codex")),
  definition: ({ config, dataDir, inherited, self, log }) => {
    const settings = config.codex;
    const env: Record<string, string> = {};
    for (const key of settings.allowEnv)
      if (inherited[key] !== undefined) env[key] = inherited[key];
    Object.assign(env, settings.env);
    env.CODEX_HOME = settings.configDir ?? join(dataDir, "codex");
    env.HOME ??= env.CODEX_HOME;
    const executable = () => settings.executable ?? shippedExecutable("codex") ?? nativeBinary();
    return processAgent({
      id: "codex",
      name: "Codex",
      configSchema,
      command: [...self, "adapter", "codex"],
      env: {
        PATH: inherited.PATH ?? "",
        CYCLE_ADAPTER_CONFIG: JSON.stringify({ env, codexExecutable: settings.executable }),
      },
      available: () => {
        try {
          accessSync(executable(), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
      ...(log ? { log } : {}),
    });
  },
};
