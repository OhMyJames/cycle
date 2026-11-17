/**
 * Cycle's configuration of Claude Code as the harness uses it: what a process starts with, and the
 * changes the Connector makes. Nothing of it goes on a command line but paths and names.
 * Why: .agents/notes/2026-11-16-cycle-keeps-claude-code-s-configuration.md
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ClaudeConfig,
  type ClaudeConfigBook,
  type CommandSandbox,
  disallowedTools,
  flagSettings,
  ownServers,
  startKey,
} from "./config.ts";
import { CyclePlugins, type PluginCli, pluginDirs } from "./plugins.ts";
import type { QueryOptions } from "./sdk.ts";

export interface ClaudeConfigOptions {
  book: ClaudeConfigBook;
  /** Where what is made from it is kept: `CYCLE_HOME/claude`. */
  dir: string;
  /** Writes a settings file and answers its path. Defaults to one under `dir`, the owner's alone. */
  writeSettings?: (text: string) => Promise<string>;
  /** Runs Claude Code's `plugin` command in Cycle's plugin home. Defaults to the real one. */
  cli?: PluginCli;
}

/** What a process on this machine is started with, of Cycle's configuration. */
export interface StartOptions {
  options: Pick<
    QueryOptions,
    "settingSources" | "settings" | "disallowedTools" | "plugins" | "pluginDelivery"
  >;
  /** What only a start takes: a process started with another must start again. */
  key: string;
}

/** Writes a settings file named by what it holds, so processes never share one being rewritten. */
function settingsWriter(dir: string): (text: string) => Promise<string> {
  // shortcut: a file whose configuration is gone stays in `dir`; upgrade when there are enough to matter.
  return async (text) => {
    const path = join(
      dir,
      `settings-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.json`,
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, text, { mode: 0o600 });
    return path;
  };
}

/** Claude Code's `plugin` command, run with Cycle's plugin home as its home. */
function realCli(
  dir: string,
  env: Record<string, string>,
  bin: () => string | undefined,
): PluginCli {
  return {
    async run(args) {
      const child = Bun.spawn([bin() ?? "claude", ...args], {
        env: { ...env, CLAUDE_CONFIG_DIR: join(dir, "plugins") },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    },
  };
}

export class ClaudeConfiguration {
  readonly plugins: CyclePlugins;
  private readonly book: ClaudeConfigBook;
  private readonly env: Record<string, string>;
  private readonly writeSettings: (text: string) => Promise<string>;
  private readonly onLog: (line: string) => void;

  constructor(
    options: ClaudeConfigOptions,
    env: Record<string, string>,
    bin: () => string | undefined,
    onLog: (line: string) => void,
  ) {
    this.book = options.book;
    this.env = env;
    this.writeSettings = options.writeSettings ?? settingsWriter(options.dir);
    this.plugins = new CyclePlugins(options.cli ?? realCli(options.dir, env, bin));
    this.onLog = onLog;
  }

  read(): ClaudeConfig {
    return this.book.read();
  }

  async write(config: ClaudeConfig): Promise<void> {
    await this.book.write(config);
  }

  /**
   * What a process on this machine starts with. `sandbox` is the mode's command sandbox, which goes
   * into the settings file: the SDK takes no settings file beside its own option for it.
   */
  async forStart(sandbox?: CommandSandbox): Promise<StartOptions> {
    const config = this.read();
    // A session starts whether or not Cycle's plugins can be read.
    const installed = await this.plugins.installed().catch((error: unknown) => {
      this.onLog(`Cycle's Claude Code plugins could not be read: ${String(error)}`);
      return [];
    });
    const dirs = pluginDirs(installed, config);
    const tools = disallowedTools(config);
    return {
      options: {
        settingSources: config.ownerSettings ? ["user", "project", "local"] : ["project", "local"],
        settings: await this.writeSettings(JSON.stringify(flagSettings(config, sandbox))),
        ...(tools.length ? { disallowedTools: tools } : {}),
        ...(config.run.fallbackModel ? { fallbackModel: config.run.fallbackModel } : {}),
        ...(config.run.maxTurns !== null ? { maxTurns: config.run.maxTurns } : {}),
        ...(config.run.maxBudgetUsd !== null ? { maxBudgetUsd: config.run.maxBudgetUsd } : {}),
        ...(dirs.length
          ? {
              plugins: dirs.map((path) => ({ type: "local" as const, path })),
              pluginDelivery: "initialize" as const,
            }
          : {}),
      },
      key: startKey(config, dirs),
    };
  }

  /**
   * What only a start takes, to tell whether a running process has it. It reads nothing: the plugins
   * are as Cycle last read them, which every start does first.
   */
  startKey(): string {
    const config = this.read();
    return startKey(config, pluginDirs(this.plugins.installedKnown(), config));
  }

  /** Cycle's servers that are on, to hand a process over its pipe. */
  servers(): Record<string, Record<string, unknown>> {
    return ownServers(this.read(), this.env);
  }

  /** The flag layer a running process is given again after a change. */
  flags(): Record<string, unknown> {
    return flagSettings(this.read());
  }
}
