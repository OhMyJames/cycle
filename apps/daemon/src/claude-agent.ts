import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODELS,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_PROMPT_CAPABILITIES,
  ClaudePlugins,
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_PERMISSION_MODE,
} from "@cycle/harness-claude";
import { META } from "@cycle/protocol";
import type { AgentDefinition } from "./agents.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { processAgent } from "./process-agent.ts";
import { claudeExecutable, selfCommand } from "./self.ts";

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
  // Without this the SDK gives Claude no task list, so there would be no plan to show (config.json can override).
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";
  return { ...env, ...config.env };
};

export const agentsFor = (
  config: Config,
  dataDir: string,
  inherited: Record<string, string | undefined> = process.env,
  log?: Logger,
): AgentDefinition[] => [
  processAgent({
    id: "claude",
    name: "Claude",
    configSchema: CLAUDE_CONFIG_SCHEMA,
    promptCapabilities: CLAUDE_PROMPT_CAPABILITIES,
    steer: true,
    // In the executable, the Claude binary shipped beside it must be there: say so now, not on the first prompt.
    available: () => claudeExecutable() === undefined || existsSync(claudeExecutable() as string),
    command: [...selfCommand(), "adapter", "claude"],
    // Claude's own command line, with what a Claude session gets and nothing more, in a folder that is no project.
    plugins: new ClaudePlugins({
      executable: claudeExecutable(),
      env: { PATH: inherited.PATH ?? "", ...claudeEnv(config.claude, dataDir, inherited) },
      cwd: join(dataDir, "plugins", "claude"),
    }),
    ...(log !== undefined ? { log } : {}),
    env: {
      PATH: inherited.PATH ?? "",
      CYCLE_ADAPTER_CONFIG: JSON.stringify({
        env: claudeEnv(config.claude, dataDir, inherited),
        warmStart: config.claude.warmStart,
        progressSummaries: config.claude.progressSummaries,
        ...(claudeExecutable() !== undefined ? { claudeExecutable: claudeExecutable() } : {}),
      }),
    },
  }),
];
