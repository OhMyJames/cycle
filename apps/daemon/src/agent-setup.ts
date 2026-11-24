import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGY_MIN_VERSION, isVersionSupported } from "@cycle/harness-agy";
import { CODEX_FIXED_ARGS, planWindowsOf, type RateLimitSnapshot } from "@cycle/harness-codex";
import type {
  AgentAccountInfo,
  AgentAuthMethod,
  AgentAuthState,
  AgentAuthUnknownReason,
  AgentBinarySource,
  AgentBinaryStatus,
  AgentConfigFileStatus,
  AgentRuntimeSnapshot,
  AgentSignInMode,
  PlanUsage,
} from "@cycle/protocol";
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
  runtimeSnapshot: () => AgentRuntimeSnapshot;
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
 * Inspect `config.json` strictly read-only: whether it exists, whether its mtime changed since startup (`stale`),
 * and whether its current contents fail JSON/schema validation. Never returns any env values.
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

  let error = options.startupError;
  if (exists) {
    try {
      ConfigSchema.parse(JSON.parse(readFileSync(options.path, "utf8")));
      error = undefined;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    path: options.path,
    exists,
    stale,
    ...(error !== undefined ? { error } : {}),
  };
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
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already exited
    }
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
  timeoutMs?: number;
};

export const createClaudeSetupProvider = (options: ClaudeSetupOptions): AgentSetupProvider => {
  const run = options.runCommand ?? runIsolatedCommand;
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
    signInModes: () => [],
    canSignOut: () => false,
    canRefreshUsage: false,
    loginCommand: "cycle login claude",
    diagnostics: () => ({
      dataDir: options.config.configDir ?? join(options.dataDir, "claude"),
      customDataDir: options.config.configDir !== undefined,
      allowEnv: [...options.config.allowEnv],
      envNames: Object.keys(options.config.env).sort(),
    }),
    runtimeSnapshot: () => ({
      schemaVersion: 1,
      schema: { type: "object", properties: {} },
      values: {
        warmStart: options.config.warmStart,
        maxWarm: options.config.maxWarm,
        progressSummaries: options.config.progressSummaries,
      },
      overrides: [],
      revision: 0,
    }),
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
      stderr: "pipe",
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
    try {
      proc.kill();
    } catch {
      // already exited
    }
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
    try {
      proc.kill();
    } catch {
      // already exited
    }
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
  timeoutMs?: number;
  now?: () => number;
};

export const createCodexSetupProvider = (options: CodexSetupOptions): AgentSetupProvider => {
  const run = options.runCommand ?? runIsolatedCommand;
  const probeAppServer = options.probeAppServer ?? runCodexAppServerProbe;
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
    signInModes: () => [],
    canSignOut: () => false,
    canRefreshUsage: true,
    loginCommand: "cycle login codex",
    diagnostics: () => ({
      dataDir: options.config.configDir ?? join(options.dataDir, "codex"),
      customDataDir: options.config.configDir !== undefined,
      allowEnv: [...options.config.allowEnv],
      envNames: Object.keys(options.config.env).sort(),
    }),
    runtimeSnapshot: () => ({
      schemaVersion: 1,
      schema: { type: "object", properties: {} },
      values: {},
      overrides: [],
      revision: 0,
    }),
  };
};

const AGY_SIGNED_OUT_RE =
  /please sign in|not signed in|sign in to view|unauthenticated|login required/i;

export type AgySetupOptions = {
  config: Config["agy"];
  dataDir: string;
  inherited: Record<string, string | undefined>;
  env: () => Record<string, string>;
  locateBinary: () => { source: AgentBinarySource; path?: string };
  runCommand?: AgentSetupRunCommand;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
};

export const createAgySetupProvider = (options: AgySetupOptions): AgentSetupProvider => {
  const run = options.runCommand ?? runIsolatedCommand;
  // Probed at ~1.5s on isolated HOME when signed out, up to ~5s+ on keychain-fallback platforms.
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cacheTtlMs = options.cacheTtlMs ?? 45_000;
  const now = options.now ?? Date.now;

  let cachedAuth: { at: number; result: AgentAuthProbeResult } | undefined;

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

    // Cache only definitive states; transient failures should re-probe on next visit.
    if (authResult.state === "signed_in" || authResult.state === "signed_out") {
      cachedAuth = { at: now(), result: authResult };
    } else {
      cachedAuth = undefined;
    }

    return authResult;
  };

  return {
    probeBinary,
    readAuth,
    signInModes: () => [],
    canSignOut: () => false,
    canRefreshUsage: false,
    loginCommand: "cycle login agy",
    diagnostics: () => ({
      dataDir: options.config.home ?? join(options.dataDir, "agy"),
      customDataDir: options.config.home !== undefined,
      allowEnv: [...options.config.allowEnv],
      envNames: Object.keys(options.config.env).sort(),
    }),
    runtimeSnapshot: () => ({
      schemaVersion: 1,
      schema: { type: "object", properties: {} },
      values: {
        sandbox: options.config.sandbox ?? false,
        telemetry: options.config.telemetry ?? true,
      },
      overrides: [],
      revision: 0,
    }),
  };
};
