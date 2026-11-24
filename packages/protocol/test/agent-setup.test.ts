import { expect, test } from "bun:test";
import {
  ACP_ERROR_CODES,
  AGENT_SETUP_CHANGED,
  AgentAuthFailureReasonSchema,
  AgentSetupChangedSchema,
  AgentSetupInvalidParamReasonSchema,
  type AgentSetupSnapshot,
  AgentSetupSnapshotSchema,
  agentSetupRead,
  agentSetupSetRuntime,
  CapabilitiesSchema,
  CycleErrorCode,
  META,
  RuntimePropertySchema,
} from "../src/index.ts";

const baseSnapshot = (): AgentSetupSnapshot => ({
  agent: "claude",
  name: "Claude",
  available: true,
  binary: {
    source: "builtin",
    path: "/opt/cycle/claude",
    version: "2.1.327",
  },
  auth: {
    state: "signed_in",
    method: "subscription",
    account: {
      email: "dev@example.com",
      organization: "Acme",
      plan: "max",
      expiresAt: 1_795_500_000_000,
    },
    signInModes: [],
    canSignOut: false,
    loginCommand: "cycle login claude",
  },
  planUsage: {
    windows: [
      {
        kind: "five_hour",
        utilization: 0.35,
        resetsAt: 1_795_490_000_000,
        status: "allowed",
      },
    ],
    at: 1_795_480_000_000,
  },
  canRefreshUsage: false,
  runtime: {
    schemaVersion: 1,
    schema: { type: "object", properties: {} },
    values: { warmStart: true, maxWarm: 2 },
    overrides: [],
    revision: 0,
  },
  environment: {
    configFile: {
      path: "/home/dev/.cycle/config.json",
      exists: true,
      stale: false,
    },
    dataDir: "/home/dev/.cycle/claude",
    customDataDir: false,
    allowEnv: ["HTTPS_PROXY"],
    envNames: [],
  },
});

test("agentSetupRead uses _cycle/ namespace and validates params", () => {
  expect(agentSetupRead.name).toBe("_cycle/agent_setup/read");
  expect(agentSetupRead.params.safeParse({ agent: "claude" }).success).toBe(true);
  expect(
    agentSetupRead.params.safeParse({ agent: "codex", refreshUsage: true, forceRefresh: true })
      .success,
  ).toBe(true);
  expect(agentSetupRead.params.safeParse({ agent: "" }).success).toBe(false);
  expect(agentSetupRead.params.safeParse({}).success).toBe(false);
});

test("AgentSetupSnapshotSchema accepts valid snapshots across agents", () => {
  expect(AgentSetupSnapshotSchema.safeParse(baseSnapshot()).success).toBe(true);

  const codex = {
    ...baseSnapshot(),
    agent: "codex",
    name: "Codex",
    canRefreshUsage: true,
    auth: {
      state: "signed_out" as const,
      method: "none" as const,
      signInModes: [
        { mode: "browser" as const, requiresLocalLoopback: true },
        { mode: "device_code" as const, requiresLocalLoopback: false },
      ],
      canSignOut: true,
      loginCommand: "cycle login codex",
    },
  };
  expect(AgentSetupSnapshotSchema.safeParse(codex).success).toBe(true);

  const agy = {
    ...baseSnapshot(),
    agent: "agy",
    name: "Antigravity",
    binary: {
      source: "path" as const,
      path: "/usr/local/bin/agy",
      version: "1.5.15",
      minVersion: "1.5.10",
    },
    auth: {
      state: "signed_in" as const,
      method: "subscription" as const,
      account: { plan: "pro", tierObservedAt: 1_795_480_000_000 },
      signInModes: [{ mode: "code" as const, requiresLocalLoopback: false }],
      canSignOut: true,
      loginCommand: "cycle login agy",
    },
    planUsage: undefined,
  };
  expect(AgentSetupSnapshotSchema.safeParse(agy).success).toBe(true);
});

test("auth_unknown requires a fixed unknownReason", () => {
  const missingReason = {
    ...baseSnapshot(),
    auth: {
      ...baseSnapshot().auth,
      state: "auth_unknown" as const,
      method: "unknown" as const,
    },
  };
  expect(AgentSetupSnapshotSchema.safeParse(missingReason).success).toBe(false);

  for (const unknownReason of ["network_error", "timeout", "probe_failed"] as const) {
    const valid = {
      ...missingReason,
      auth: { ...missingReason.auth, unknownReason },
    };
    expect(AgentSetupSnapshotSchema.safeParse(valid).success).toBe(true);
  }
});

test("runtime schema preserves unfamiliar future property types for read-only degradation", () => {
  const withFutureField = {
    ...baseSnapshot(),
    runtime: {
      schemaVersion: 1 as const,
      schema: {
        type: "object" as const,
        properties: {
          futureMatrix: { type: "array", title: "Future option" },
        },
      },
      values: { futureMatrix: "custom" },
      overrides: ["futureMatrix"],
      revision: 2,
    },
  };
  expect(AgentSetupSnapshotSchema.safeParse(withFutureField).success).toBe(true);
});

test("CapabilitiesSchema exposes single optional agentSetup flag and AgentAuthFailed is clear of ACP codes", () => {
  const withCap = CapabilitiesSchema.parse({
    replay: ["start"],
    agents: ["claude", "codex", "agy"],
    sessionOps: [],
    agentSetup: true,
  });
  expect(withCap.agentSetup).toBe(true);

  const withoutCap = CapabilitiesSchema.parse({
    replay: ["start"],
    agents: ["claude"],
    sessionOps: [],
  });
  expect(withoutCap.agentSetup).toBeUndefined();

  expect(CycleErrorCode.AgentAuthFailed).toBe(-32021);
  expect(ACP_ERROR_CODES).not.toContain(CycleErrorCode.AgentAuthFailed);

  expect(AgentSetupInvalidParamReasonSchema.safeParse("revision_conflict").success).toBe(true);
  expect(AgentSetupInvalidParamReasonSchema.safeParse("raw stderr").success).toBe(false);
  expect(AgentAuthFailureReasonSchema.safeParse("auth_in_progress").success).toBe(true);
  expect(AgentAuthFailureReasonSchema.safeParse("something_random").success).toBe(false);
});

test("RuntimePropertySchema enforces closed v1 types and bounds", () => {
  expect(
    RuntimePropertySchema.safeParse({
      type: "boolean",
      title: "Warm start",
      default: true,
      _meta: { [META.applyScope]: "immediate" },
    }).success,
  ).toBe(true);

  expect(
    RuntimePropertySchema.safeParse({
      type: "integer",
      title: "Max warm",
      minimum: 1,
      maximum: 10,
      default: 3,
      _meta: {
        [META.applyScope]: "immediate",
        [META.enabledWhen]: { key: "warmStart", equals: true },
      },
    }).success,
  ).toBe(true);

  // Unbounded integer or default outside bounds rejected.
  expect(
    RuntimePropertySchema.safeParse({ type: "integer", title: "Bad", default: 3 }).success,
  ).toBe(false);
  expect(
    RuntimePropertySchema.safeParse({
      type: "integer",
      title: "Out of range default",
      minimum: 1,
      maximum: 10,
      default: 20,
    }).success,
  ).toBe(false);

  // Free-form string without oneOf rejected.
  expect(
    RuntimePropertySchema.safeParse({ type: "string", title: "Free text", default: "abc" }).success,
  ).toBe(false);

  // Closed string enum accepted.
  expect(
    RuntimePropertySchema.safeParse({
      type: "string",
      title: "Mode",
      oneOf: [
        { const: "strict", title: "Strict" },
        { const: "off", title: "Off", _meta: { [META.danger]: true } },
      ],
      default: "strict",
    }).success,
  ).toBe(true);
});

test("agentSetupSetRuntime supports partial patch, null unset, and per-agent revision", () => {
  expect(agentSetupSetRuntime.name).toBe("_cycle/agent_setup/set_runtime");
  expect(AGENT_SETUP_CHANGED).toBe("_cycle/agent_setup_changed");
  expect(
    agentSetupSetRuntime.params.safeParse({
      agent: "claude",
      patch: { warmStart: false, maxWarm: null },
      expectedRevision: 0,
    }).success,
  ).toBe(true);
  expect(
    agentSetupSetRuntime.params.safeParse({
      agent: "claude",
      patch: { warmStart: false },
      expectedRevision: -1,
    }).success,
  ).toBe(false);
  expect(AgentSetupChangedSchema.safeParse({ agent: "claude", revision: 2 }).success).toBe(true);
});
