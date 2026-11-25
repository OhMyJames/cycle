import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import {
  AGY_CONFIG_SCHEMA,
  AGY_MIN_VERSION,
  AGY_PROMPT_CAPABILITIES,
  AgyPlugins,
  clearSessionEnvDirs,
  ensureKeychain,
  isVersionSupported,
  writeSessionEnvDir,
} from "@cycle/harness-agy";
import { runAdapter } from "@cycle/harness-agy/run";
import {
  agyEffectiveRuntime,
  cachedBinaryVersion,
  createAgySetupProvider,
  probeBinaryVersion,
} from "./agent-setup.ts";
import type { AgentDefinition } from "./agents.ts";
import { type Config, ConfigSchema } from "./config.ts";
import type { Harness, HarnessContext } from "./harness.ts";
import { processAgent } from "./process-agent.ts";
import { systemProxyFill } from "./system-proxy.ts";

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

const versionEnv = (
  inherited: Record<string, string | undefined>,
  isolatedHome?: string,
): Record<string, string> => ({
  PATH: inherited.PATH ?? "/usr/bin:/bin",
  ...(isolatedHome !== undefined ? { HOME: isolatedHome } : {}),
});

/**
 * Whether `agy --version` is at least `AGY_MIN_VERSION`. The one probe and cache the setup page uses too
 * (`probeBinaryVersion`, one parse rule, run asynchronously so the event loop is never blocked).
 */
export const isAgyVersionSupported = async (
  executable: string,
  inherited: Record<string, string | undefined>,
  isolatedHome?: string,
): Promise<boolean> => {
  const version = await probeBinaryVersion(executable, versionEnv(inherited, isolatedHome));
  return version !== undefined && isVersionSupported(version, AGY_MIN_VERSION);
};

/**
 * For callers that cannot wait: whether the shared cache already says this agy is unusable (too old, or its version
 * could not be read). When nothing is known yet a probe is started for next time and the binary is not refused.
 */
const knownUnusable = (
  executable: string,
  inherited: Record<string, string | undefined>,
  isolatedHome?: string,
): boolean => {
  const known = cachedBinaryVersion(executable);
  if (known === undefined) {
    void isAgyVersionSupported(executable, inherited, isolatedHome);
    return false;
  }
  return known.version === undefined || !isVersionSupported(known.version, AGY_MIN_VERSION);
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
  // agy-fast checks GitHub for a newer release from its session hook and swaps its own files: not unasked here
  // (`agy.env` can turn it back on).
  env.AGY_FAST_AUTO_UPDATE = "off";
  Object.assign(env, systemProxyFill(config.allowEnv, inherited, config.env), config.env);
  return env;
};

export type AgyDefinitionOptions = {
  /** Injectable for tests; defaults to `ensureKeychain` from `@cycle/harness-agy`. */
  ensureKeychain?: typeof ensureKeychain;
};

export const createAgyDefinition = (
  { config, dataDir, inherited, self, log, agentSettings }: HarnessContext,
  options: AgyDefinitionOptions = {},
): AgentDefinition => {
  const settings = config.agy;
  const env = agyEnv(settings, dataDir, inherited);
  const prepareKeychain = options.ensureKeychain ?? ensureKeychain;
  // The session's variables, for agy's shell commands only (harness/agy env-dir.ts, CYC-314). What a former daemon
  // wrote has no process left to read it.
  const envDirs = join(dataDir, "agy-env");
  clearSessionEnvDirs(envDirs);
  const executable = () => findAgyExecutable(settings, inherited);
  const fallbackExecutables =
    settings.executable !== undefined
      ? [settings.executable]
      : inherited.HOME
        ? [join(inherited.HOME, ".local", "bin", "agy")]
        : [];
  const base = processAgent({
    id: "agy",
    name: "Antigravity",
    configSchema: AGY_CONFIG_SCHEMA,
    promptCapabilities: AGY_PROMPT_CAPABILITIES,
    steer: true,
    // Its adapter and agy start and initialise whatever the session is: they can be up before there is one (CYC-294).
    // Sessions with environment variables skip standby in Daemon.#startAgent so they launch with their own sessionEnvDir.
    standby: true,
    command: [...self, "adapter", "agy"],
    env: ({ sessionId, sessionEnv }) => {
      const runtime = agyEffectiveRuntime(settings, agentSettings).values;
      const sessionEnvDir = writeSessionEnvDir(envDirs, sessionId, sessionEnv);
      return {
        PATH: inherited.PATH ?? "",
        CYCLE_ADAPTER_CONFIG: JSON.stringify({
          env,
          ...(sessionEnvDir !== undefined ? { sessionEnvDir } : {}),
          agyExecutable: executable() ?? "",
          fallbackExecutables,
          ...(settings.executable !== undefined ? { searchPath: false } : {}),
          logFile: join(dataDir, "logs", "agy-acp.log"),
          sandbox: runtime.sandbox,
          ...(settings.agent !== undefined ? { agent: settings.agent } : {}),
          telemetry: runtime.telemetry,
          ...(runtime.skipPermissions ? { skipPermissions: true } : {}),
        }),
      };
    },
    available: async () => {
      const path = executable();
      return path !== undefined && (await isAgyVersionSupported(path, inherited, env.HOME));
    },
    plugins: new AgyPlugins({
      executable: () => {
        const path = executable();
        return path !== undefined && !knownUnusable(path, inherited, env.HOME) ? path : undefined;
      },
      env,
      cwd: join(dataDir, "plugins", "agy"),
    }),
    setup: createAgySetupProvider({
      config: settings,
      dataDir,
      inherited,
      env: () => agyEnv(settings, dataDir, inherited),
      agentSettings,
      locateBinary: () => {
        if (settings.executable !== undefined) {
          return { source: "configured", path: settings.executable };
        }
        const found = findAgyExecutable(settings, inherited);
        return found !== undefined ? { source: "path", path: found } : { source: "missing" };
      },
    }),
    ...(log !== undefined ? { log } : {}),
  });
  return {
    ...base,
    launch: async (launchContext) => {
      if (env.HOME) {
        await prepareKeychain(env.HOME, log !== undefined ? { log } : undefined);
      }
      return base.launch(launchContext);
    },
  };
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
  definition: (context) => createAgyDefinition(context),
};
