import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import {
  AGY_CONFIG_SCHEMA,
  AGY_MIN_VERSION,
  AGY_PROMPT_CAPABILITIES,
  isVersionSupported,
} from "@cycle/harness-agy";
import { runAdapter } from "@cycle/harness-agy/run";
import { type Config, ConfigSchema } from "./config.ts";
import type { Harness } from "./harness.ts";
import { processAgent } from "./process-agent.ts";

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Locate the user-installed `agy` binary (never bundled with Cycle, see decision note
 * `2026-11-23-agy-terms-distribution-and-telemetry.md`):
 * 1. `config.json` `agy.executable` (if set, never silently falls back elsewhere)
 * 2. `~/.local/bin/agy` (real user's HOME, official installer default)
 * 3. `PATH`
 */
export const findAgyExecutable = (
  config: Config["agy"],
  inherited: Record<string, string | undefined>,
): string | undefined => {
  if (config.executable !== undefined) {
    return isExecutable(config.executable) ? config.executable : undefined;
  }
  const hostHome = inherited.HOME;
  if (hostHome) {
    const localBin = join(hostHome, ".local", "bin", "agy");
    if (isExecutable(localBin)) return localBin;
  }
  const fromPath = Bun.which("agy", { PATH: inherited.PATH ?? "" });
  return fromPath && isExecutable(fromPath) ? fromPath : undefined;
};

/** Cache `agy --version` checks by `(path, mtimeMs, size)` so `_cycle/agents/list` stays fast. */
const versionCache = new Map<string, boolean>();

export const isAgyVersionSupported = (
  executable: string,
  inherited: Record<string, string | undefined>,
  isolatedHome?: string,
): boolean => {
  let cacheKey: string | undefined;
  try {
    const st = statSync(executable);
    cacheKey = `${executable}:${st.mtimeMs}:${st.size}`;
    const cached = versionCache.get(cacheKey);
    if (cached !== undefined) return cached;
  } catch {
    return false;
  }
  const result = Bun.spawnSync([executable, "--version"], {
    env: {
      PATH: inherited.PATH ?? "/usr/bin:/bin",
      ...(isolatedHome !== undefined ? { HOME: isolatedHome } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
  });
  const ok =
    result.exitCode === 0 &&
    isVersionSupported(new TextDecoder().decode(result.stdout).trim(), AGY_MIN_VERSION);
  if (cacheKey !== undefined) versionCache.set(cacheKey, ok);
  return ok;
};

/**
 * What the `agy` process is allowed to see, and nothing else: allowlist, explicit `config.env`,
 * and an isolated `HOME` under `<dataDir>/agy` (never the host's `~/.gemini` or host secrets).
 */
export const agyEnv = (
  config: Config["agy"],
  dataDir: string,
  inherited: Record<string, string | undefined>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of config.allowEnv) {
    if (key === "HOME") continue;
    const value = inherited[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = config.home ?? join(dataDir, "agy");
  Object.assign(env, config.env);
  return env;
};

export const agyHarness: Harness = {
  id: "agy",
  name: "Antigravity",
  runAdapter,
  cli: {
    executable: (context) =>
      findAgyExecutable(
        context?.config.agy ?? ConfigSchema.parse({}).agy,
        context?.inherited ?? process.env,
      ),
    env: ({ config, dataDir, inherited }) => agyEnv(config.agy, dataDir, inherited),
    login: ["acp", "--login"],
    directories: ["HOME"],
  },
  definition: ({ config, dataDir, inherited, self, log }) => {
    const settings = config.agy;
    const env = agyEnv(settings, dataDir, inherited);
    const executable = () => findAgyExecutable(settings, inherited);
    const fallbackExecutables =
      settings.executable !== undefined
        ? [settings.executable]
        : inherited.HOME
          ? [join(inherited.HOME, ".local", "bin", "agy")]
          : [];
    return processAgent({
      id: "agy",
      name: "Antigravity",
      configSchema: AGY_CONFIG_SCHEMA,
      promptCapabilities: AGY_PROMPT_CAPABILITIES,
      steer: true,
      command: [...self, "adapter", "agy"],
      env: {
        PATH: inherited.PATH ?? "",
        CYCLE_ADAPTER_CONFIG: JSON.stringify({
          env,
          agyExecutable: executable() ?? "",
          fallbackExecutables,
          logFile: join(dataDir, "logs", "agy-acp.log"),
          ...(settings.sandbox !== undefined ? { sandbox: settings.sandbox } : {}),
          ...(settings.agent !== undefined ? { agent: settings.agent } : {}),
          ...(settings.telemetry !== undefined ? { telemetry: settings.telemetry } : {}),
        }),
      },
      available: () => {
        const path = executable();
        return path !== undefined && isAgyVersionSupported(path, inherited, env.HOME);
      },
      ...(log !== undefined ? { log } : {}),
    });
  },
};
