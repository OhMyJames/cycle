import { join } from "node:path";
import { z } from "zod";
import { defaultDataDir } from "./data-dir.ts";

/** Terminals' settings when `config.json` names none. The environment is who and where, never a key. */
export const TERMINAL_DEFAULTS = {
  allowEnv: ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_*", "TMPDIR"],
  maxPerSession: 8,
  max: 32,
  scrollback: 5000,
};

/**
 * `<dataDir>/config.json`. Everything an agent may see is written here or named here: the daemon
 * hands an agent nothing it was not told to (AGENTS.md), because its own environment holds keys that
 * override a user's login and bill an API.
 */
export const ConfigSchema = z.object({
  agy: z
    .object({
      /** Explicit absolute path to the `agy` binary; overrides `~/.local/bin/agy` and `PATH`. */
      executable: z.string().startsWith("/").optional(),
      /** Isolated HOME directory for `agy` (default `<dataDir>/agy`). */
      home: z.string().startsWith("/").optional(),
      /** Names of the daemon's own variables `agy` may see. */
      allowEnv: z.array(z.string()).default(["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR"]),
      /** Explicit variables passed to `agy` (e.g. `GEMINI_API_KEY`, proxy vars). Never inherited. */
      env: z.record(z.string(), z.string()).default({}),
      /** Pass `--sandbox` to `agy acp`. */
      sandbox: z.boolean().optional(),
      /** Custom main agent name passed via `--agent`. */
      agent: z.string().min(1).optional(),
      /** When explicitly `false`, pass `--disable-telemetry` to `agy acp`. */
      telemetry: z.boolean().optional(),
    })
    .prefault({}),
  codex: z
    .object({
      configDir: z.string().startsWith("/").optional(),
      executable: z.string().startsWith("/").optional(),
      allowEnv: z.array(z.string()).default(["PATH", "LANG", "LC_ALL", "TERM"]),
      env: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  claude: z
    .object({
      /**
       * Claude's own config directory: its login and its transcripts. Default `<dataDir>/claude`, a
       * directory of its own. To use an existing login, point this at it (`~/.claude`) on purpose.
       */
      configDir: z.string().optional(),
      /** Names of the daemon's own variables the Claude process may see. */
      allowEnv: z.array(z.string()).default(["PATH", "LANG", "LC_ALL", "TERM"]),
      /** Variables set to a value, e.g. a key or a base URL. Written here, never inherited. */
      env: z.record(z.string(), z.string()).default({}),
      /**
       * Start a session's Claude process when the session is made, so its slash commands are known
       * before the first message (decision 0014). Costs about 230 MB per new session until it is idle.
       */
      warmStart: z.boolean().default(true),
      /** How many sessions may hold a process that has had no prompt yet; past it the oldest is let go. */
      maxWarm: z.number().int().min(1).default(3),
      /** Ask Claude for a model-written progress line for each sub-agent: a model call each. */
      progressSummaries: z.boolean().default(true),
    })
    .default({
      allowEnv: ["PATH", "LANG", "LC_ALL", "TERM"],
      env: {},
      warmStart: true,
      maxWarm: 3,
      progressSummaries: true,
    }),
  /**
   * Terminals the person opens beside a session (docs/protocol.md §8 "终端"). Their environment is not the daemon's:
   * only the variables named here are passed (a name ending in `*` is a prefix), then `TERM`, `COLORTERM`, `SHELL`,
   * `CLICOLOR` and, on a Mac with no locale, a UTF-8 `LANG`.
   */
  terminal: z
    .object({
      allowEnv: z.array(z.string()).default(TERMINAL_DEFAULTS.allowEnv),
      /** Terminals one session may have, exited ones not yet closed included. */
      maxPerSession: z.number().int().min(1).max(100).default(TERMINAL_DEFAULTS.maxPerSession),
      /** Terminals the daemon may have in all. */
      max: z.number().int().min(1).max(500).default(TERMINAL_DEFAULTS.max),
      /** Lines a terminal keeps above its screen, for a client that attaches later. */
      scrollback: z.number().int().min(0).max(100_000).default(TERMINAL_DEFAULTS.scrollback),
    })
    .default(TERMINAL_DEFAULTS),
  /** What is let go when nothing is happening (docs/daemon.md "空闲回收"、"空闲退出"). 0 turns either off. */
  idle: z
    .object({
      /**
       * A session's agent process, once it has had nothing to do and nobody attached this long, is ended (about
       * 230 MB each for Claude). The session stays; its next prompt starts and resumes the agent.
       */
      agentMinutes: z.number().min(0).default(10),
      /**
       * The daemon itself, once no client has been connected and no session has been doing anything this long, stops.
       * Nothing is lost; the next `cycle proxy` (a client connecting) starts it again.
       */
      exitMinutes: z.number().min(0).default(30),
    })
    .default({ agentMinutes: 10, exitMinutes: 30 }),
  /** The daemon's own log, `<dataDir>/daemon.log` (docs/daemon.md "日志"). Events only, never content. */
  log: z
    .object({
      /** `debug` adds sessions loaded and clients attaching; `warn` and `error` keep only what went wrong. */
      level: z.enum(["error", "warn", "info", "debug"]).default("info"),
      /** Past this size the file is rotated. */
      maxBytes: z.number().int().min(10_000).default(1_000_000),
      /** Rotated files kept beside the current one: the log takes at most maxBytes × (files + 1). */
      files: z.number().int().min(0).max(20).default(3),
    })
    .default({ level: "info", maxBytes: 1_000_000, files: 3 }),
});
export type Config = z.infer<typeof ConfigSchema>;

export type Paths = {
  dataDir: string;
  socket: string;
  config: string;
  /** The daemon's log (docs/daemon.md "日志"). */
  log: string;
  /** What a daemon started in the background writes to its stdout and stderr: what the runtime says as it dies. */
  output: string;
};

export const pathsFor = (dataDir: string, socket?: string): Paths => ({
  dataDir,
  socket: socket ?? join(dataDir, "daemon.sock"),
  config: join(dataDir, "config.json"),
  log: join(dataDir, "daemon.log"),
  output: join(dataDir, "daemon.out"),
});

export const loadConfig = async (path: string): Promise<Config> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return ConfigSchema.parse({});
  try {
    return ConfigSchema.parse(JSON.parse(await file.text()));
  } catch (error) {
    throw new Error(`${path} cannot be read: ${error instanceof Error ? error.message : error}`);
  }
};

export { defaultDataDir };
