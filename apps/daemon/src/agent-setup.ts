import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGY_MIN_VERSION, isVersionSupported } from "@cycle/harness-agy";
import { codexAppServerArgs, planWindowsOf, type RateLimitSnapshot } from "@cycle/harness-codex";
import {
  type AgentAccountInfo,
  type AgentAuthFailureReason,
  type AgentAuthMethod,
  type AgentAuthMode,
  type AgentAuthState,
  type AgentAuthUnknownReason,
  type AgentBinarySource,
  type AgentBinaryStatus,
  type AgentConfigFileStatus,
  type AgentRuntimeSnapshot,
  type AgentSignInMode,
  META,
  type PlanUsage,
  type RuntimeProperty,
} from "@cycle/protocol";
import type { AgentSettings } from "./agent-settings.ts";
import { type Config, ConfigSchema } from "./config.ts";
import { defaultDataDir } from "./data-dir.ts";

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type AgentSetupRunCommand = (
  command: string[],
  options: { env: Record<string, string>; timeoutMs: number },
) => Promise<CommandResult>;

export type AgentAuthProbeResult = {
  state: AgentAuthState;
  unknownReason?: AgentAuthUnknownReason;
  method: AgentAuthMethod;
  /** Env variable name from config.json `env` or `allowEnv` overriding subscription auth, never its value. */
  viaEnv?: string;
  account?: AgentAccountInfo;
  /** Fresh plan usage fetched during this probe (e.g. Codex `account/rateLimits/read`). */
  planUsage?: PlanUsage;
};

export type AgentEnvironmentDetails = {
  dataDir: string;
  customDataDir: boolean;
  allowEnv: string[];
  envNames: string[];
};

/** Structured error thrown by an agent auth driver; maps cleanly to `-32021` + fixed `data.reason`. */
export class AgentAuthDriverError extends Error {
  readonly reason: AgentAuthFailureReason;
  constructor(reason: AgentAuthFailureReason, message?: string) {
    super(message ?? `Agent auth failed: ${reason}`);
    this.name = "AgentAuthDriverError";
    this.reason = reason;
  }
}

export type AgentAuthFlowOutcome = { ok: true } | { ok: false; reason: AgentAuthFailureReason };

export type AgentAuthFlowHandle = {
  authorizationUrl?: string | undefined;
  verificationUrl?: string | undefined;
  userCode?: string | undefined;
  /** Resolves when the underlying login process/RPC completes or fails. */
  completed: Promise<AgentAuthFlowOutcome>;
  /** Submit a short-lived one-time code for `"code"` mode (memory-only, never persisted/logged). */
  submit?: (code: string) => Promise<AgentAuthFlowOutcome>;
  /** Terminate subprocess / cancel remote login cleanly. Must be idempotent and never throw. */
  cancel: () => Promise<void> | void;
};

export type AgentAuthDriver = {
  /** `signal` aborts a start still waiting for its URL: the child is killed at once, and the start rejects. */
  start: (mode: AgentAuthMode, signal?: AbortSignal) => Promise<AgentAuthFlowHandle>;
  logout?: () => Promise<void>;
  /** Clear any short-TTL in-memory auth probe cache (e.g. agy 45s cache). */
  invalidateCache?: () => void;
};

export type AgentSetupProvider = {
  /** `forceRefresh` re-runs the `--version` probe instead of using its cache. */
  probeBinary: (options?: {
    forceRefresh?: boolean;
  }) => Promise<AgentBinaryStatus> | AgentBinaryStatus;
  readAuth: (options?: {
    refreshUsage?: boolean;
    forceRefresh?: boolean;
  }) => Promise<AgentAuthProbeResult>;
  signInModes: () => readonly AgentSignInMode[];
  canSignOut: () => boolean;
  canRefreshUsage: boolean;
  loginCommand: string;
  diagnostics: () => AgentEnvironmentDetails;
  /** Closed v1 runtime property schema enforced by the daemon on `_cycle/agent_setup/set_runtime`. */
  runtimeSchema?: Record<string, RuntimeProperty>;
  runtimeSnapshot: (settings?: AgentSettings) => AgentRuntimeSnapshot;
  /** Optional interactive login/logout driver (Phase 3). */
  authDriver?: AgentAuthDriver;
};

export const CLAUDE_RUNTIME_DEFAULTS = {
  warmStart: true,
  maxWarm: 3,
  progressSummaries: true,
};

export const CLAUDE_RUNTIME_SCHEMA: Record<string, RuntimeProperty> = {
  warmStart: {
    type: "boolean",
    title: "Warm start",
    description:
      "Start a Claude process when a new session is created so slash commands appear before the first message.",
    default: CLAUDE_RUNTIME_DEFAULTS.warmStart,
    _meta: { [META.applyScope]: "immediate" },
  },
  maxWarm: {
    type: "integer",
    title: "Max warm processes",
    description: "Maximum number of unprompted sessions kept warm before the oldest is reclaimed.",
    minimum: 1,
    maximum: 10,
    default: CLAUDE_RUNTIME_DEFAULTS.maxWarm,
    _meta: {
      [META.applyScope]: "immediate",
      [META.enabledWhen]: { key: "warmStart", equals: true },
    },
  },
  progressSummaries: {
    type: "boolean",
    title: "Sub-agent progress summaries",
    description: "Ask Claude for short model-written progress lines for running sub-agents.",
    default: CLAUDE_RUNTIME_DEFAULTS.progressSummaries,
    _meta: { [META.applyScope]: "next_idle_restart" },
  },
};

export const claudeEffectiveRuntime = (config: Config["claude"], settings?: AgentSettings) => {
  const fromConfig = {
    warmStart: config.warmStart,
    maxWarm: Math.min(10, Math.max(1, config.maxWarm)),
    progressSummaries: config.progressSummaries,
  };
  return settings !== undefined
    ? settings.effective("claude", CLAUDE_RUNTIME_DEFAULTS, fromConfig)
    : { values: fromConfig, overrides: [] as string[], revision: 0 };
};

export const AGY_RUNTIME_DEFAULTS = {
  sandbox: false,
  telemetry: true,
};

export const AGY_RUNTIME_SCHEMA: Record<string, RuntimeProperty> = {
  sandbox: {
    type: "boolean",
    title: "Sandbox",
    description: "Run agy acp with --sandbox enabled to restrict filesystem and shell access.",
    default: AGY_RUNTIME_DEFAULTS.sandbox,
    _meta: { [META.applyScope]: "next_idle_restart", [META.danger]: true },
  },
  telemetry: {
    type: "boolean",
    title: "Telemetry",
    description:
      "Send usage telemetry to Google Antigravity. When disabled, Cycle passes --disable-telemetry.",
    default: AGY_RUNTIME_DEFAULTS.telemetry,
    _meta: { [META.applyScope]: "next_idle_restart" },
  },
};

export const agyEffectiveRuntime = (config: Config["agy"], settings?: AgentSettings) => {
  const fromConfig: Partial<typeof AGY_RUNTIME_DEFAULTS> = {
    ...(config.sandbox !== undefined ? { sandbox: config.sandbox } : {}),
    ...(config.telemetry !== undefined ? { telemetry: config.telemetry } : {}),
  };
  return settings !== undefined
    ? settings.effective("agy", AGY_RUNTIME_DEFAULTS, fromConfig)
    : {
        values: { ...AGY_RUNTIME_DEFAULTS, ...fromConfig },
        overrides: [] as string[],
        revision: 0,
      };
};

export type ConfigFileSnapshotOptions = {
  path: string;
  /** `mtimeMs` captured when the daemon loaded `config.json` at startup; undefined when the file did not exist then. */
  loadedMtimeMs?: number | undefined;
  /** Startup load error, if any. */
  startupError?: string | undefined;
};

/** Capture `config.json`'s mtime at daemon startup for later `stale` comparison. */
export const captureConfigMtime = (path: string): number | undefined => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * Sanitize `config.json` read/parse errors so secret values under `env` (e.g. near a syntax error)
 * can never be echoed over L1. Reports only error category or schema field paths, never raw snippets.
 */
const sanitizeConfigError = (err: unknown): string => {
  if (err instanceof SyntaxError) return "Invalid JSON syntax in config.json";
  if (
    typeof err === "object" &&
    err !== null &&
    Array.isArray((err as { issues?: unknown }).issues)
  ) {
    const issues = (err as { issues: { path?: unknown }[] }).issues;
    const paths = issues
      .map((issue) => (Array.isArray(issue.path) ? issue.path.map(String).join(".") : ""))
      .filter((p) => p !== "");
    if (paths.length > 0) {
      return `Invalid config.json fields: ${[...new Set(paths)].slice(0, 5).join(", ")}`;
    }
    return "Invalid config.json schema";
  }
  return "Could not read config.json";
};

/**
 * Inspect `config.json` strictly read-only: whether it exists, whether its mtime changed since startup (`stale`),
 * and whether its current contents fail JSON/schema validation. Never returns any env values or raw file snippets.
 */
export const readConfigFileStatus = (options: ConfigFileSnapshotOptions): AgentConfigFileStatus => {
  const exists = existsSync(options.path);
  let currentMtimeMs: number | undefined;
  if (exists) {
    try {
      currentMtimeMs = statSync(options.path).mtimeMs;
    } catch {
      currentMtimeMs = undefined;
    }
  }
  const stale =
    options.loadedMtimeMs === undefined
      ? exists
      : !exists || (currentMtimeMs !== undefined && currentMtimeMs !== options.loadedMtimeMs);

  let error = options.startupError !== undefined ? "Invalid config.json at startup" : undefined;
  if (exists) {
    try {
      ConfigSchema.parse(JSON.parse(readFileSync(options.path, "utf8")));
      error = undefined;
    } catch (err) {
      error = sanitizeConfigError(err);
    }
  }

  return {
    path: options.path,
    exists,
    stale,
    ...(error !== undefined ? { error } : {}),
  };
};

/** How long a stopped subprocess gets between `SIGTERM` and `SIGKILL`. */
const KILL_GRACE_MS = 500;
/** How long output is still read after the command itself has exited (a grandchild may hold the pipes). */
const OUTPUT_DRAIN_MS = 250;
/** Captured output beyond this is dropped: a probe's answer is short. */
const MAX_OUTPUT_CHARS = 1_000_000;

/**
 * Signal a setup subprocess and everything it started. Every setup subprocess is spawned `detached` (its own process
 * group, see `Bun.spawn`), so the group id is its pid; when the group is already gone, the child itself is signalled.
 */
const signalGroup = (
  proc: { pid: number; kill: (signal?: number | NodeJS.Signals) => void },
  signal: NodeJS.Signals,
): void => {
  try {
    process.kill(-proc.pid, signal);
    return;
  } catch {
    // no such group: fall back to the child alone
  }
  try {
    proc.kill(signal);
  } catch {
    // already exited
  }
};

/** Whether `promise` settles within `ms` (its outcome is not looked at). Never leaves a timer behind. */
const settlesWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Stops a setup subprocess and its process group: `SIGTERM`, then `SIGKILL` after `graceMs`, and waits for the child's
 * exit (bounded: a child that ignores even `SIGKILL` does not hang the caller).
 */
const terminateProcess = async (
  proc: ReturnType<typeof Bun.spawn>,
  graceMs = KILL_GRACE_MS,
): Promise<void> => {
  signalGroup(proc, "SIGTERM");
  if (await settlesWithin(proc.exited, graceMs)) {
    // The child is gone; anything it left in its group is not kept either.
    signalGroup(proc, "SIGKILL");
    return;
  }
  signalGroup(proc, "SIGKILL");
  await settlesWithin(proc.exited, graceMs);
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Reads a stream to text in the background; `cancel()` stops it, keeping what was read. */
const collectText = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (text.length < MAX_OUTPUT_CHARS) text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      // cancelled
    }
  })();
  return {
    done,
    text: () => text,
    cancel: () => reader.cancel().catch(() => {}),
  };
};

/**
 * Run a subprocess with an explicit isolated environment (never inherits `process.env`) and a hard timeout that bounds
 * the whole call: the command's exit, and its output. A grandchild that keeps the pipes open (agy starts a language
 * server) is given a short drain, then its process group is killed and the readers are cancelled.
 */
export const runIsolatedCommand: AgentSetupRunCommand = async (command, { env, timeoutMs }) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(command, {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }
  const stdout = collectText(proc.stdout);
  const stderr = collectText(proc.stderr);
  let timedOut = false;
  if (!(await settlesWithin(proc.exited, timeoutMs))) {
    timedOut = true;
    await terminateProcess(proc);
  }
  const output = Promise.all([stdout.done, stderr.done]);
  if (!(await settlesWithin(output, OUTPUT_DRAIN_MS))) {
    signalGroup(proc, "SIGKILL");
    await Promise.all([stdout.cancel(), stderr.cancel()]);
    await settlesWithin(output, OUTPUT_DRAIN_MS);
  }
  return { exitCode: proc.exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut };
};

/**
 * The one rule every agent's `--version` output is read with (Claude, Codex, agy, the setup page and agy's
 * `available()` alike): the first `x.y.z[-pre]` anywhere, else the first non-empty line.
 */
export const extractVersion = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const semver = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(trimmed);
  if (semver?.[1]) return semver[1];
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
  return firstLine || undefined;
};

const VERSION_TIMEOUT_MS = 3000;
/** A failed `--version` (timeout, crash, unreadable output) is remembered this long, a good one until the file changes. */
export const VERSION_FAILURE_TTL_MS = 5000;

const versionCache = new Map<string, { version: string | undefined; at: number }>();
const versionInFlight = new Map<string, Promise<string | undefined>>();

/** The cache key: the file and what it is now, so an upgrade in place is probed again. */
const versionKey = (executable: string): string | undefined => {
  try {
    const st = statSync(executable);
    return `${executable}:${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
};

/**
 * What is known of `executable --version` without running anything: `{ version }` (version `undefined` for a recent
 * failure), or `undefined` when nothing is known.
 */
export const cachedBinaryVersion = (
  executable: string,
  now: number = Date.now(),
): { version: string | undefined } | undefined => {
  const key = versionKey(executable);
  if (key === undefined) return undefined;
  const hit = versionCache.get(key);
  if (hit === undefined) return undefined;
  if (hit.version === undefined && now - hit.at >= VERSION_FAILURE_TTL_MS) return undefined;
  return { version: hit.version };
};

/**
 * `executable --version`, shared by every caller: one subprocess at a time per binary (concurrent callers share it),
 * a good answer cached until the file changes, a failure for `VERSION_FAILURE_TTL_MS`; `forceRefresh` skips the cache.
 */
export const probeBinaryVersion = (
  executable: string,
  env: Record<string, string>,
  options: { run?: AgentSetupRunCommand; forceRefresh?: boolean; now?: () => number } = {},
): Promise<string | undefined> => {
  const key = versionKey(executable);
  if (key === undefined) return Promise.resolve(undefined);
  const now = options.now ?? Date.now;
  if (options.forceRefresh !== true) {
    const hit = cachedBinaryVersion(executable, now());
    if (hit !== undefined) return Promise.resolve(hit.version);
  }
  const pending = versionInFlight.get(key);
  if (pending !== undefined) return pending;
  const run = options.run ?? runIsolatedCommand;
  const probe = (async () => {
    let version: string | undefined;
    try {
      const result = await run([executable, "--version"], { env, timeoutMs: VERSION_TIMEOUT_MS });
      version =
        !result.timedOut && result.exitCode === 0
          ? (extractVersion(result.stdout) ?? extractVersion(result.stderr))
          : undefined;
    } catch {
      version = undefined;
    }
    versionCache.set(key, { version, at: now() });
    versionInFlight.delete(key);
    return version;
  })();
  versionInFlight.set(key, probe);
  return probe;
};

/** The environment every setup subprocess gets: `PATH`, and the agent's own isolated environment. */
const isolatedEnv =
  (inherited: Record<string, string | undefined>, env: () => Record<string, string>) =>
  (): Record<string, string> => ({
    PATH: inherited.PATH ?? "/usr/bin:/bin",
    ...env(),
  });

/** Create an agent's private directory if it is missing; the agent reports it if it cannot be. */
const ensurePrivateDir = (dir: string | undefined): void => {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // let the agent report an unwritable directory
  }
};

export type LocateBinary = () => { source: AgentBinarySource; path?: string };

/** `probeBinary` for a provider: where the binary is, its version, and (with `minVersion`) whether it is new enough. */
const binaryProber =
  (
    locate: LocateBinary,
    env: () => Record<string, string>,
    run: AgentSetupRunCommand,
    minVersion?: string,
  ) =>
  async (options?: { forceRefresh?: boolean }): Promise<AgentBinaryStatus> => {
    const min = minVersion !== undefined ? { minVersion } : {};
    const found = locate();
    if (found.source === "missing" || !found.path || !isExecutable(found.path)) {
      return { source: "missing", ...min, problem: "missing" };
    }
    const version = await probeBinaryVersion(found.path, env(), {
      run,
      forceRefresh: options?.forceRefresh === true,
    });
    const at = { source: found.source, path: found.path };
    if (minVersion === undefined) return { ...at, ...(version !== undefined ? { version } : {}) };
    if (version === undefined) return { ...at, ...min, problem: "probe_failed" };
    if (!isVersionSupported(version, minVersion)) {
      return { ...at, version, ...min, problem: "version_too_old" };
    }
    return { ...at, version, ...min };
  };

/** How long a definitive Claude / Codex account answer is reused (agy's own default is longer, its probe is slower). */
export const AUTH_CACHE_TTL_MS = 10_000;

/**
 * One agent's account reads: a definitive answer (`signed_in` / `signed_out`) is reused for `ttlMs`, and reads that
 * overlap share one probe (every `_cycle/agent_setup_changed` makes every client read at once). `forceRefresh` skips the
 * cached answer; `refreshUsage` needs a probe that fetched usage. `invalidate()` (sign-in, sign-out) drops both the
 * cached answer and any probe already running, whose answer may predate the change.
 */
const authCache = (ttlMs: number, now: () => number) => {
  let cached: { at: number; result: AgentAuthProbeResult } | undefined;
  let inFlight: { gen: number; usage: boolean; promise: Promise<AgentAuthProbeResult> } | undefined;
  let gen = 0;
  return {
    read: (
      options: { refreshUsage?: boolean; forceRefresh?: boolean } | undefined,
      probe: () => Promise<AgentAuthProbeResult>,
    ): Promise<AgentAuthProbeResult> => {
      const usage = options?.refreshUsage === true;
      if (
        options?.forceRefresh !== true &&
        !usage &&
        cached !== undefined &&
        now() - cached.at < ttlMs
      ) {
        return Promise.resolve(cached.result);
      }
      if (inFlight !== undefined && inFlight.gen === gen && (inFlight.usage || !usage)) {
        return inFlight.promise;
      }
      const startedGen = gen;
      const entry = {
        gen: startedGen,
        usage,
        promise: probe().then(
          (result) => {
            if (gen === startedGen) {
              if (result.state === "signed_in" || result.state === "signed_out") {
                // Usage is reported once, when it is fetched: a cached answer does not repeat it.
                const { planUsage: _planUsage, ...rest } = result;
                cached = { at: now(), result: rest };
              } else {
                cached = undefined;
              }
            }
            if (inFlight === entry) inFlight = undefined;
            return result;
          },
          (error: unknown) => {
            if (inFlight === entry) inFlight = undefined;
            throw error;
          },
        ),
      };
      inFlight = entry;
      return entry.promise;
    },
    invalidate: () => {
      gen += 1;
      cached = undefined;
      inFlight = undefined;
    },
  };
};

const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The copyable sign-in fallback: `cycle login <agent>`, with `--data-dir` (a Cycle option, so before the command) when
 * the daemon keeps its data anywhere but the default `~/.cycle`, so the command signs in to the same place.
 */
export const loginCommandFor = (agent: string, dataDir: string): string =>
  resolve(dataDir) === resolve(defaultDataDir({}))
    ? `cycle login ${agent}`
    : `cycle --data-dir ${shellWord(dataDir)} login ${agent}`;

/** Where an agent's state lives as its environment says (config.json `env` may override the default). */
const dataDirDiagnostics = (
  resolved: string | undefined,
  fallback: string,
): Pick<AgentEnvironmentDetails, "dataDir" | "customDataDir"> => {
  const dataDir = resolved ?? fallback;
  return { dataDir, customDataDir: resolve(dataDir) !== resolve(fallback) };
};

/**
 * Detect whether `config.json` `env` or `allowEnv` (present in `inherited`) sets one of an agent's auth override
 * env variables. Returns ONLY the variable name, never its value.
 */
export const detectViaEnv = (
  candidates: readonly string[],
  configEnv: Record<string, string>,
  allowEnv: readonly string[],
  inherited: Record<string, string | undefined>,
): string | undefined => {
  for (const name of candidates) {
    const explicit = configEnv[name];
    if (typeof explicit === "string" && explicit.length > 0) return name;
  }
  const allowed = new Set(allowEnv);
  for (const name of candidates) {
    if (!allowed.has(name)) continue;
    const value = inherited[name];
    if (typeof value === "string" && value.length > 0) return name;
  }
  return undefined;
};

const CLAUDE_AUTH_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

const CODEX_AUTH_ENV_NAMES = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

const AGY_AUTH_ENV_NAMES = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

const parseTimestampMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
};

const mapClaudeAuthMethod = (raw: unknown, apiProvider: unknown): AgentAuthMethod => {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  const provider = typeof apiProvider === "string" ? apiProvider.toLowerCase() : "";
  if (value === "none" || value === "") return "none";
  if (value === "api_key" || value === "apikey") return "api_key";
  if (value === "oauth_token") return "oauth_token";
  if (
    value === "third_party" ||
    provider === "bedrock" ||
    provider === "vertex" ||
    provider === "foundry"
  ) {
    return "third_party";
  }
  if (
    value === "claudeai" ||
    value === "claude.ai" ||
    value === "oauth" ||
    value === "subscription" ||
    value === "firstparty"
  ) {
    return "subscription";
  }
  return "unknown";
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const NETWORK_ERROR_RE =
  /econnrefused|enotfound|etimedout|eai_again|network|fetch failed|dns|tls|certificate|502|503|504|offline|socket hang up/i;

export type ClaudeSetupOptions = {
  config: Config["claude"];
  dataDir: string;
  inherited: Record<string, string | undefined>;
  env: () => Record<string, string>;
  locateBinary: LocateBinary;
  runCommand?: AgentSetupRunCommand;
  startCodeAuth?: StartCliCodeAuth;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
};

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export const CLAUDE_AUTH_URL_RE =
  /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com)\/[^\s"'<>]+/;

export const AGY_AUTH_URL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/;

const INVALID_CODE_RE =
  /invalid[_ -]?code|invalid[_ -]?grant|incorrect code|expired code|code.*(?:invalid|expired|rejected)/i;

/** A one-time code is one line of printable text: anything else could answer more than the code prompt. */
const hasControlChar = (text: string): boolean => {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Strips ANSI sequences and extracts the first complete authorization URL matching `pattern`. */
export const extractAuthUrl = (text: string, pattern: RegExp): string | undefined => {
  const clean = text.replace(ANSI_ESCAPE_RE, "");
  // Only match URLs followed by whitespace or newline so we don't capture a half-streamed chunk.
  const match = clean.match(new RegExp(`(${pattern.source})(?=[\\s\\r\\n])`));
  if (!match?.[1]) return undefined;
  return match[1].replace(/[.,;)]+$/, "");
};

export type CliCodeAuthOptions = {
  command: string[];
  env: Record<string, string>;
  urlPattern: RegExp;
  startTimeoutMs?: number;
  submitTimeoutMs?: number;
  signal?: AbortSignal | undefined;
};

export type StartCliCodeAuth = (options: CliCodeAuthOptions) => Promise<AgentAuthFlowHandle>;

const noopBrowser = (): string => (existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true");

/**
 * Drives a non-TTY hosted-callback CLI login (`claude auth login --claudeai` or `agy acp --login`):
 * - Sets `BROWSER=/usr/bin/true` so the CLI never silently launches a browser on the daemon host.
 * - Extracts the authorization URL from stdout/stderr (stripping ANSI).
 * - Writes the user's one-time code to stdin in memory on `submit(code)` (never persisted or logged).
 * - Cleans up via `SIGTERM` + 500ms grace `SIGKILL` on `cancel()`.
 */
export const startCliCodeAuth: StartCliCodeAuth = async ({
  command,
  env,
  urlPattern,
  startTimeoutMs = 15_000,
  submitTimeoutMs = 30_000,
  signal,
}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      env: { ...env, BROWSER: noopBrowser() },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch {
    throw new AgentAuthDriverError("process_failed", "Failed to start CLI login process");
  }

  const stdin = proc.stdin as Bun.FileSink;
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const stderr = proc.stderr as ReadableStream<Uint8Array>;
  const outReader = stdout.getReader();
  const errReader = stderr.getReader();

  let combined = "";
  // Only what the CLI says after the code is written can say the code was wrong (not, say, a URL's `code=` before it).
  let afterSubmit: string | undefined;
  let cancelled = false;
  let settled = false;
  let resolveCompleted!: (outcome: AgentAuthFlowOutcome) => void;
  const completed = new Promise<AgentAuthFlowOutcome>((resolve) => {
    resolveCompleted = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
  });

  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: AgentAuthDriverError) => void;
  let urlSettled = false;
  const urlPromise = new Promise<string>((resolve, reject) => {
    resolveUrl = (url) => {
      if (urlSettled) return;
      urlSettled = true;
      resolve(url);
    };
    rejectUrl = (error) => {
      if (urlSettled) return;
      urlSettled = true;
      reject(error);
    };
  });

  let killPromise: Promise<void> | undefined;
  const killProc = (): Promise<void> => {
    killPromise ??= (async () => {
      try {
        stdin.end();
      } catch {
        // ignore
      }
      try {
        await outReader.cancel();
      } catch {
        // ignore
      }
      try {
        await errReader.cancel();
      } catch {
        // ignore
      }
      await terminateProcess(proc);
    })();
    return killPromise;
  };

  const onChunk = (text: string) => {
    combined += text;
    if (combined.length > 64_000) combined = combined.slice(-32_000);
    if (afterSubmit !== undefined) {
      afterSubmit += text;
      if (afterSubmit.length > 64_000) afterSubmit = afterSubmit.slice(-32_000);
    }
    if (!urlSettled) {
      const found = extractAuthUrl(combined, urlPattern);
      if (found !== undefined) resolveUrl(found);
    }
  };

  const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        onChunk(decoder.decode(chunk.value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) onChunk(tail);
    } catch {
      // cancelled
    }
  };

  const outDone = pump(outReader);
  const errDone = pump(errReader);

  void proc.exited.then(async (exitCode) => {
    await Promise.allSettled([outDone, errDone]);
    if (!urlSettled) {
      // Final check with trailing newline in case URL was at EOF without trailing space.
      const atEof = extractAuthUrl(`${combined}\n`, urlPattern);
      if (atEof !== undefined) {
        resolveUrl(atEof);
      } else {
        rejectUrl(
          new AgentAuthDriverError(
            "parse_failed",
            "CLI exited before printing a valid authorization URL",
          ),
        );
      }
    }
    if (!settled) {
      if (cancelled) {
        resolveCompleted({ ok: false, reason: "cancelled" });
      } else if (exitCode === 0) {
        resolveCompleted({ ok: true });
      } else {
        const reason =
          afterSubmit !== undefined && INVALID_CODE_RE.test(afterSubmit)
            ? "invalid_code"
            : "process_failed";
        resolveCompleted({ ok: false, reason });
      }
    }
  });

  const startTimer = setTimeout(() => {
    rejectUrl(new AgentAuthDriverError("timeout", "Timed out waiting for authorization URL"));
  }, startTimeoutMs);
  const onAbort = () => {
    cancelled = true;
    rejectUrl(new AgentAuthDriverError("cancelled", "Sign-in was cancelled before it started"));
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  let authorizationUrl: string;
  try {
    authorizationUrl = await urlPromise;
  } catch (error) {
    clearTimeout(startTimer);
    await killProc();
    throw error;
  } finally {
    clearTimeout(startTimer);
    signal?.removeEventListener("abort", onAbort);
  }

  return {
    authorizationUrl,
    completed,
    submit: async (code: string): Promise<AgentAuthFlowOutcome> => {
      if (settled) return { ok: false, reason: "process_failed" };
      const oneLine = code.trim();
      if (oneLine === "" || hasControlChar(oneLine)) {
        return { ok: false, reason: "invalid_code" };
      }
      try {
        afterSubmit = "";
        stdin.write(`${oneLine}\n`);
        stdin.flush();
      } catch {
        return { ok: false, reason: "process_failed" };
      }

      let submitTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<AgentAuthFlowOutcome>((resolve) => {
        submitTimer = setTimeout(() => {
          resolve({ ok: false, reason: "timeout" });
        }, submitTimeoutMs);
      });
      const outcome = await Promise.race([completed, timeoutPromise]);
      clearTimeout(submitTimer);
      if (!settled && !outcome.ok && outcome.reason === "timeout") {
        await killProc();
        resolveCompleted(outcome);
      }
      return outcome;
    },
    cancel: async () => {
      cancelled = true;
      await killProc();
      resolveCompleted({ ok: false, reason: "cancelled" });
    },
  };
};

export const createClaudeSetupProvider = (options: ClaudeSetupOptions): AgentSetupProvider => {
  const run = options.runCommand ?? runIsolatedCommand;
  const startCodeAuth = options.startCodeAuth ?? startCliCodeAuth;
  const timeoutMs = options.timeoutMs ?? 8000;
  const cache = authCache(options.cacheTtlMs ?? AUTH_CACHE_TTL_MS, options.now ?? Date.now);
  const minimalEnv = isolatedEnv(options.inherited, options.env);
  const probeBinary = binaryProber(options.locateBinary, minimalEnv, run);
  const viaEnv = detectViaEnv(
    CLAUDE_AUTH_ENV_NAMES,
    options.config.env,
    options.config.allowEnv,
    options.inherited,
  );
  const via = viaEnv !== undefined ? { viaEnv } : {};

  /** A usable binary or the `binary_unavailable` driver error. */
  const requireBinary = async (): Promise<string> => {
    const binary = await probeBinary();
    if (binary.problem !== undefined || !binary.path) {
      throw new AgentAuthDriverError("binary_unavailable", "Claude binary is unavailable");
    }
    return binary.path;
  };

  const probeAuth = async (executable: string): Promise<AgentAuthProbeResult> => {
    const env = minimalEnv();
    ensurePrivateDir(env.CLAUDE_CONFIG_DIR);
    const result = await run([executable, "auth", "status", "--json"], { env, timeoutMs });
    if (result.timedOut) {
      return { state: "auth_unknown", unknownReason: "timeout", method: "unknown", ...via };
    }

    let parsed: Record<string, unknown> | undefined;
    try {
      const candidate = JSON.parse(result.stdout.trim());
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = undefined;
    }

    if (!parsed || typeof parsed.loggedIn !== "boolean") {
      const combined = `${result.stdout}\n${result.stderr}`;
      return {
        state: "auth_unknown",
        unknownReason: NETWORK_ERROR_RE.test(combined) ? "network_error" : "probe_failed",
        method: "unknown",
        ...via,
      };
    }

    if (!parsed.loggedIn) return { state: "signed_out", method: "none", ...via };

    const method = mapClaudeAuthMethod(parsed.authMethod, parsed.apiProvider);
    const email = nonEmptyString(parsed.email);
    const organization = nonEmptyString(parsed.organization) ?? nonEmptyString(parsed.orgName);
    const plan = nonEmptyString(parsed.subscriptionType);
    const expiresAt = parseTimestampMs(parsed.loginExpiresAt) ?? parseTimestampMs(parsed.expiresAt);
    const account: AgentAccountInfo = {
      ...(email !== undefined ? { email } : {}),
      ...(organization !== undefined ? { organization } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };

    return {
      state: "signed_in",
      method,
      ...via,
      ...(Object.keys(account).length > 0 ? { account } : {}),
    };
  };

  const readAuth: AgentSetupProvider["readAuth"] = async (opts) => {
    const binary = await probeBinary(opts?.forceRefresh === true ? { forceRefresh: true } : {});
    if (binary.problem !== undefined || !binary.path) {
      cache.invalidate();
      return { state: "binary_unavailable", method: "none", ...via };
    }
    const executable = binary.path;
    return cache.read(opts, () => probeAuth(executable));
  };

  return {
    probeBinary,
    readAuth,
    signInModes: () => [{ mode: "code", requiresLocalLoopback: false }],
    canSignOut: () => true,
    canRefreshUsage: false,
    loginCommand: loginCommandFor("claude", options.dataDir),
    authDriver: {
      start: async (mode, signal) => {
        if (mode !== "code") {
          throw new AgentAuthDriverError("process_failed", `Unsupported Claude auth mode: ${mode}`);
        }
        const executable = await requireBinary();
        const env = minimalEnv();
        ensurePrivateDir(env.CLAUDE_CONFIG_DIR);
        return startCodeAuth({
          command: [executable, "auth", "login", "--claudeai"],
          env,
          urlPattern: CLAUDE_AUTH_URL_RE,
          startTimeoutMs: Math.max(timeoutMs, 15_000),
          signal,
        });
      },
      logout: async () => {
        const executable = await requireBinary();
        const env = minimalEnv();
        ensurePrivateDir(env.CLAUDE_CONFIG_DIR);
        const result = await run([executable, "auth", "logout"], { env, timeoutMs });
        cache.invalidate();
        if (result.timedOut) {
          throw new AgentAuthDriverError("timeout", "Claude logout timed out");
        }
        if (result.exitCode !== 0) {
          throw new AgentAuthDriverError("process_failed", "Claude logout failed");
        }
      },
      invalidateCache: cache.invalidate,
    },
    diagnostics: () => ({
      ...dataDirDiagnostics(options.env().CLAUDE_CONFIG_DIR, join(options.dataDir, "claude")),
      allowEnv: [...options.config.allowEnv],
      envNames: Object.keys(options.config.env).sort(),
    }),
    runtimeSchema: CLAUDE_RUNTIME_SCHEMA,
    runtimeSnapshot: (settings) => {
      const merged = claudeEffectiveRuntime(options.config, settings);
      const fileError = settings?.fileError();
      return {
        schemaVersion: 1,
        schema: { type: "object", properties: CLAUDE_RUNTIME_SCHEMA },
        values: merged.values,
        overrides: merged.overrides,
        revision: merged.revision,
        ...(fileError !== undefined ? { fileError } : {}),
      };
    },
  };
};

type RpcMessage = Record<string, unknown>;

/** Why a request to a short-lived JSON-RPC child got no answer. */
class RpcChildError extends Error {
  readonly kind: "timeout" | "exited";
  constructor(kind: "timeout" | "exited", message: string) {
    super(message);
    this.name = "RpcChildError";
    this.kind = kind;
  }
}

type RpcChild = {
  /** Resolves with the whole response message (`result` or `error`); rejects with `RpcChildError`. */
  request: (method: string, params: unknown, timeoutMs: number) => Promise<RpcMessage>;
  notify: (method: string, params: unknown) => void;
  /** Resolves when the child's stdout ends (it exited, or `close()` was called). */
  ended: Promise<void>;
  /** End stdin, stop reading, and stop the child's process group. Idempotent. */
  close: () => Promise<void>;
  isClosing: () => boolean;
};

/**
 * A short-lived NDJSON JSON-RPC child (`codex app-server`, `agy acp`) on stdio, in its own process group: requests with
 * their own deadline, notifications to `onNotification`, other output ignored. Throws if it cannot be spawned.
 */
const startRpcChild = (
  command: string[],
  env: Record<string, string>,
  onNotification?: (message: RpcMessage) => void,
): RpcChild => {
  const proc = Bun.spawn(command, {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  const stdin = proc.stdin;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const pending = new Map<
    number,
    { resolve: (message: RpcMessage) => void; reject: (error: RpcChildError) => void }
  >();
  let seq = 0;
  let ended = false;

  const send = (payload: RpcMessage) => {
    stdin.write(`${JSON.stringify(payload)}\n`);
    stdin.flush();
  };

  const endedPromise = (async () => {
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let message: RpcMessage;
          try {
            message = JSON.parse(line) as RpcMessage;
          } catch {
            continue; // non-JSON chatter
          }
          if (typeof message.id === "number" && pending.has(message.id)) {
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            waiter?.resolve(message);
          } else if (message.id === undefined && typeof message.method === "string") {
            onNotification?.(message);
          }
        }
      }
    } catch {
      // cancelled
    } finally {
      ended = true;
      for (const waiter of pending.values()) {
        waiter.reject(new RpcChildError("exited", "The process ended before answering"));
      }
      pending.clear();
    }
  })();

  let closing: Promise<void> | undefined;
  return {
    request: (method, params, timeoutMs) =>
      new Promise<RpcMessage>((resolve, reject) => {
        if (ended) {
          reject(new RpcChildError("exited", "The process has ended"));
          return;
        }
        seq += 1;
        const id = seq;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new RpcChildError("timeout", `${method} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          send({ jsonrpc: "2.0", id, method, params });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new RpcChildError("exited", "Could not write to the process"));
        }
      }),
    notify: (method, params) => {
      try {
        send({ jsonrpc: "2.0", method, params });
      } catch {
        // the process is gone; the next request says so
      }
    },
    ended: endedPromise,
    close: () => {
      closing ??= (async () => {
        try {
          stdin.end();
        } catch {
          // ignore
        }
        await reader.cancel().catch(() => {});
        await terminateProcess(proc);
      })();
      return closing;
    },
    isClosing: () => closing !== undefined,
  };
};

/** A request whose error answer, timeout or missing answer is the driver error the auth manager reports. */
const driverCall = async (
  child: RpcChild,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> => {
  let reply: RpcMessage;
  try {
    reply = await child.request(method, params, timeoutMs);
  } catch (error) {
    if (error instanceof RpcChildError && error.kind === "timeout") {
      throw new AgentAuthDriverError("timeout", `${method} timed out`);
    }
    throw new AgentAuthDriverError("process_failed", `${method} got no answer`);
  }
  if (reply.error !== undefined) {
    throw new AgentAuthDriverError("process_failed", `${method} failed`);
  }
  return reply.result;
};

/** Milliseconds left until a deadline `timeoutMs` from now (at least 1). */
const deadlineIn = (timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  return () => Math.max(1, deadline - Date.now());
};

const CODEX_CLIENT_INFO = { name: "cycle", version: "0.2" };

export type CodexAppServerProbeResult = {
  account?: unknown;
  /** `account/read`'s `requiresOpenaiAuth`: `false` when the configured provider needs no OpenAI sign-in. */
  requiresOpenaiAuth?: boolean;
  rateLimits?: RateLimitSnapshot | null;
  timedOut?: boolean;
  error?: string;
};

export type RunCodexAppServerProbe = (options: {
  executable: string;
  env: Record<string, string>;
  refreshUsage: boolean;
  timeoutMs: number;
}) => Promise<CodexAppServerProbeResult>;

/**
 * Spawn a short-lived `codex app-server` (the session's arguments, `codexAppServerArgs`), query `account/read` and
 * optionally `account/rateLimits/read`, then tear it down cleanly within `timeoutMs`.
 */
export const runCodexAppServerProbe: RunCodexAppServerProbe = async ({
  executable,
  env,
  refreshUsage,
  timeoutMs,
}) => {
  ensurePrivateDir(env.CODEX_HOME);
  let child: RpcChild;
  try {
    child = startRpcChild([executable, ...codexAppServerArgs()], env);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const left = deadlineIn(timeoutMs);

  try {
    const init = await child.request("initialize", { clientInfo: CODEX_CLIENT_INFO }, left());
    if (init.error !== undefined) return { error: "codex_init_failed" };
    child.notify("initialized", {});

    const accountResp = await child.request("account/read", { refreshToken: false }, left());
    if (accountResp.error !== undefined) return { error: "codex_account_read_failed" };
    const accountResult = accountResp.result as
      | { account?: unknown; requiresOpenaiAuth?: unknown }
      | undefined;
    const account = accountResult?.account ?? null;
    const requiresOpenaiAuth =
      typeof accountResult?.requiresOpenaiAuth === "boolean"
        ? accountResult.requiresOpenaiAuth
        : undefined;

    let rateLimits: RateLimitSnapshot | null | undefined;
    const isChatGpt =
      typeof account === "object" &&
      account !== null &&
      (account as { type?: unknown }).type === "chatgpt";
    if (refreshUsage && isChatGpt) {
      // Usage is extra: without it the account answer still stands.
      const limitsResp = await child
        .request("account/rateLimits/read", {}, left())
        .catch(() => undefined);
      if (limitsResp !== undefined && limitsResp.error === undefined) {
        const limitsResult = limitsResp.result as
          | { rateLimits?: RateLimitSnapshot | null }
          | undefined;
        rateLimits = limitsResult?.rateLimits ?? null;
      }
    }

    return {
      account,
      ...(requiresOpenaiAuth !== undefined ? { requiresOpenaiAuth } : {}),
      ...(rateLimits !== undefined ? { rateLimits } : {}),
    };
  } catch (error) {
    if (error instanceof RpcChildError) {
      return error.kind === "timeout"
        ? { timedOut: true, error: "codex_timeout" }
        : { error: "codex_exited" };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await child.close();
  }
};

export type CodexAuthStartOptions = {
  executable: string;
  env: Record<string, string>;
  mode: "browser" | "device_code";
  startTimeoutMs?: number;
  signal?: AbortSignal | undefined;
};

export type StartCodexAppServerAuth = (
  options: CodexAuthStartOptions,
) => Promise<AgentAuthFlowHandle>;

export type CodexLogoutOptions = {
  executable: string;
  env: Record<string, string>;
  timeoutMs?: number;
};

export type RunCodexAppServerLogout = (options: CodexLogoutOptions) => Promise<void>;

/**
 * Spawns a short-lived `codex app-server` to drive `account/login/start` (`chatgpt` or `chatgptDeviceCode`),
 * listens for `account/login/completed`, and tears down cleanly on completion or `cancel()`.
 * Verified against codex-cli 0.166.0 in an isolated `$CODEX_HOME` alongside a concurrent session server.
 */
export const startCodexAppServerAuth: StartCodexAppServerAuth = async ({
  executable,
  env,
  mode,
  startTimeoutMs = 15_000,
  signal,
}) => {
  ensurePrivateDir(env.CODEX_HOME);
  if (signal?.aborted === true) {
    throw new AgentAuthDriverError("cancelled", "Sign-in was cancelled before it started");
  }

  let loginId: string | undefined;
  let cancelled = false;
  let settled = false;
  let resolveCompleted!: (outcome: AgentAuthFlowOutcome) => void;
  const completed = new Promise<AgentAuthFlowOutcome>((resolve) => {
    resolveCompleted = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
  });

  let child: RpcChild;
  try {
    child = startRpcChild([executable, ...codexAppServerArgs()], env, (message) => {
      if (message.method !== "account/login/completed") return;
      if (typeof message.params !== "object" || message.params === null) return;
      const p = message.params as { loginId?: unknown; success?: unknown };
      if (loginId !== undefined && p.loginId !== undefined && p.loginId !== loginId) return;
      resolveCompleted(
        p.success === true
          ? { ok: true }
          : { ok: false, reason: cancelled ? "cancelled" : "process_failed" },
      );
      void child.close();
    });
  } catch {
    throw new AgentAuthDriverError("process_failed", "Failed to launch codex app-server");
  }
  void child.ended.then(() => {
    resolveCompleted({ ok: false, reason: cancelled ? "cancelled" : "process_failed" });
  });
  // Aborted while starting: closing the child fails the pending request, and the start rejects as cancelled.
  const onAbort = () => {
    cancelled = true;
    void child.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await driverCall(
      child,
      "initialize",
      { clientInfo: CODEX_CLIENT_INFO, capabilities: {} },
      startTimeoutMs,
    );
    child.notify("initialized", {});

    const startParams = mode === "browser" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" };
    const result = (await driverCall(child, "account/login/start", startParams, startTimeoutMs)) as
      | Record<string, unknown>
      | undefined;

    loginId = nonEmptyString(result?.loginId);
    const authorizationUrl = mode === "browser" ? nonEmptyString(result?.authUrl) : undefined;
    const verificationUrl =
      mode === "device_code" ? nonEmptyString(result?.verificationUrl) : undefined;
    const userCode = mode === "device_code" ? nonEmptyString(result?.userCode) : undefined;

    if (
      loginId === undefined ||
      (mode === "browser" && authorizationUrl === undefined) ||
      (mode === "device_code" && (verificationUrl === undefined || userCode === undefined))
    ) {
      throw new AgentAuthDriverError(
        "parse_failed",
        "Unexpected Codex account/login/start response",
      );
    }

    return {
      ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
      ...(verificationUrl !== undefined ? { verificationUrl } : {}),
      ...(userCode !== undefined ? { userCode } : {}),
      completed,
      cancel: async () => {
        cancelled = true;
        if (!child.isClosing() && loginId !== undefined) {
          await child.request("account/login/cancel", { loginId }, 1_500).catch(() => {});
        }
        await child.close();
      },
    };
  } catch (error) {
    await child.close();
    if (cancelled)
      throw new AgentAuthDriverError("cancelled", "Sign-in was cancelled before it started");
    if (error instanceof AgentAuthDriverError) throw error;
    throw new AgentAuthDriverError("process_failed", "Failed to start Codex sign-in");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

/** Runs `account/logout` against a short-lived `codex app-server` in the agent's isolated `$CODEX_HOME`. */
export const runCodexAppServerLogout: RunCodexAppServerLogout = async ({
  executable,
  env,
  timeoutMs = 10_000,
}) => {
  ensurePrivateDir(env.CODEX_HOME);
  let child: RpcChild;
  try {
    child = startRpcChild([executable, ...codexAppServerArgs()], env);
  } catch {
    throw new AgentAuthDriverError("process_failed", "Failed to launch codex app-server");
  }
  const left = deadlineIn(timeoutMs);
  try {
    await driverCall(
      child,
      "initialize",
      { clientInfo: CODEX_CLIENT_INFO, capabilities: {} },
      left(),
    );
    child.notify("initialized", {});
    await driverCall(child, "account/logout", {}, left());
  } finally {
    await child.close();
  }
};

export type CodexSetupOptions = {
  config: Config["codex"];
  dataDir: string;
  inherited: Record<string, string | undefined>;
  env: () => Record<string, string>;
  locateBinary: LocateBinary;
  runCommand?: AgentSetupRunCommand;
  probeAppServer?: RunCodexAppServerProbe;
  startAuth?: StartCodexAppServerAuth;
  logoutAppServer?: RunCodexAppServerLogout;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
};

export const createCodexSetupProvider = (options: CodexSetupOptions): AgentSetupProvider => {
  const run = options.runCommand ?? runIsolatedCommand;
  const probeAppServer = options.probeAppServer ?? runCodexAppServerProbe;
  const startAuth = options.startAuth ?? startCodexAppServerAuth;
  const logoutAppServer = options.logoutAppServer ?? runCodexAppServerLogout;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const cache = authCache(options.cacheTtlMs ?? AUTH_CACHE_TTL_MS, now);
  const minimalEnv = isolatedEnv(options.inherited, options.env);
  const probeBinary = binaryProber(options.locateBinary, minimalEnv, run);
  const viaEnv = detectViaEnv(
    CODEX_AUTH_ENV_NAMES,
    options.config.env,
    options.config.allowEnv,
    options.inherited,
  );
  const via = viaEnv !== undefined ? { viaEnv } : {};

  const requireBinary = async (): Promise<string> => {
    const binary = await probeBinary();
    if (binary.problem !== undefined || !binary.path) {
      throw new AgentAuthDriverError("binary_unavailable", "Codex binary is unavailable");
    }
    return binary.path;
  };

  const probeAuth = async (
    executable: string,
    refreshUsage: boolean,
  ): Promise<AgentAuthProbeResult> => {
    const probed = await probeAppServer({ executable, env: minimalEnv(), refreshUsage, timeoutMs });

    if (probed.timedOut) {
      return { state: "auth_unknown", unknownReason: "timeout", method: "unknown", ...via };
    }
    if (probed.error !== undefined) {
      return {
        state: "auth_unknown",
        unknownReason: NETWORK_ERROR_RE.test(probed.error) ? "network_error" : "probe_failed",
        method: "unknown",
        ...via,
      };
    }

    if (probed.account === null || probed.account === undefined) {
      // No account, and none needed: the configured model provider is not OpenAI's (config.toml `model_provider`).
      if (probed.requiresOpenaiAuth === false) {
        return { state: "signed_in", method: "third_party", ...via };
      }
      return { state: "signed_out", method: "none", ...via };
    }

    if (typeof probed.account !== "object" || Array.isArray(probed.account)) {
      return { state: "auth_unknown", unknownReason: "probe_failed", method: "unknown", ...via };
    }

    const raw = probed.account as Record<string, unknown>;
    const type = typeof raw.type === "string" ? raw.type : "";
    let method: AgentAuthMethod = "unknown";
    if (type === "chatgpt") method = "subscription";
    else if (type === "apiKey") method = "api_key";
    else if (type === "amazonBedrock" || type === "gcp") method = "third_party";

    const email = nonEmptyString(raw.email);
    const plan = nonEmptyString(raw.planType);
    const organization = nonEmptyString(raw.workspaceName);
    const account: AgentAccountInfo = {
      ...(email !== undefined ? { email } : {}),
      ...(organization !== undefined ? { organization } : {}),
      ...(plan !== undefined ? { plan } : {}),
    };

    const windows = probed.rateLimits ? planWindowsOf(probed.rateLimits) : [];
    const planUsage: PlanUsage | undefined =
      windows.length > 0 ? { windows, at: now() } : undefined;

    return {
      state: "signed_in",
      method,
      ...via,
      ...(Object.keys(account).length > 0 ? { account } : {}),
      ...(planUsage !== undefined ? { planUsage } : {}),
    };
  };

  const readAuth: AgentSetupProvider["readAuth"] = async (opts) => {
    const binary = await probeBinary(opts?.forceRefresh === true ? { forceRefresh: true } : {});
    if (binary.problem !== undefined || !binary.path) {
      cache.invalidate();
      return { state: "binary_unavailable", method: "none", ...via };
    }
    const executable = binary.path;
    return cache.read(opts, () => probeAuth(executable, opts?.refreshUsage === true));
  };

  return {
    probeBinary,
    readAuth,
    signInModes: () => [
      { mode: "browser", requiresLocalLoopback: true },
      { mode: "device_code", requiresLocalLoopback: false },
    ],
    canSignOut: () => true,
    canRefreshUsage: true,
    loginCommand: loginCommandFor("codex", options.dataDir),
    authDriver: {
      start: async (mode, signal) => {
        if (mode !== "browser" && mode !== "device_code") {
          throw new AgentAuthDriverError("process_failed", `Unsupported Codex auth mode: ${mode}`);
        }
        return startAuth({
          executable: await requireBinary(),
          env: minimalEnv(),
          mode,
          startTimeoutMs: timeoutMs,
          signal,
        });
      },
      logout: async () => {
        const executable = await requireBinary();
        try {
          await logoutAppServer({ executable, env: minimalEnv(), timeoutMs });
        } finally {
          cache.invalidate();
        }
      },
      invalidateCache: cache.invalidate,
    },
    diagnostics: () => ({
      ...dataDirDiagnostics(options.env().CODEX_HOME, join(options.dataDir, "codex")),
      allowEnv: [...options.config.allowEnv],
      envNames: Object.keys(options.config.env).sort(),
    }),
    runtimeSchema: {},
    runtimeSnapshot: (settings) => {
      const fileError = settings?.fileError();
      return {
        schemaVersion: 1,
        schema: { type: "object", properties: {} },
        values: {},
        overrides: [],
        revision: settings?.revisionOf("codex") ?? 0,
        ...(fileError !== undefined ? { fileError } : {}),
      };
    },
  };
};

const AGY_SIGNED_OUT_RE =
  /please sign in|not signed in|sign in to view|unauthenticated|login required/i;

export type AgyLogoutOptions = {
  executable: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** Extra `agy acp` flags (e.g. `--disable-telemetry`), the same the sessions get. */
  args?: readonly string[];
};

export type RunAgyAcpLogout = (options: AgyLogoutOptions) => Promise<void>;

/**
 * Signs out of Antigravity strictly through `agy acp`'s native `logout` JSON-RPC method.
 * Hard red line: Cycle never reads, parses, stores, or deletes agy's OAuth token files directly.
 */
export const runAgyAcpLogout: RunAgyAcpLogout = async ({
  executable,
  env,
  timeoutMs = 15_000,
  args = [],
}) => {
  ensurePrivateDir(env.HOME);
  let child: RpcChild;
  try {
    child = startRpcChild([executable, "acp", ...args], env);
  } catch {
    throw new AgentAuthDriverError("process_failed", "Failed to launch agy acp");
  }
  const left = deadlineIn(timeoutMs);
  try {
    await driverCall(
      child,
      "initialize",
      { protocolVersion: 1, clientInfo: CODEX_CLIENT_INFO, clientCapabilities: {} },
      left(),
    );
    await driverCall(child, "logout", {}, left());
  } finally {
    await child.close();
  }
};

/** The `agy acp` flags a session gets from the effective runtime settings that sign-in and sign-out must share. */
export const agyAcpFlags = (config: Config["agy"], settings?: AgentSettings): string[] =>
  agyEffectiveRuntime(config, settings).values.telemetry === false ? ["--disable-telemetry"] : [];

export type AgySetupOptions = {
  config: Config["agy"];
  dataDir: string;
  inherited: Record<string, string | undefined>;
  env: () => Record<string, string>;
  locateBinary: LocateBinary;
  /** The daemon's runtime settings (`agent-settings.json`), so setup subprocesses honour e.g. telemetry off. */
  agentSettings?: AgentSettings | undefined;
  runCommand?: AgentSetupRunCommand;
  startCodeAuth?: StartCliCodeAuth;
  logoutAcp?: RunAgyAcpLogout;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
};

export const createAgySetupProvider = (options: AgySetupOptions): AgentSetupProvider => {
  const run = options.runCommand ?? runIsolatedCommand;
  const startCodeAuth = options.startCodeAuth ?? startCliCodeAuth;
  const logoutAcp = options.logoutAcp ?? runAgyAcpLogout;
  // Probed at ~1.5s on isolated HOME when signed out, up to ~5s+ on keychain-fallback platforms.
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cache = authCache(options.cacheTtlMs ?? 45_000, options.now ?? Date.now);
  const minimalEnv = isolatedEnv(options.inherited, options.env);
  const probeBinary = binaryProber(options.locateBinary, minimalEnv, run, AGY_MIN_VERSION);
  const acpFlags = () => agyAcpFlags(options.config, options.agentSettings);
  const viaEnv = detectViaEnv(
    AGY_AUTH_ENV_NAMES,
    options.config.env,
    options.config.allowEnv,
    options.inherited,
  );
  const via = viaEnv !== undefined ? { viaEnv } : {};

  const requireBinary = async (): Promise<string> => {
    const binary = await probeBinary();
    if (binary.problem !== undefined || !binary.path) {
      throw new AgentAuthDriverError("binary_unavailable", "agy binary is unavailable");
    }
    return binary.path;
  };

  const probeAuth = async (executable: string): Promise<AgentAuthProbeResult> => {
    const env = minimalEnv();
    ensurePrivateDir(env.HOME);
    // Hard red line: never read, stat, parse, or touch agy's OAuth token files; probe only via `agy models`
    // (which takes no `--disable-telemetry`: that flag is `agy acp`'s).
    const result = await run([executable, "models"], { env, timeoutMs });
    if (result.timedOut) {
      return { state: "auth_unknown", unknownReason: "timeout", method: "unknown", ...via };
    }
    if (result.exitCode === 0) {
      // An API key from config.json is what answered, not a Google sign-in.
      return {
        state: "signed_in",
        method: viaEnv !== undefined ? "api_key" : "subscription",
        ...via,
      };
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    if (AGY_SIGNED_OUT_RE.test(combined)) return { state: "signed_out", method: "none", ...via };
    return {
      state: "auth_unknown",
      unknownReason: NETWORK_ERROR_RE.test(combined) ? "network_error" : "probe_failed",
      method: "unknown",
      ...via,
    };
  };

  const readAuth: AgentSetupProvider["readAuth"] = async (opts) => {
    const binary = await probeBinary(opts?.forceRefresh === true ? { forceRefresh: true } : {});
    if (binary.problem !== undefined || !binary.path) {
      cache.invalidate();
      return { state: "binary_unavailable", method: "none", ...via };
    }
    const executable = binary.path;
    return cache.read(opts, () => probeAuth(executable));
  };

  return {
    probeBinary,
    readAuth,
    signInModes: () => [{ mode: "code", requiresLocalLoopback: false }],
    canSignOut: () => true,
    canRefreshUsage: false,
    loginCommand: loginCommandFor("agy", options.dataDir),
    authDriver: {
      start: async (mode, signal) => {
        if (mode !== "code") {
          throw new AgentAuthDriverError("process_failed", `Unsupported agy auth mode: ${mode}`);
        }
        const executable = await requireBinary();
        const env = minimalEnv();
        ensurePrivateDir(env.HOME);
        // Hard red line: drive ONLY `agy acp --login`; never touch token files directly.
        return startCodeAuth({
          command: [executable, "acp", "--login", ...acpFlags()],
          env,
          urlPattern: AGY_AUTH_URL_RE,
          startTimeoutMs: Math.max(timeoutMs, 15_000),
          signal,
        });
      },
      logout: async () => {
        const executable = await requireBinary();
        try {
          await logoutAcp({ executable, env: minimalEnv(), timeoutMs, args: acpFlags() });
        } finally {
          cache.invalidate();
        }
      },
      invalidateCache: cache.invalidate,
    },
    diagnostics: () => ({
      ...dataDirDiagnostics(options.env().HOME, join(options.dataDir, "agy")),
      allowEnv: [...options.config.allowEnv],
      envNames: Object.keys(options.config.env).sort(),
    }),
    runtimeSchema: AGY_RUNTIME_SCHEMA,
    runtimeSnapshot: (settings) => {
      const merged = agyEffectiveRuntime(options.config, settings);
      const fileError = settings?.fileError();
      return {
        schemaVersion: 1,
        schema: { type: "object", properties: AGY_RUNTIME_SCHEMA },
        values: merged.values,
        overrides: merged.overrides,
        revision: merged.revision,
        ...(fileError !== undefined ? { fileError } : {}),
      };
    },
  };
};
