import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import {
  CODEX_FIXED_ARGS,
  CODEX_PROMPT_CAPABILITIES,
  CodexPlugins,
  configSchema,
  nativeBinary,
} from "@cycle/harness-codex";
import { runAdapter } from "@cycle/harness-codex/run";
import { createCodexSetupProvider } from "./agent-setup.ts";
import type { Config } from "./config.ts";
import type { Harness } from "./harness.ts";
import { processAgent } from "./process-agent.ts";
import { protectedFiles } from "./secrets.ts";
import { shippedExecutable } from "./self.ts";
import { systemProxyFill } from "./system-proxy.ts";

/** What the Codex process is allowed to see, and nothing else: the allowlist, what config.json names, its own home. */
export const codexEnv = (
  config: Config["codex"],
  dataDir: string,
  inherited: Record<string, string | undefined>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of config.allowEnv) if (inherited[key] !== undefined) env[key] = inherited[key];
  Object.assign(env, systemProxyFill(config.allowEnv, inherited, config.env), config.env);
  env.CODEX_HOME = config.configDir ?? join(dataDir, "codex");
  // HOME is not passed on: it would let Codex find a login (~/.codex) nobody chose to share.
  env.HOME ??= env.CODEX_HOME;
  return env;
};

/** The source checkout's locked native package; absent in the compiled daemon, where the shipped one is used. */
const sourceBinary = () => {
  try {
    return nativeBinary();
  } catch {
    return undefined;
  }
};

export const codexHarness: Harness = {
  id: "codex",
  name: "Codex",
  binary: "codex",
  companions: ["codex-code-mode-host"],
  runAdapter: () => runAdapter(shippedExecutable("codex")),
  cli: {
    executable: () =>
      shippedExecutable("codex") ?? sourceBinary() ?? Bun.which("codex") ?? undefined,
    env: ({ config, dataDir, inherited }) => codexEnv(config.codex, dataDir, inherited),
    // The login is kept in `$CODEX_HOME/auth.json`, never the system keychain, which is not per CODEX_HOME.
    args: [...CODEX_FIXED_ARGS],
    login: ["login"],
    directories: ["CODEX_HOME"],
  },
  definition: ({ config, dataDir, inherited, self, log, providers }) => {
    const settings = config.codex;
    const env = codexEnv(settings, dataDir, inherited);
    const executable = () => settings.executable ?? shippedExecutable("codex") ?? sourceBinary();
    return processAgent({
      id: "codex",
      name: "Codex",
      configSchema,
      promptCapabilities: CODEX_PROMPT_CAPABILITIES,
      steer: true,
      ...(providers !== undefined ? { providerModels: () => providers.models() } : {}),
      command: [...self, "adapter", "codex"],
      env: ({ sessionEnv }) => {
        // Read at each start: a provider saved since is there for the next session.
        const own = providers?.adapterConfig();
        return {
          PATH: inherited.PATH ?? "",
          CYCLE_ADAPTER_CONFIG: JSON.stringify({
            env,
            sessionEnv,
            denyRead: protectedFiles(dataDir),
            codexExecutable: settings.executable,
            ...(own !== undefined ? { providers: own } : {}),
          }),
        };
      },
      // Codex's own command line, with the environment a session gets, in a folder that is no project.
      plugins: new CodexPlugins({
        executable,
        args: CODEX_FIXED_ARGS,
        env: { PATH: inherited.PATH ?? "", ...env },
        cwd: join(dataDir, "plugins", "codex"),
      }),
      available: () => {
        const path = executable();
        if (path === undefined) return false;
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
      setup: createCodexSetupProvider({
        config: settings,
        dataDir,
        inherited,
        env: () => codexEnv(settings, dataDir, inherited),
        locateBinary: () => {
          // Exactly the binary the session's app-server runs (never one found on PATH, which it does not use).
          if (settings.executable !== undefined) {
            return { source: "configured", path: settings.executable };
          }
          const shipped = executable();
          return shipped !== undefined
            ? { source: "builtin", path: shipped }
            : { source: "missing" };
        },
      }),
      ...(log ? { log } : {}),
    });
  },
};
