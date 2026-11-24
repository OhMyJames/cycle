import type { AgentSettings } from "./agent-settings.ts";
import type { AgentDefinition } from "./agents.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

/** What a harness is given to make its agent from: nothing of the daemon's own environment but what is named here. */
export type HarnessContext = {
  config: Config;
  dataDir: string;
  /** The daemon's own environment, to take the allowed names from. Never handed on whole (AGENTS.md). */
  inherited: Record<string, string | undefined>;
  /** The command that runs this program again, for `adapter <id>` (self.ts). */
  self: string[];
  log?: Logger;
  /** Shared live per-agent runtime overrides (`<dataDir>/agent-settings.json`) for dynamic env & hot-reload. */
  agentSettings?: AgentSettings;
};

/**
 * One agent the daemon is built with: its adapter, its binary, its own command line. Everything outside the daemon's
 * core that has to know an agent by name reads it from here (harnesses.ts lists them), so a new one is a new entry:
 *
 * - `cycle adapter <id>` runs `runAdapter`;
 * - `cycle <id> <args>` and `cycle login <id>` run its `cli`;
 * - `scripts/build.ts` ships its `binary` beside the daemon;
 * - `config.json` has a section named `id` (config.ts).
 */
export type Harness = {
  /** The agent's id: also its adapter's subcommand, its section in `config.json` and its command. */
  id: string;
  name: string;
  /** Runs the adapter on this process's stdin and stdout, until the connection closes. */
  runAdapter: () => Promise<void>;
  /** The file name its own binary is shipped under, beside the daemon. Absent: it ships none. */
  binary?: string;
  definition: (context: HarnessContext) => AgentDefinition;
  /** Its own command line, run with the environment the daemon gives the agent. Absent: it has none to run. */
  cli?: {
    /** The binary to run: the shipped one, else the machine's. */
    executable: (context?: Omit<HarnessContext, "self" | "log">) => string | undefined;
    env: (context: Omit<HarnessContext, "self" | "log">) => Record<string, string>;
    /** Put before every command it is given (its own options that must always hold). Absent: none. */
    args?: string[];
    /** The arguments that sign in. */
    login: string[];
    /**
     * Variables of `env` naming a directory the agent needs and does not make itself: made (private) before it runs.
     * Absent: none.
     */
    directories?: string[];
  };
};
