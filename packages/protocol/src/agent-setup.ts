// Harness setup status, read-only host diagnostics, subscription auth status, and runtime config snapshots
// (docs/protocol.md §16, docs/harness-settings.md).
// Long-lived credentials (OAuth tokens, refresh tokens, API keys) and host environment variable values
// never appear in any schema here.
import { z } from "zod";
import { META } from "./meta.ts";
import { cycleMethod } from "./method.ts";
import { PlanUsageSchema } from "./plan-usage.ts";

export const AgentBinarySourceSchema = z.enum(["builtin", "configured", "path", "missing"]);
export type AgentBinarySource = z.infer<typeof AgentBinarySourceSchema>;

export const AgentBinaryProblemSchema = z.enum(["missing", "version_too_old", "probe_failed"]);
export type AgentBinaryProblem = z.infer<typeof AgentBinaryProblemSchema>;

export const AgentBinaryStatusSchema = z.object({
  source: AgentBinarySourceSchema,
  /** Resolved executable path on the daemon's machine when found. */
  path: z.string().min(1).optional(),
  /** Detected version string when known. */
  version: z.string().min(1).optional(),
  /** Minimum version required by this harness when a floor is enforced. */
  minVersion: z.string().min(1).optional(),
  /** Fixed reason when the binary cannot be used. */
  problem: AgentBinaryProblemSchema.optional(),
});
export type AgentBinaryStatus = z.infer<typeof AgentBinaryStatusSchema>;

export const AgentAuthStateSchema = z.enum([
  "binary_unavailable",
  "signed_out",
  "signing_in",
  "signed_in",
  "signing_out",
  "auth_unknown",
]);
export type AgentAuthState = z.infer<typeof AgentAuthStateSchema>;

export const AgentAuthUnknownReasonSchema = z.enum(["network_error", "timeout", "probe_failed"]);
export type AgentAuthUnknownReason = z.infer<typeof AgentAuthUnknownReasonSchema>;

export const AgentAuthMethodSchema = z.enum([
  "subscription",
  "api_key",
  "oauth_token",
  "third_party",
  "none",
  "unknown",
]);
export type AgentAuthMethod = z.infer<typeof AgentAuthMethodSchema>;

export const AgentAuthModeSchema = z.enum(["browser", "code", "device_code"]);
export type AgentAuthMode = z.infer<typeof AgentAuthModeSchema>;

export const AgentSignInModeSchema = z.object({
  mode: AgentAuthModeSchema,
  /** True when the daemon's callback requires a browser on the same machine (e.g. 127.0.0.1 loopback). */
  requiresLocalLoopback: z.boolean(),
});
export type AgentSignInMode = z.infer<typeof AgentSignInModeSchema>;

export const AgentAccountInfoSchema = z.object({
  email: z.string().min(1).optional(),
  organization: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  /** Epoch milliseconds when the current login expires, when reported by the agent. */
  expiresAt: z.number().int().nonnegative().optional(),
  /** Epoch milliseconds when a passively-observed tier (e.g. agy `_meta.antigravity.tier`) was last seen. */
  tierObservedAt: z.number().int().nonnegative().optional(),
});
export type AgentAccountInfo = z.infer<typeof AgentAccountInfoSchema>;

export const AgentAuthStatusSchema = z
  .object({
    state: AgentAuthStateSchema,
    unknownReason: AgentAuthUnknownReasonSchema.optional(),
    method: AgentAuthMethodSchema,
    /** Name of a config.json env variable overriding subscription auth (never its value). */
    viaEnv: z.string().min(1).optional(),
    account: AgentAccountInfoSchema.optional(),
    /** Ordered sign-in modes this daemon supports for this agent; empty when in-app sign-in is disabled. */
    signInModes: z.array(AgentSignInModeSchema),
    /** True when this daemon supports in-app sign-out for this agent. */
    canSignOut: z.boolean(),
    /** Copyable CLI fallback command (e.g. "cycle login claude"). */
    loginCommand: z.string().min(1),
  })
  .refine((auth) => auth.state !== "auth_unknown" || auth.unknownReason !== undefined, {
    message: "auth_unknown requires unknownReason",
    path: ["unknownReason"],
  });
export type AgentAuthStatus = z.infer<typeof AgentAuthStatusSchema>;

export const AgentRuntimeValueSchema = z.union([z.boolean(), z.number(), z.string()]);
export type AgentRuntimeValue = z.infer<typeof AgentRuntimeValueSchema>;

export const RuntimeApplyScopeSchema = z.enum([
  "immediate",
  "next_session",
  "next_idle_restart",
  "daemon_restart",
]);
export type RuntimeApplyScope = z.infer<typeof RuntimeApplyScopeSchema>;

export const RuntimeEnabledWhenSchema = z.object({
  key: z.string().min(1),
  equals: AgentRuntimeValueSchema,
});
export type RuntimeEnabledWhen = z.infer<typeof RuntimeEnabledWhenSchema>;

export const RuntimePropertyMetaSchema = z.object({
  [META.applyScope]: RuntimeApplyScopeSchema.optional(),
  [META.enabledWhen]: RuntimeEnabledWhenSchema.optional(),
  [META.danger]: z.boolean().optional(),
});
export type RuntimePropertyMeta = z.infer<typeof RuntimePropertyMetaSchema>;

export const RuntimeBooleanPropertySchema = z.object({
  type: z.literal("boolean"),
  title: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean(),
  _meta: RuntimePropertyMetaSchema.optional(),
});
export type RuntimeBooleanProperty = z.infer<typeof RuntimeBooleanPropertySchema>;

export const RuntimeIntegerPropertySchema = z
  .object({
    type: z.literal("integer"),
    title: z.string().min(1),
    description: z.string().optional(),
    minimum: z.number().int(),
    maximum: z.number().int(),
    multipleOf: z.number().int().positive().optional(),
    default: z.number().int(),
    _meta: RuntimePropertyMetaSchema.optional(),
  })
  .refine((p) => p.minimum <= p.maximum && p.default >= p.minimum && p.default <= p.maximum, {
    message: "integer runtime property bounds and default must be ordered",
  });
export type RuntimeIntegerProperty = z.infer<typeof RuntimeIntegerPropertySchema>;

export const RuntimeStringChoiceSchema = z.object({
  const: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  _meta: z.object({ [META.danger]: z.boolean().optional() }).optional(),
});

export const RuntimeStringEnumPropertySchema = z.object({
  type: z.literal("string"),
  title: z.string().min(1),
  description: z.string().optional(),
  oneOf: z.array(RuntimeStringChoiceSchema).min(1),
  default: z.string(),
  _meta: RuntimePropertyMetaSchema.optional(),
});
export type RuntimeStringEnumProperty = z.infer<typeof RuntimeStringEnumPropertySchema>;

/** Closed v1 subset of §10 `configSchema` allowed for editable Harness runtime properties. */
export const RuntimePropertySchema = z.union([
  RuntimeBooleanPropertySchema,
  RuntimeIntegerPropertySchema,
  RuntimeStringEnumPropertySchema,
]);
export type RuntimeProperty = z.infer<typeof RuntimePropertySchema>;

/**
 * Runtime settings snapshot for one agent. `schema.properties` keeps unknown property shapes
 * intact on the wire so older clients can degrade unfamiliar future fields to read-only instead
 * of failing snapshot parsing (docs/protocol.md §16).
 */
export const AgentRuntimeSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  schema: z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()),
  }),
  values: z.record(z.string(), AgentRuntimeValueSchema),
  overrides: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  /** Present when `<dataDir>/agent-settings.json` exists on disk but could not be parsed. */
  fileError: z.string().min(1).optional(),
});
export type AgentRuntimeSnapshot = z.infer<typeof AgentRuntimeSnapshotSchema>;

export const AgentRuntimePatchValueSchema = z.union([AgentRuntimeValueSchema, z.null()]);
export type AgentRuntimePatchValue = z.infer<typeof AgentRuntimePatchValueSchema>;

export const agentSetupSetRuntime = cycleMethod(
  "_cycle/agent_setup/set_runtime",
  z.object({
    agent: z.string().min(1),
    /** Partial patch; `null` removes an explicit override to inherit from config.json / schema default. */
    patch: z.record(z.string(), AgentRuntimePatchValueSchema),
    /** Per-agent monotonic revision for compare-and-swap optimistic concurrency. */
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    values: z.record(z.string(), AgentRuntimeValueSchema),
    overrides: z.array(z.string()),
    revision: z.number().int().nonnegative(),
  }),
);

/** Broadcast to all clients when an agent's setup snapshot changes (runtime save, login, logout). */
export const AGENT_SETUP_CHANGED = "_cycle/agent_setup_changed";
export const AgentSetupChangedSchema = z.object({
  agent: z.string().min(1),
  revision: z.number().int().nonnegative().optional(),
});
export type AgentSetupChanged = z.infer<typeof AgentSetupChangedSchema>;

export const AgentConfigFileStatusSchema = z.object({
  path: z.string().min(1),
  exists: z.boolean(),
  /** True when config.json was modified after the daemon loaded it at startup. */
  stale: z.boolean(),
  /** Parse or schema validation error from config.json, if any. */
  error: z.string().min(1).optional(),
});
export type AgentConfigFileStatus = z.infer<typeof AgentConfigFileStatusSchema>;

export const AgentEnvironmentDiagnosticsSchema = z.object({
  configFile: AgentConfigFileStatusSchema,
  /** Cycle-managed agent state directory (default `<dataDir>/<agent>` or custom from config.json). */
  dataDir: z.string().min(1),
  /** True when the managed directory was customized in config.json rather than `<dataDir>/<agent>`. */
  customDataDir: z.boolean(),
  /** Variable names from `allowEnv` (names only, never values). */
  allowEnv: z.array(z.string()),
  /** Variable names declared in `config.json` `env` (names only, never values). */
  envNames: z.array(z.string()),
});
export type AgentEnvironmentDiagnostics = z.infer<typeof AgentEnvironmentDiagnosticsSchema>;

export const AgentSetupSnapshotSchema = z.object({
  agent: z.string().min(1),
  name: z.string().min(1),
  available: z.boolean(),
  binary: AgentBinaryStatusSchema,
  auth: AgentAuthStatusSchema,
  planUsage: PlanUsageSchema.optional(),
  canRefreshUsage: z.boolean(),
  runtime: AgentRuntimeSnapshotSchema,
  environment: AgentEnvironmentDiagnosticsSchema,
});
export type AgentSetupSnapshot = z.infer<typeof AgentSetupSnapshotSchema>;

export const agentSetupRead = cycleMethod(
  "_cycle/agent_setup/read",
  z.object({
    agent: z.string().min(1),
    /** Actively query plan usage when the agent supports it (e.g. Codex). */
    refreshUsage: z.boolean().optional(),
    /** Bypass any short-TTL probe cache on the daemon. */
    forceRefresh: z.boolean().optional(),
  }),
  AgentSetupSnapshotSchema,
);

/** Fixed `data.reason` values used with `-32602` for agent setup & auth methods (docs/protocol.md §16). */
export const AgentSetupInvalidParamReasonSchema = z.enum([
  "unknown_agent",
  "unsupported_mode",
  "flow_not_found",
  "flow_forbidden",
  "flow_consumed",
  "flow_not_active",
  "revision_conflict",
]);
export type AgentSetupInvalidParamReason = z.infer<typeof AgentSetupInvalidParamReasonSchema>;

/** Fixed `data.reason` values used with `-32021` (`agent_auth_failed`) (docs/protocol.md §16). */
export const AgentAuthFailureReasonSchema = z.enum([
  "binary_unavailable",
  "auth_in_progress",
  "parse_failed",
  "invalid_code",
  "expired",
  "cancelled",
  "process_failed",
  "timeout",
]);
export type AgentAuthFailureReason = z.infer<typeof AgentAuthFailureReasonSchema>;

export const AgentAuthStartResultSchema = z.object({
  flowId: z.string().min(1),
  mode: AgentAuthModeSchema,
  /** Epoch milliseconds when this flow expires (fixed 10-minute TTL). */
  expiresAt: z.number().int().nonnegative(),
  authorizationUrl: z.string().min(1).optional(),
  verificationUrl: z.string().min(1).optional(),
  userCode: z.string().min(1).optional(),
});
export type AgentAuthStartResult = z.infer<typeof AgentAuthStartResultSchema>;

export const agentAuthStart = cycleMethod(
  "_cycle/agent_auth/start",
  z.object({
    agent: z.string().min(1),
    mode: AgentAuthModeSchema.optional(),
  }),
  AgentAuthStartResultSchema,
);

export const agentAuthSubmit = cycleMethod(
  "_cycle/agent_auth/submit",
  z.object({
    flowId: z.string().min(1),
    /** Short-lived one-time hosted-callback authorization code; memory-only, never logged or persisted. */
    code: z.string().min(1),
  }),
  z.object({
    ok: z.literal(true),
  }),
);

export const agentAuthCancel = cycleMethod(
  "_cycle/agent_auth/cancel",
  z.object({
    flowId: z.string().min(1),
  }),
  z.object({}),
);

export const agentAuthLogout = cycleMethod(
  "_cycle/agent_auth/logout",
  z.object({
    agent: z.string().min(1),
  }),
  z.object({}),
);

/**
 * An agent is wanted soon (the blank page chose it): start it now if it can run before a session exists, so that the
 * session made next takes it over (docs/protocol.md §16 "提前起进程"). Always answers `{}`: an agent that cannot, or
 * fails to start, is started by the session as before.
 */
export const agentPrewarm = cycleMethod(
  "_cycle/agent_setup/prewarm",
  z.object({
    agent: z.string().min(1),
  }),
  z.object({}),
);

/** Sent ONLY to the connection that initiated the auth flow (docs/protocol.md §16). */
export const AGENT_AUTH_COMPLETED = "_cycle/agent_auth_completed";
export const AgentAuthCompletedSchema = z.object({
  flowId: z.string().min(1),
  agent: z.string().min(1),
  ok: z.boolean(),
  // A reason a newer daemon adds is read as a process failure, not a notice dropped whole: the person who started the
  // flow must hear that it ended, whatever word it ended with.
  reason: AgentAuthFailureReasonSchema.optional().catch("process_failed"),
});
export type AgentAuthCompleted = z.infer<typeof AgentAuthCompletedSchema>;
