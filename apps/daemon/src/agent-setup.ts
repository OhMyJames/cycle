import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGY_MIN_VERSION, isVersionSupported } from "@cycle/harness-agy";
import { CODEX_FIXED_ARGS, planWindowsOf, type RateLimitSnapshot } from "@cycle/harness-codex";
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
  start: (mode: AgentAuthMode) => Promise<AgentAuthFlowHandle>;
  logout?: () => Promise<void>;
  /** Clear any short-TTL in-memory auth probe cache (e.g. agy 45s cache). */
  invalidateCache?: () => void;
};

export type AgentSetupProvider = {
  probeBinary: () => Promise<AgentBinaryStatus> | AgentBinaryStatus;
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

/** Gracefully stops a child process via `SIGTERM`, escalating to `SIGKILL` after `graceMs`, and awaits exit. */
const terminateProcess = async (
  proc: ReturnType<typeof Bun.spawn>,
  graceMs = 500,
): Promise<void> => {
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const grace = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, graceMs);
  await proc.exited.catch(() => {});
  clearTimeout(grace);
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Run a subprocess with an explicit isolated environment (never inherits `process.env`) and a hard timeout. */
export const runIsolatedCommand: AgentSetupRunCommand = async (command, { env, timeoutMs }) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
    forceKillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, 500);
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(forceKillTimer);
  }
};

const extractVersion = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const semver = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(trimmed);
  if (semver?.[1]) return semver[1];
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
  return firstLine || undefined;
};

const binaryVersionCache = new Map<string, string | null>();

const probeVersion = async (
  executable: string,
  env: Record<string, string>,
  run: AgentSetupRunCommand,
): Promise<string | undefined> => {
  let cacheKey: string | undefined;
  try {
    const st = statSync(executable);
    cacheKey = `${executable}:${st.mtimeMs}:${st.size}`;
    const cached = binaryVersionCache.get(cacheKey);
    if (cached !== undefined) return cached ?? undefined;
  } catch {
    return undefined;
  }
  const result = await run([executable, "--version"], { env, timeoutMs: 3000 });
  const version =
    !result.timedOut && result.exitCode === 0
      ? (extractVersion(result.stdout) ?? extractVersion(result.stderr))
      : undefined;
  if (cacheKey !== undefined) binaryVersionCache.set(cacheKey, version ?? null);
  return version;
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
  locateBinary: () => { source: AgentBinarySource; path?: string };
  runCommand?: AgentSetupRunCommand;
  startCodeAuth?: StartCliCodeAuth;
  timeoutMs?: number;
};

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export const CLAUDE_AUTH_URL_RE =
  /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com)\/[^\s"'<>]+/;

export const AGY_AUTH_URL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/;

const INVALID_CODE_RE =
  /invalid[_ -]?code|invalid[_ -]?grant|incorrect code|expired code|code.*(?:invalid|expired|rejected)/i;

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
}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      env: { ...env, BROWSER: noopBrowser() },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
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
        const reason = INVALID_CODE_RE.test(combined) ? "invalid_code" : "process_failed";
        resolveCompleted({ ok: false, reason });
      }
    }
  });

  const startTimer = setTimeout(() => {
    rejectUrl(new AgentAuthDriverError("timeout", "Timed out waiting for authorization URL"));
  }, startTimeoutMs);

  let authorizationUrl: string;
  try {
    authorizationUrl = await urlPromise;
  } catch (error) {
    clearTimeout(startTimer);
    await killProc();
    throw error;
  } finally {
    clearTimeout(startTimer);
  }

  return {
    authorizationUrl,
    completed,
    submit: async (code: string): Promise<AgentAuthFlowOutcome> => {
      if (settled) return { ok: false, reason: "process_failed" };
      try {
        stdin.write(`${code.trim()}\n`);
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
  const minimalEnv = (): Record<string, string> => ({
    PATH: options.inherited.PATH ?? "/usr/bin:/bin",
    ...options.env(),
  });

  const probeBinary = async (): Promise<AgentBinaryStatus> => {
    const found = options.locateBinary();
    if (found.source === "missing" || !found.path || !isExecutable(found.path)) {
      return { source: "missing", problem: "missing" };
    }
    const version = await probeVersion(found.path, minimalEnv(), run);
    return {
      source: found.source,
      path: found.path,
      ...(version !== undefined ? { version } : {}),
    };
  };

  const readAuth: AgentSetupProvider["readAuth"] = async () => {
    const viaEnv = detectViaEnv(
      CLAUDE_AUTH_ENV_NAMES,
      options.config.env,
      options.config.allowEnv,
      options.inherited,
    );
    const binary = await probeBinary();
    if (binary.problem !== undefined || !binary.path) {
      return {
        state: "binary_unavailable",
        method: "none",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }

    const env = minimalEnv();
    if (env.CLAUDE_CONFIG_DIR) {
      try {
        mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
      } catch {
        // best effort; let claude report if unwritable
      }
    }

    const result = await run([binary.path, "auth", "status", "--json"], { env, timeoutMs });
    if (result.timedOut) {
      return {
        state: "auth_unknown",
        unknownReason: "timeout",
        method: "unknown",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
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
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }

    if (!parsed.loggedIn) {
      return {
        state: "signed_out",
        method: "none",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }

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
      ...(viaEnv !== undefined ? { viaEnv } : {}),
      ...(Object.keys(account).length > 0 ? { account } : {}),
    };
  };

  return {
    probeBinary,
    readAuth,
    signInModes: () => [{ mode: "code", requiresLocalLoopback: false }],
    canSignOut: () => true,
    canRefreshUsage: false,
    loginCommand: "cycle login claude",
    authDriver: {
      start: async (mode) => {
        if (mode !== "code") {
          throw new AgentAuthDriverError("process_failed", `Unsupported Claude auth mode: ${mode}`);
        }
        const binary = await probeBinary();
        if (binary.problem !== undefined || !binary.path) {
          throw new AgentAuthDriverError("binary_unavailable", "Claude binary is unavailable");
        }
        const env = minimalEnv();
        if (env.CLAUDE_CONFIG_DIR) {
          try {
            mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
          } catch {
            // let claude report if unwritable
          }
        }
        return startCodeAuth({
          command: [binary.path, "auth", "login", "--claudeai"],
          env,
          urlPattern: CLAUDE_AUTH_URL_RE,
          startTimeoutMs: Math.max(timeoutMs, 15_000),
        });
      },
      logout: async () => {
        const binary = await probeBinary();
        if (binary.problem !== undefined || !binary.path) {
          throw new AgentAuthDriverError("binary_unavailable", "Claude binary is unavailable");
        }
        const env = minimalEnv();
        if (env.CLAUDE_CONFIG_DIR) {
          try {
            mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
          } catch {
            // ignore
          }
        }
        const result = await run([binary.path, "auth", "logout"], { env, timeoutMs });
        if (result.timedOut) {
          throw new AgentAuthDriverError("timeout", "Claude logout timed out");
        }
        if (result.exitCode !== 0) {
          throw new AgentAuthDriverError("process_failed", "Claude logout failed");
        }
      },
    },
    diagnostics: () => ({
      dataDir: options.config.configDir ?? join(options.dataDir, "claude"),
      customDataDir: options.config.configDir !== undefined,
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

export type CodexAppServerProbeResult = {
  account?: unknown;
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
 * Spawn a short-lived `codex -c cli_auth_credentials_store="file" app-server`, query `account/read`
 * and optionally `account/rateLimits/read`, then tear it down cleanly within `timeoutMs`.
 */
export const runCodexAppServerProbe: RunCodexAppServerProbe = async ({
  executable,
  env,
  refreshUsage,
  timeoutMs,
}) => {
  if (env.CODEX_HOME) {
    try {
      mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
    } catch {
      // best effort
    }
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([executable, ...CODEX_FIXED_ARGS, "app-server"], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const stdin = proc.stdin as Bun.FileSink;
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
    void terminateProcess(proc);
  }, timeoutMs);

  const send = (payload: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify(payload)}\n`);
    stdin.flush();
  };

  const waitForId = async (targetId: number): Promise<Record<string, unknown> | undefined> => {
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === targetId) return msg;
        } catch {
          // ignore non-JSON chatter
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "cycle", version: "0.2" } },
    });
    const init = await waitForId(1);
    if (!init || init.error) {
      return { timedOut, error: "codex_init_failed" };
    }
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "account/read",
      params: { refreshToken: false },
    });
    const accountResp = await waitForId(2);
    if (!accountResp || accountResp.error) {
      return { timedOut, error: "codex_account_read_failed" };
    }
    const accountResult = accountResp.result as { account?: unknown } | undefined;
    const account = accountResult?.account ?? null;

    let rateLimits: RateLimitSnapshot | null | undefined;
    const isChatGpt =
      typeof account === "object" &&
      account !== null &&
      (account as { type?: unknown }).type === "chatgpt";
    if (refreshUsage && isChatGpt) {
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "account/rateLimits/read",
        params: {},
      });
      const limitsResp = await waitForId(3);
      if (limitsResp && !limitsResp.error) {
        const limitsResult = limitsResp.result as
          | { rateLimits?: RateLimitSnapshot | null }
          | undefined;
        rateLimits = limitsResult?.rateLimits ?? null;
      }
    }

    return { account, ...(rateLimits !== undefined ? { rateLimits } : {}) };
  } catch (error) {
    return { timedOut, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    try {
      stdin.end();
    } catch {
      // ignore
    }
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    await terminateProcess(proc);
  }
};

export type CodexAuthStartOptions = {
  executable: string;
  env: Record<string, string>;
  mode: "browser" | "device_code";
  startTimeoutMs?: number;
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
}) => {
  if (env.CODEX_HOME) {
    try {
      mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
    } catch {
      // let codex report its own error
    }
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([executable, "app-server", ...CODEX_FIXED_ARGS], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    throw new AgentAuthDriverError("process_failed", "Failed to launch codex app-server");
  }

  const stdin = proc.stdin as Bun.FileSink;
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();

  let seq = 1;
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: unknown) => void }
  >();
  let loginId: string | undefined;
  let cancelled = false;
  let resolveCompleted!: (outcome: AgentAuthFlowOutcome) => void;
  let settled = false;
  const completed = new Promise<AgentAuthFlowOutcome>((resolve) => {
    resolveCompleted = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
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
        await reader.cancel();
      } catch {
        // ignore
      }
      await terminateProcess(proc);
    })();
    return killPromise;
  };

  const send = (payload: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify(payload)}\n`);
    stdin.flush();
  };

  const request = (method: string, params: unknown, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = seq++;
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new AgentAuthDriverError("timeout", `Codex ${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });

  // Background NDJSON reader loop for both request responses and `account/login/completed`.
  void (async () => {
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
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            const waiter = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error !== undefined) {
              waiter?.reject(new AgentAuthDriverError("process_failed", "Codex RPC error"));
            } else {
              waiter?.resolve(msg.result);
            }
            continue;
          }
          if (
            msg.method === "account/login/completed" &&
            typeof msg.params === "object" &&
            msg.params !== null
          ) {
            const p = msg.params as { loginId?: unknown; success?: unknown };
            if (loginId !== undefined && p.loginId !== undefined && p.loginId !== loginId) continue;
            const ok = p.success === true;
            resolveCompleted(
              ok ? { ok: true } : { ok: false, reason: cancelled ? "cancelled" : "process_failed" },
            );
            void killProc();
          }
        }
      }
    } catch {
      // stream cancelled or closed
    } finally {
      for (const [, waiter] of pending) {
        waiter.reject(new AgentAuthDriverError("process_failed", "Codex app-server exited"));
      }
      pending.clear();
      if (!settled) {
        resolveCompleted({ ok: false, reason: cancelled ? "cancelled" : "process_failed" });
      }
    }
  })();

  try {
    await request(
      "initialize",
      { clientInfo: { name: "cycle", version: "0.2" }, capabilities: {} },
      startTimeoutMs,
    );
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    const startParams = mode === "browser" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" };
    const result = (await request("account/login/start", startParams, startTimeoutMs)) as
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
        if (killPromise === undefined && loginId !== undefined) {
          await request("account/login/cancel", { loginId }, 1_500).catch(() => {});
        }
        await killProc();
      },
    };
  } catch (error) {
    await killProc();
    if (error instanceof AgentAuthDriverError) throw error;
    throw new AgentAuthDriverError("process_failed", "Failed to start Codex sign-in");
  }
};

/** Runs `account/logout` against a short-lived `codex app-server` in the agent's isolated `$CODEX_HOME`. */
export const runCodexAppServerLogout: RunCodexAppServerLogout = async ({
  executable,
  env,
  timeoutMs = 10_000,
}) => {
  if (env.CODEX_HOME) {
    try {
      mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
    } catch {
      // ignore
    }
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([executable, "app-server", ...CODEX_FIXED_ARGS], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    throw new AgentAuthDriverError("process_failed", "Failed to launch codex app-server");
  }

  const stdin = proc.stdin as Bun.FileSink;
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
    void terminateProcess(proc);
  }, timeoutMs);

  const send = (payload: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify(payload)}\n`);
    stdin.flush();
  };

  const waitForId = async (targetId: number): Promise<Record<string, unknown> | undefined> => {
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === targetId) return msg;
        } catch {
          // ignore
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "cycle", version: "0.2" }, capabilities: {} },
    });
    const init = await waitForId(1);
    if (!init || init.error) {
      throw new AgentAuthDriverError(timedOut ? "timeout" : "process_failed");
    }
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    send({ jsonrpc: "2.0", id: 2, method: "account/logout", params: {} });
    const resp = await waitForId(2);
    if (!resp || resp.error) {
      throw new AgentAuthDriverError(timedOut ? "timeout" : "process_failed");
    }
  } finally {
    clearTimeout(timer);
    try {
      stdin.end();
    } catch {
      // ignore
    }
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    await terminateProcess(proc);
  }
};

export type CodexSetupOptions = {
  config: Config["codex"];
  dataDir: string;
  inherited: Record<string, string | undefined>;
  env: () => Record<string, string>;
  locateBinary: () => { source: AgentBinarySource; path?: string };
  runCommand?: AgentSetupRunCommand;
  probeAppServer?: RunCodexAppServerProbe;
  startAuth?: StartCodexAppServerAuth;
  logoutAppServer?: RunCodexAppServerLogout;
  timeoutMs?: number;
  now?: () => number;
};

export const createCodexSetupProvider = (options: CodexSetupOptions): AgentSetupProvider => {
  const run = options.runCommand ?? runIsolatedCommand;
  const probeAppServer = options.probeAppServer ?? runCodexAppServerProbe;
  const startAuth = options.startAuth ?? startCodexAppServerAuth;
  const logoutAppServer = options.logoutAppServer ?? runCodexAppServerLogout;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const minimalEnv = (): Record<string, string> => ({
    PATH: options.inherited.PATH ?? "/usr/bin:/bin",
    ...options.env(),
  });

  const probeBinary = async (): Promise<AgentBinaryStatus> => {
    const found = options.locateBinary();
    if (found.source === "missing" || !found.path || !isExecutable(found.path)) {
      return { source: "missing", problem: "missing" };
    }
    const version = await probeVersion(found.path, minimalEnv(), run);
    return {
      source: found.source,
      path: found.path,
      ...(version !== undefined ? { version } : {}),
    };
  };

  const readAuth: AgentSetupProvider["readAuth"] = async (opts) => {
    const viaEnv = detectViaEnv(
      CODEX_AUTH_ENV_NAMES,
      options.config.env,
      options.config.allowEnv,
      options.inherited,
    );
    const binary = await probeBinary();
    if (binary.problem !== undefined || !binary.path) {
      return {
        state: "binary_unavailable",
        method: "none",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }

    const probed = await probeAppServer({
      executable: binary.path,
      env: minimalEnv(),
      refreshUsage: opts?.refreshUsage === true,
      timeoutMs,
    });

    if (probed.timedOut) {
      return {
        state: "auth_unknown",
        unknownReason: "timeout",
        method: "unknown",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }
    if (probed.error !== undefined) {
      return {
        state: "auth_unknown",
        unknownReason: NETWORK_ERROR_RE.test(probed.error) ? "network_error" : "probe_failed",
        method: "unknown",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }

    if (probed.account === null || probed.account === undefined) {
      return {
        state: "signed_out",
        method: "none",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }

    if (typeof probed.account !== "object" || Array.isArray(probed.account)) {
      return {
        state: "auth_unknown",
        unknownReason: "probe_failed",
        method: "unknown",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
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
      ...(viaEnv !== undefined ? { viaEnv } : {}),
      ...(Object.keys(account).length > 0 ? { account } : {}),
      ...(planUsage !== undefined ? { planUsage } : {}),
    };
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
    loginCommand: "cycle login codex",
    authDriver: {
      start: async (mode) => {
        if (mode !== "browser" && mode !== "device_code") {
          throw new AgentAuthDriverError("process_failed", `Unsupported Codex auth mode: ${mode}`);
        }
        const binary = await probeBinary();
        if (binary.problem !== undefined || !binary.path) {
          throw new AgentAuthDriverError("binary_unavailable", "Codex binary is unavailable");
        }
        return startAuth({
          executable: binary.path,
          env: minimalEnv(),
          mode,
          startTimeoutMs: timeoutMs,
        });
      },
      logout: async () => {
        const binary = await probeBinary();
        if (binary.problem !== undefined || !binary.path) {
          throw new AgentAuthDriverError("binary_unavailable", "Codex binary is unavailable");
        }
        await logoutAppServer({
          executable: binary.path,
          env: minimalEnv(),
          timeoutMs,
        });
      },
    },
    diagnostics: () => ({
      dataDir: options.config.configDir ?? join(options.dataDir, "codex"),
      customDataDir: options.config.configDir !== undefined,
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
};

export type RunAgyAcpLogout = (options: AgyLogoutOptions) => Promise<void>;

/**
 * Signs out of Antigravity strictly through `agy acp`'s native `logout` JSON-RPC method.
 * Hard red line: Cycle never reads, parses, stores, or deletes agy's OAuth token files directly.
 */
export const runAgyAcpLogout: RunAgyAcpLogout = async ({ executable, env, timeoutMs = 15_000 }) => {
  if (env.HOME) {
    try {
      mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
    } catch {
      // ignore
    }
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([executable, "acp"], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    throw new AgentAuthDriverError("process_failed", "Failed to launch agy acp");
  }

  const stdin = proc.stdin as Bun.FileSink;
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
    void terminateProcess(proc);
  }, timeoutMs);

  const send = (payload: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify(payload)}\n`);
    stdin.flush();
  };

  const waitForId = async (targetId: number): Promise<Record<string, unknown> | undefined> => {
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === targetId) return msg;
        } catch {
          // ignore non-JSON chatter
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "cycle", version: "0.2" },
        clientCapabilities: {},
      },
    });
    const init = await waitForId(1);
    if (!init || init.error) {
      throw new AgentAuthDriverError(timedOut ? "timeout" : "process_failed");
    }

    send({ jsonrpc: "2.0", id: 2, method: "logout", params: {} });
    const resp = await waitForId(2);
    if (!resp || resp.error) {
      throw new AgentAuthDriverError(timedOut ? "timeout" : "process_failed");
    }
  } finally {
    clearTimeout(timer);
    try {
      stdin.end();
    } catch {
      // ignore
    }
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    await terminateProcess(proc);
  }
};

export type AgySetupOptions = {
  config: Config["agy"];
  dataDir: string;
  inherited: Record<string, string | undefined>;
  env: () => Record<string, string>;
  locateBinary: () => { source: AgentBinarySource; path?: string };
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
  const cacheTtlMs = options.cacheTtlMs ?? 45_000;
  const now = options.now ?? Date.now;

  let cachedAuth: { at: number; result: AgentAuthProbeResult } | undefined;
  let cacheGen = 0;

  const minimalEnv = (): Record<string, string> => ({
    PATH: options.inherited.PATH ?? "/usr/bin:/bin",
    ...options.env(),
  });

  const probeBinary = async (): Promise<AgentBinaryStatus> => {
    const found = options.locateBinary();
    if (found.source === "missing" || !found.path || !isExecutable(found.path)) {
      return { source: "missing", minVersion: AGY_MIN_VERSION, problem: "missing" };
    }
    const version = await probeVersion(found.path, minimalEnv(), run);
    if (version === undefined) {
      return {
        source: found.source,
        path: found.path,
        minVersion: AGY_MIN_VERSION,
        problem: "probe_failed",
      };
    }
    if (!isVersionSupported(version, AGY_MIN_VERSION)) {
      return {
        source: found.source,
        path: found.path,
        version,
        minVersion: AGY_MIN_VERSION,
        problem: "version_too_old",
      };
    }
    return {
      source: found.source,
      path: found.path,
      version,
      minVersion: AGY_MIN_VERSION,
    };
  };

  const readAuth: AgentSetupProvider["readAuth"] = async (opts) => {
    const viaEnv = detectViaEnv(
      AGY_AUTH_ENV_NAMES,
      options.config.env,
      options.config.allowEnv,
      options.inherited,
    );
    const binary = await probeBinary();
    if (binary.problem !== undefined || !binary.path) {
      cachedAuth = undefined;
      return {
        state: "binary_unavailable",
        method: "none",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }

    if (!opts?.forceRefresh && cachedAuth !== undefined && now() - cachedAuth.at < cacheTtlMs) {
      return {
        ...cachedAuth.result,
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    }

    const env = minimalEnv();
    if (env.HOME) {
      try {
        mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
      } catch {
        // best effort
      }
    }

    // Hard red line: never read, stat, parse, or touch agy's OAuth token files; probe only via `agy models`.
    const probeGen = cacheGen;
    const result = await run([binary.path, "models"], { env, timeoutMs });
    let authResult: AgentAuthProbeResult;
    if (result.timedOut) {
      authResult = {
        state: "auth_unknown",
        unknownReason: "timeout",
        method: "unknown",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    } else if (result.exitCode === 0) {
      authResult = {
        state: "signed_in",
        method: "subscription",
        ...(viaEnv !== undefined ? { viaEnv } : {}),
      };
    } else {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (AGY_SIGNED_OUT_RE.test(combined)) {
        authResult = {
          state: "signed_out",
          method: "none",
          ...(viaEnv !== undefined ? { viaEnv } : {}),
        };
      } else if (NETWORK_ERROR_RE.test(combined)) {
        authResult = {
          state: "auth_unknown",
          unknownReason: "network_error",
          method: "unknown",
          ...(viaEnv !== undefined ? { viaEnv } : {}),
        };
      } else {
        authResult = {
          state: "auth_unknown",
          unknownReason: "probe_failed",
          method: "unknown",
          ...(viaEnv !== undefined ? { viaEnv } : {}),
        };
      }
    }

    // Cache only definitive states if no login/logout invalidated the cache while this probe was in flight.
    if (probeGen === cacheGen) {
      if (authResult.state === "signed_in" || authResult.state === "signed_out") {
        cachedAuth = { at: now(), result: authResult };
      } else {
        cachedAuth = undefined;
      }
    }

    return authResult;
  };

  return {
    probeBinary,
    readAuth,
    signInModes: () => [{ mode: "code", requiresLocalLoopback: false }],
    canSignOut: () => true,
    canRefreshUsage: false,
    loginCommand: "cycle login agy",
    authDriver: {
      start: async (mode) => {
        if (mode !== "code") {
          throw new AgentAuthDriverError("process_failed", `Unsupported agy auth mode: ${mode}`);
        }
        const binary = await probeBinary();
        if (binary.problem !== undefined || !binary.path) {
          throw new AgentAuthDriverError("binary_unavailable", "agy binary is unavailable");
        }
        const env = minimalEnv();
        if (env.HOME) {
          try {
            mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
          } catch {
            // ignore
          }
        }
        // Hard red line: drive ONLY `agy acp --login`; never touch token files directly.
        return startCodeAuth({
          command: [binary.path, "acp", "--login"],
          env,
          urlPattern: AGY_AUTH_URL_RE,
          startTimeoutMs: Math.max(timeoutMs, 15_000),
        });
      },
      logout: async () => {
        const binary = await probeBinary();
        if (binary.problem !== undefined || !binary.path) {
          throw new AgentAuthDriverError("binary_unavailable", "agy binary is unavailable");
        }
        await logoutAcp({
          executable: binary.path,
          env: minimalEnv(),
          timeoutMs,
        });
        cacheGen += 1;
        cachedAuth = undefined;
      },
      invalidateCache: () => {
        cacheGen += 1;
        cachedAuth = undefined;
      },
    },
    diagnostics: () => ({
      dataDir: options.config.home ?? join(options.dataDir, "agy"),
      customDataDir: options.config.home !== undefined,
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
