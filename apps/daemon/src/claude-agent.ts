import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLAUDE_ADVISORS,
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODELS,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_PROMPT_CAPABILITIES,
  ClaudePlugins,
  clearSessionEnvFiles,
  DEFAULT_PERMISSION_MODE,
  writeSessionEnvFile,
} from "@cycle/harness-claude";
import { runAdapter } from "@cycle/harness-claude/run";
import { META } from "@cycle/protocol";
import { claudeEffectiveRuntime, createClaudeSetupProvider } from "./agent-setup.ts";
import type { Config } from "./config.ts";
import type { Harness } from "./harness.ts";
import { processAgent } from "./process-agent.ts";
import { hasSecrets, protectedFiles } from "./secrets.ts";
import { shippedExecutable } from "./self.ts";
import { systemProxyFill } from "./system-proxy.ts";

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

/**
 * What a new Claude session is set to before the person's own defaults (agents.ts `newSession`): Sonnet at medium effort,
 * with Opus as its advisor. The owner chose these on 2026-11-24 (.agents/notes/2026-11-24-claude-advisor.md).
 */
export const CLAUDE_NEW_SESSION = { model: "sonnet", effort: "medium", advisor: "opus" } as const;

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
      default: CLAUDE_NEW_SESSION.model,
    },
    effort: {
      type: "string",
      title: "Effort",
      oneOf: CLAUDE_EFFORT_LEVELS.map((e) => ({
        const: e.value,
        title: e.name,
        description: e.description,
      })),
      default: CLAUDE_NEW_SESSION.effort,
    },
    advisor: {
      type: "string",
      title: "Advisor",
      description:
        "A stronger model Claude may consult at hard moments. Each consultation reads the whole conversation and is billed at the advisor's rates. An advisor must be at least as capable as the session's model: a Fable session uses only Fable.",
      oneOf: CLAUDE_ADVISORS.map((a) => ({
        const: a.value,
        title: a.name,
        description: a.description,
      })),
      default: CLAUDE_NEW_SESSION.advisor,
      // Set in the agent's defaults and a session's settings, not beside the message box (the owner, 2026-11-24).
      _meta: { [META.composer]: false },
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
  const configDir = config.configDir ?? join(dataDir, "claude");
  env.CLAUDE_CONFIG_DIR = configDir;
  const merged = {
    ...env,
    ...systemProxyFill(config.allowEnv, inherited, config.env),
    ...config.env,
  };
  // Host HOME is passed through via allowEnv so macOS login.keychain-db and host dev tools (git/gh/ssh) work,
  // while CLAUDE_CONFIG_DIR isolates settings, transcripts, and Claude's hashed keychain item (CYC-401).
  // Fall back to CLAUDE_CONFIG_DIR when no non-empty HOME was inherited or configured.
  if (!merged.HOME) merged.HOME = merged.CLAUDE_CONFIG_DIR || configDir;
  return merged;
};

export const claudeHarness: Harness = {
  id: "claude",
  name: "Claude",
  runAdapter,
  binary: BINARY,
  storageDir: ({ config, dataDir, inherited }) =>
    claudeEnv(config.claude, dataDir, inherited).CLAUDE_CONFIG_DIR,
  cli: {
    // Match `locateClaudeBinary()` first so `cycle login claude` and the daemon share one binary signature on macOS.
    executable: () => claudeExecutable() ?? sdkBundledClaude() ?? Bun.which("claude") ?? undefined,
    env: ({ config, dataDir, inherited }) => claudeEnv(config.claude, dataDir, inherited),
    login: ["auth", "login"],
    directories: ["CLAUDE_CONFIG_DIR"],
  },
  definition: ({ config, dataDir, inherited, self, log, agentSettings }) => {
    // The session's variables, for Claude's commands only (harness/claude env-file.ts). What a former daemon wrote has
    // no process left to read it.
    const envFiles = join(dataDir, "claude-env");
    clearSessionEnvFiles(envFiles);
    return processAgent({
      id: "claude",
      name: "Claude",
      configSchema: CLAUDE_CONFIG_SCHEMA,
      newSession: CLAUDE_NEW_SESSION,
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
      env: ({ sessionId, sessionEnv }) => {
        const runtime = claudeEffectiveRuntime(config.claude, agentSettings).values;
        const sessionEnvFile = writeSessionEnvFile(envFiles, sessionId, sessionEnv);
        return {
          PATH: inherited.PATH ?? "",
          CYCLE_ADAPTER_CONFIG: JSON.stringify({
            env: claudeEnv(config.claude, dataDir, inherited),
            ...(sessionEnvFile !== undefined ? { sessionEnvFile } : {}),
            // The secrets are kept from Claude's file tools always, and from its commands when there is one to keep.
            denyRead: protectedFiles(dataDir),
            sandboxDenied: hasSecrets(dataDir),
            warmStart: runtime.warmStart,
            progressSummaries: runtime.progressSummaries,
            ...(claudeExecutable() !== undefined ? { claudeExecutable: claudeExecutable() } : {}),
          }),
        };
      },
    });
  },
};
