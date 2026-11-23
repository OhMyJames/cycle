import { runAdapter as runCodex } from "@cycle/harness-codex/run";
import type { AgentDefinition } from "./agents.ts";
import { claudeHarness } from "./claude-agent.ts";
import type { Config } from "./config.ts";
import type { Harness } from "./harness.ts";
import type { Logger } from "./logger.ts";
import { selfCommand, shippedExecutable } from "./self.ts";

/**
 * The agents this build has, in the order a client is offered them: the first is what a session is made with when
 * none is named. A new harness is added here, with its section in config.ts and its binary in scripts/binaries.ts.
 */
export const HARNESSES: readonly Harness[] = [
  claudeHarness,
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    runAdapter: () => runCodex(shippedExecutable("codex")),
  },
];

export const agentsFor = (
  config: Config,
  dataDir: string,
  inherited: Record<string, string | undefined> = process.env,
  log?: Logger,
  harnesses: readonly Harness[] = HARNESSES,
  self: string[] = selfCommand(),
): AgentDefinition[] =>
  harnesses.flatMap(({ definition }) =>
    definition
      ? [definition({ config, dataDir, inherited, self, ...(log !== undefined ? { log } : {}) })]
      : [],
  );
