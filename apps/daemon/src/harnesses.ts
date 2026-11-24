import type { AgentSettings } from "./agent-settings.ts";
import type { AgentDefinition } from "./agents.ts";
import { agyHarness } from "./agy-agent.ts";
import { claudeHarness } from "./claude-agent.ts";
import { codexHarness } from "./codex-agent.ts";
import type { Config } from "./config.ts";
import type { Harness } from "./harness.ts";
import type { Logger } from "./logger.ts";
import type { ModelProviders } from "./providers.ts";
import { selfCommand } from "./self.ts";

/**
 * The agents this build has, in the order a client is offered them: the first is what a session is made with when
 * none is named. A new harness is added here, with its section in config.ts and its binary in scripts/binaries.ts.
 */
export const HARNESSES: readonly Harness[] = [claudeHarness, codexHarness, agyHarness];

/**
 * The agents for a daemon to run, made with the daemon's own `AgentSettings` (`DaemonOptions.agents` takes this
 * function): the instance `_cycle/agent_setup/set_runtime` writes is the one every harness reads.
 */
export const agentsFor =
  (
    config: Config,
    dataDir: string,
    inherited: Record<string, string | undefined> = process.env,
    log?: Logger,
    harnesses: readonly Harness[] = HARNESSES,
    self: string[] = selfCommand(),
  ): ((agentSettings: AgentSettings, providers: ModelProviders) => AgentDefinition[]) =>
  (agentSettings, providers) =>
    harnesses.map((harness) =>
      harness.definition({
        config,
        dataDir,
        inherited,
        self,
        agentSettings,
        providers,
        ...(log !== undefined ? { log } : {}),
      }),
    );
