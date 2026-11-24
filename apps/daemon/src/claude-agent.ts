import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODELS,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_PROMPT_CAPABILITIES,
  ClaudePlugins,
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_PERMISSION_MODE,
} from "@cycle/harness-claude";
import { runAdapter } from "@cycle/harness-claude/run";
import { META } from "@cycle/protocol";
import { claudeEffectiveRuntime, createClaudeSetupProvider } from "./agent-setup.ts";
import type { Config } from "./config.ts";
import type { Harness } from "./harness.ts";
import { processAgent } from "./process-agent.ts";
import { shippedExecutable } from "./self.ts";

/** The name the Claude Code binary is shipped under, beside the daemon. */
const BINARY = "claude";
const claudeExecutable = () => shippedExecutable(BINARY);

/**
 * The Claude Code binary the Agent SDK runs when the adapter names none (from source, nothing is shipped): the SDK's own
 * platform package, found the way the SDK finds it (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`, resolved
 * from the SDK, musl first on a Linux without glibc). Undefined when that package is not installed.
 */
export const sdkBundledClaude = (): string | undefined => {
  try {
    const harness = dirname(Bun.resolveSync("@cycle/harness-claude", import.meta.dir));
    const sdk = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", harness));
    const { platform, arch } = process;
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const musl = platform === "linux" && report?.header?.glibcVersionRuntime === undefined;
    const names =
      platform === "linux"
        ? musl
          ? [`linux-${arch}-musl`, `linux-${arch}`]
          : [`linux-${arch}`, `linux-${arch}-musl`]
        : [`${platform}-${arch}`];
    const ext = platform === "win32" ? ".exe" : "";
    for (const name of names) {
      try {
        return Bun.resolveSync(`@anthropic-ai/claude-agent-sdk-${name}/claude${ext}`, sdk);
      } catch {
        // not this one
      }
    }
  } catch {
    // no SDK to resolve from (the compiled daemon ships its own binary)
  }
  return undefined;
};

/**
 * The binary a Claude session runs, which sign-in, sign-out and the setup page must use too: the one shipped beside the
 * daemon, else the SDK's bundled one (what the adapter falls back to when it is given none).
 */
export const locateClaudeBinary = ():
  | { source: "builtin"; path: string }
  | { source: "missing" } => {
  const shipped = claudeExecutable();
  if (shipped !== undefined) {
    return existsSync(shipped) ? { source: "builtin", path: shipped } : { source: "missing" };
  }
  const bundled = sdkBundledClaude();
  return bundled !== undefined && existsSync(bundled)
    ? { source: "builtin", path: bundled }
    : { source: "missing" };
};

export const CLAUDE_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      title: "Permission mode",
      oneOf: CLAUDE_PERMISSION_MODES.map((m) => ({
        const: m.value,
        title: m.name,
        description: m.description,
        ...("_meta" in m ? { _meta: m._meta } : {}),
      })),
      default: DEFAULT_PERMISSION_MODE,
    },
    model: {
      type: "string",
      title: "Model",
      oneOf: CLAUDE_MODELS.map((m) => ({
        const: m.value,
        title: m.name,
        ...(m.description !== undefined ? { description: m.description } : {}),
      })),
      // Claude takes any model name it knows, a full id included: these are the ones offered.
      _meta: { [META.open]: true },
      default: "default",
    },
    effort: {
      type: "string",
      title: "Effort",
      oneOf: CLAUDE_EFFORT_LEVELS.map((e) => ({
        const: e.value,
        title: e.name,
        description: e.description,
      })),
      default: DEFAULT_EFFORT_LEVEL,
    },
  },
} as const;

/** What the Claude process is allowed to see, and nothing else. */
export const claudeEnv = (
  config: Config["claude"],
  dataDir: string,
  inherited: Record<string, string | undefined>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of config.allowEnv) {
    const value = inherited[name];
    if (value !== undefined) env[name] = value;
  }
  env.CLAUDE_CONFIG_DIR = config.configDir ?? join(dataDir, "claude");
  // HOME is not passed on: it would let Claude find a login or settings nobody chose to share.
  env.HOME ??= env.CLAUDE_CONFIG_DIR;
  return { ...env, ...config.env };
};

export const claudeHarness: Harness = {
  id: "claude",
  name: "Claude",
  runAdapter,
  binary: BINARY,
  cli: {
    executable: () => claudeExecutable() ?? Bun.which("claude") ?? undefined,
    env: ({ config, dataDir, inherited }) => claudeEnv(config.claude, dataDir, inherited),
    login: ["auth", "login"],
  },
  definition: ({ config, dataDir, inherited, self, log, agentSettings }) =>
    processAgent({
      id: "claude",
      name: "Claude",
      configSchema: CLAUDE_CONFIG_SCHEMA,
      promptCapabilities: CLAUDE_PROMPT_CAPABILITIES,
      steer: true,
      // In the executable, the Claude binary shipped beside it must be there: say so now, not on the first prompt.
      available: () => claudeExecutable() === undefined || existsSync(claudeExecutable() as string),
      // Each session has a process of its own once it is made (decision 0014): 0 when warmStart is off (never unlimited).
      maxAhead: () => {
        const runtime = claudeEffectiveRuntime(config.claude, agentSettings).values;
        return runtime.warmStart ? runtime.maxWarm : 0;
      },
      command: [...self, "adapter", "claude"],
      // Claude's own command line, with what a Claude session gets and nothing more, in a folder that is no project.
      plugins: new ClaudePlugins({
        executable: claudeExecutable(),
        env: { PATH: inherited.PATH ?? "", ...claudeEnv(config.claude, dataDir, inherited) },
        cwd: join(dataDir, "plugins", "claude"),
      }),
      setup: createClaudeSetupProvider({
        config: config.claude,
        dataDir,
        inherited,
        env: () => claudeEnv(config.claude, dataDir, inherited),
        locateBinary: locateClaudeBinary,
      }),
      ...(log !== undefined ? { log } : {}),
      env: () => {
        const runtime = claudeEffectiveRuntime(config.claude, agentSettings).values;
        return {
          PATH: inherited.PATH ?? "",
          CYCLE_ADAPTER_CONFIG: JSON.stringify({
            env: claudeEnv(config.claude, dataDir, inherited),
            warmStart: runtime.warmStart,
            progressSummaries: runtime.progressSummaries,
            ...(claudeExecutable() !== undefined ? { claudeExecutable: claudeExecutable() } : {}),
          }),
        };
      },
    }),
};
