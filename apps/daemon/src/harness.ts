import type { AgentSettings } from "./agent-settings.ts";
import type { AgentDefinition } from "./agents.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { ModelProviders } from "./providers.ts";

/** What a harness is given to make its agent from: nothing of the daemon's own environment but what is named here. */
export type HarnessContext = {
  config: Config;
  dataDir: string;
  /** The daemon's own environment, to take the allowed names from. Never handed on whole (AGENTS.md). */
  inherited: Record<string, string | undefined>;
  /** The command that runs this program again, for `adapter <id>` (self.ts). */
  self: string[];
  log?: Logger;
  /**
   * The daemon's own live per-agent runtime overrides (`<dataDir>/agent-settings.json`), for env and limits read at
   * each start (hot reload). `agentsFor` always gives it: it returns an `AgentsFactory` that the daemon calls with the
   * instance it owns, so no other one can be handed in. Absent only when a test makes a definition by hand.
   */
  agentSettings?: AgentSettings;
  /** The owner's model providers, which an agent that can serve them reads at each start. Absent in a test's hand-made definition. */
  providers?: ModelProviders;
};

/** What a harness's own command line is given: no daemon, so no live runtime settings. */
export type HarnessCliContext = Omit<HarnessContext, "self" | "log" | "agentSettings">;

/**
 * One agent the daemon is built with: its adapter, its binary, its own command line. Everything outside the daemon's
 * core that has to know an agent by name reads it from here (harnesses.ts lists them), so a new one is a new entry:
 *
 * - `cycle adapter <id>` runs `runAdapter`;
 * - `cycle <id> <args>` and `cycle login <id>` run its `cli`;
 * - `scripts/build.ts` ships its `binary` and `companions` beside the daemon;
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
  /**
   * Executables the binary runs from its own directory, shipped beside it under the same names, taken from beside
   * the binary's source. Codex starts `codex-code-mode-host` there for every tool call in code mode; without it each
   * call fails before it runs. Absent: none.
   */
  companions?: string[];
  definition: (context: HarnessContext) => AgentDefinition;
  /**
   * The agent's own Cycle-managed data directory (for storage inspection and cache cleanup in storage.ts).
   * Separate from `HOME` because agents like Claude and Codex keep the host `HOME` while isolating in their
   * own config directory (CYC-401). Absent: falls back to `cli.env(...).HOME`.
   */
  storageDir?: (context: HarnessCliContext) => string | undefined;
  /** Its own command line, run with the environment the daemon gives the agent. Absent: it has none to run. */
  cli?: {
    /** The binary to run: the shipped one, else the machine's. */
    executable: (context?: HarnessCliContext) => string | undefined;
    env: (context: HarnessCliContext) => Record<string, string>;
    /** Put before every command it is given (its own options that must always hold). Absent: none. */
    args?: string[];
    /** The arguments that sign in. */
    login: string[];
    /**
     * Variables of `env` naming a directory the agent needs and does not make itself: made (private) before it runs.
     * Absent: none.
     */
    directories?: string[];
    /** Optional per-invocation setup run after `directories` are created and before spawning the CLI. */
    prepare?: (context: HarnessCliContext, env: Record<string, string>) => Promise<void>;
  };
};
