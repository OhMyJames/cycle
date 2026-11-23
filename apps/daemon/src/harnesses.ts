import type { AgentDefinition } from "./agents.ts";
import { claudeHarness } from "./claude-agent.ts";
import { codexHarness } from "./codex-agent.ts";
import type { Config } from "./config.ts";
import type { Harness } from "./harness.ts";
import type { Logger } from "./logger.ts";
import { selfCommand } from "./self.ts";

/**
 * The agents this build has, in the order a client is offered them: the first is what a session is made with when
 * none is named. A new harness is added here, with its section in config.ts and its binary in scripts/binaries.ts.
 */
export const HARNESSES: readonly Harness[] = [claudeHarness, codexHarness];

export const agentsFor = (
  config: Config,
  dataDir: string,
  inherited: Record<string, string | undefined> = process.env,
  log?: Logger,
  harnesses: readonly Harness[] = HARNESSES,
  self: string[] = selfCommand(),
): AgentDefinition[] =>
  harnesses.map((harness) =>
    harness.definition({ config, dataDir, inherited, self, ...(log !== undefined ? { log } : {}) }),
  );
