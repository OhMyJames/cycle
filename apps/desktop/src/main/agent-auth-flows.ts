// An agent's setup and account as the page sees them (docs/harness-settings.md, CYCL-226): reading what the daemon knows,
// saving runtime settings, and the in-app sign-in flows. Main keeps the flows this window started, judges every URL a
// daemon gives against the hardcoded allowlist (agent-auth-guard.ts), and opens one only when the person clicks.
import { agentOf } from "@cycle/analytics/events";
import type { ClientEvents, CycleClient } from "@cycle/client";
import { AgentAuthFailureReasonSchema, CycleErrorCode } from "@cycle/protocol";
import type {
  AgentAuthLogoutAnswer,
  AgentAuthProblemReason,
  AgentAuthStartAnswer,
  AgentAuthSubmitAnswer,
  AgentRuntimePatchValue,
  AgentRuntimeSaveAnswer,
  AgentSetupSnapshot,
  AgentSignInMode,
} from "@cycle/ui";
import { selectAgentSignInMode, validateAgentAuthUrl } from "./agent-auth-guard.ts";
import type { Runtime } from "./runtime.ts";

type AgentAuthCompleted = Parameters<NonNullable<ClientEvents["agentAuthCompleted"]>>[0];

// Keep the installed shell's bridge definition stable. The compiler checks the runtime
// vocabulary against it, including the failure reasons the daemon protocol already owns.
const authProblemReasons = Object.values({
  ...AgentAuthFailureReasonSchema.enum,
  unsupported_mode: "unsupported_mode",
  untrusted_url: "untrusted_url",
  flow_not_found: "flow_not_found",
  flow_forbidden: "flow_forbidden",
  flow_consumed: "flow_consumed",
  flow_not_active: "flow_not_active",
  disconnected: "disconnected",
  failed: "failed",
} as const satisfies { [Reason in AgentAuthProblemReason]: Reason });

export const authProblemReasonOf = (error: unknown): AgentAuthProblemReason => {
  const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason;
  return authProblemReasons.find((known) => known === reason) ?? "failed";
};

export class AgentAuthFlows {
  readonly #runtime: Runtime;
  /** The local daemon's `config.json` path last reported by `readAgentSetup`, for `revealDaemonConfig`. */
  readonly #localConfigPath = new Map<string, string>();
  /** Latest daemon-declared `signInModes` per `${locationId}:${agent}`, for transport-aware mode selection. */
  readonly #signInModes = new Map<string, AgentSignInMode[]>();
  /** Active in-app agent auth flows initiated by this desktop instance (keyed by `${locationId}:${flowId}`). */
  readonly #activeAuthFlows = new Map<
    string,
    { locationId: string; agent: string; flowId: string; url?: string; host?: string }
  >();
  /** Flow IDs cancelled by desktop itself due to untrusted URL, so the daemon's cancel notification isn't double-counted. */
  readonly #rejectedAuthFlows = new Set<string>();
  /** In-flight `startAgentAuth` calls per location, so an immediate completion arriving in the same chunk isn't lost. */
  readonly #startingAuthCount = new Map<string, number>();
  readonly #earlyAuthCompleted = new Map<
    string,
    { agent: string; ok: boolean; reason?: AgentAuthProblemReason | undefined }
  >();

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** A daemon said a flow it started for this connection ended (`_cycle/agent_auth_completed`). */
  completed(locationId: string, completed: AgentAuthCompleted): void {
    const flowKey = `${locationId}:${completed.flowId}`;
    if (this.#rejectedAuthFlows.delete(flowKey)) return;
    if (!this.#activeAuthFlows.delete(flowKey)) {
      // If startAgentAuth is currently awaiting the daemon response, stash once; otherwise drop duplicate/unsolicited notifications.
      if ((this.#startingAuthCount.get(locationId) ?? 0) > 0) {
        this.#earlyAuthCompleted.set(flowKey, {
          agent: completed.agent,
          ok: completed.ok,
          ...(completed.reason !== undefined ? { reason: completed.reason } : {}),
        });
      }
      return;
    }
    this.#emitAuthCompleted(
      locationId,
      completed.flowId,
      completed.agent,
      completed.ok,
      completed.reason,
    );
  }

  async readAgentSetup(
    locationId: string,
    agent: string,
    options?: { refreshUsage?: boolean; forceRefresh?: boolean },
  ): Promise<AgentSetupSnapshot> {
    const snapshot = await this.#runtime
      .connection(locationId)
      .client.readAgentSetup(agent, options);
    this.#signInModes.set(`${locationId}:${agent}`, snapshot.auth.signInModes);
    if (this.#runtime.kindOf(locationId) === "local") {
      this.#localConfigPath.set(locationId, snapshot.environment.configFile.path);
    }
    return snapshot;
  }

  /** Never fails: the session starts its own agent if this did not come to anything. */
  async prewarmAgent(locationId: string, agent: string): Promise<void> {
    try {
      const { client } = this.#runtime.connection(locationId);
      if (client.capabilities.agentPrewarm !== true) return;
      await client.prewarmAgent(agent);
    } catch {
      // Nothing to tell: it was only ahead of time.
    }
  }

  async setAgentRuntimeSettings(
    locationId: string,
    agent: string,
    patch: Record<string, AgentRuntimePatchValue>,
    expectedRevision: number,
  ): Promise<AgentRuntimeSaveAnswer> {
    try {
      const result = await this.#runtime
        .connection(locationId)
        .client.setAgentRuntimeSettings(agent, patch, expectedRevision);
      this.#runtime.track("agent_runtime_settings_saved", {
        agent: agentOf(agent),
        location: this.#runtime.kindOf(locationId),
        skip_permissions: result.values.skipPermissions === true,
      });
      return { saved: true, ...result };
    } catch (error) {
      const rpc = error as {
        code?: number;
        message?: string;
        data?: { reason?: string; currentRevision?: number; field?: string };
      };
      if (rpc.code === -32602 && rpc.data?.reason === "revision_conflict") {
        return {
          saved: false,
          problem: "revision_conflict",
          ...(typeof rpc.data.currentRevision === "number"
            ? { currentRevision: rpc.data.currentRevision }
            : {}),
        };
      }
      if (rpc.code === CycleErrorCode.InvalidConfig && rpc.data?.reason === "file_corrupt") {
        return {
          saved: false,
          problem: "file_corrupt",
          ...(typeof rpc.message === "string" ? { message: rpc.message } : {}),
        };
      }
      if (rpc.code === CycleErrorCode.InvalidConfig) {
        return {
          saved: false,
          problem: "invalid_config",
          ...(typeof rpc.data?.field === "string" ? { field: rpc.data.field } : {}),
          ...(typeof rpc.message === "string" ? { message: rpc.message } : {}),
        };
      }
      return {
        saved: false,
        problem: "failed",
        ...(typeof rpc.message === "string" ? { message: rpc.message } : {}),
      };
    }
  }

  async revealDaemonConfig(locationId: string): Promise<boolean> {
    if (
      this.#runtime.kindOf(locationId) !== "local" ||
      this.#runtime.options.revealPath === undefined
    ) {
      return false;
    }
    const path = this.#localConfigPath.get(locationId);
    if (path === undefined) return false;
    this.#runtime.options.revealPath(path);
    return true;
  }

  async startAgentAuth(locationId: string, agent: string): Promise<AgentAuthStartAnswer> {
    const envKind = this.#runtime.kindOf(locationId);
    const cacheKey = `${locationId}:${agent}`;
    let signInModes = this.#signInModes.get(cacheKey);
    if (signInModes === undefined) {
      try {
        const snapshot = await this.readAgentSetup(locationId, agent);
        signInModes = snapshot.auth.signInModes;
      } catch (error) {
        return { started: false, reason: authProblemReasonOf(error) };
      }
    }
    const mode = selectAgentSignInMode(envKind, signInModes);
    if (mode === undefined) return { started: false, reason: "unsupported_mode" };

    let client: CycleClient;
    try {
      client = this.#runtime.connection(locationId).client;
    } catch {
      return { started: false, reason: "disconnected" };
    }
    let started: Awaited<ReturnType<typeof client.startAgentAuth>>;
    this.#startingAuthCount.set(locationId, (this.#startingAuthCount.get(locationId) ?? 0) + 1);
    try {
      started = await client.startAgentAuth(agent, mode);
    } catch (error) {
      this.#forgetUnclaimedCompletions(locationId);
      return { started: false, reason: authProblemReasonOf(error) };
    } finally {
      const remaining = (this.#startingAuthCount.get(locationId) ?? 1) - 1;
      if (remaining <= 0) this.#startingAuthCount.delete(locationId);
      else this.#startingAuthCount.set(locationId, remaining);
    }
    // The daemon started a flow: counted before the URLs are judged, so a refused URL is a start that failed and the
    // funnel's completions never outnumber its starts.
    this.#runtime.track("agent_auth_started", {
      agent: agentOf(agent),
      location: envKind,
      mode: started.mode,
    });

    const flowKey = `${locationId}:${started.flowId}`;
    const rejectUntrusted = () => {
      this.#earlyAuthCompleted.delete(flowKey);
      this.#rejectedAuthFlows.add(flowKey);
      if (this.#rejectedAuthFlows.size > 100) {
        const oldest = this.#rejectedAuthFlows.values().next().value;
        if (oldest !== undefined) this.#rejectedAuthFlows.delete(oldest);
      }
      void client.cancelAgentAuth(started.flowId).catch(() => undefined);
      this.#forgetUnclaimedCompletions(locationId);
      this.#runtime.track("agent_auth_completed", {
        agent: agentOf(agent),
        location: envKind,
        result: "failed",
      });
      return { started: false as const, reason: "untrusted_url" as const };
    };

    // Validate BOTH authorizationUrl and verificationUrl against the desktop's hardcoded allowlist.
    // Never silently call openBrowser here; wait for explicit user click in the modal.
    let verifiedAuth: { url: string; host: string } | undefined;
    if (started.authorizationUrl !== undefined) {
      const check = validateAgentAuthUrl(agent, started.authorizationUrl);
      if (!check.ok) return rejectUntrusted();
      verifiedAuth = { url: check.url, host: check.host };
    }

    let verifiedVerify: { url: string; host: string } | undefined;
    if (started.verificationUrl !== undefined) {
      const check = validateAgentAuthUrl(agent, started.verificationUrl);
      if (!check.ok) return rejectUntrusted();
      verifiedVerify = { url: check.url, host: check.host };
    }

    const primary = verifiedAuth ?? verifiedVerify;
    const early = this.#earlyAuthCompleted.get(flowKey);
    if (early !== undefined) {
      this.#earlyAuthCompleted.delete(flowKey);
      this.#emitAuthCompleted(locationId, started.flowId, early.agent, early.ok, early.reason);
    } else {
      this.#activeAuthFlows.set(flowKey, {
        locationId,
        agent,
        flowId: started.flowId,
        ...(primary !== undefined ? { url: primary.url, host: primary.host } : {}),
      });
    }
    this.#forgetUnclaimedCompletions(locationId);
    return {
      started: true,
      flowId: started.flowId,
      mode: started.mode,
      expiresAt: started.expiresAt,
      ...(primary !== undefined ? { host: primary.host } : {}),
      hasUrl: primary !== undefined,
      ...(started.userCode !== undefined ? { userCode: started.userCode } : {}),
    };
  }

  async openAgentAuthUrl(locationId: string, flowId: string): Promise<boolean> {
    const entry = this.#activeAuthFlows.get(`${locationId}:${flowId}`);
    if (entry?.url === undefined || this.#runtime.options.openBrowser === undefined) return false;
    // Re-verify allowlist on open (defense in depth).
    const check = validateAgentAuthUrl(entry.agent, entry.url);
    if (!check.ok) return false;
    await this.#runtime.options.openBrowser(check.url);
    return true;
  }

  async submitAgentAuth(
    locationId: string,
    flowId: string,
    code: string,
  ): Promise<AgentAuthSubmitAnswer> {
    try {
      await this.#runtime.connection(locationId).client.submitAgentAuth(flowId, code);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: authProblemReasonOf(error) };
    }
  }

  async cancelAgentAuth(locationId: string, flowId: string): Promise<void> {
    const key = `${locationId}:${flowId}`;
    try {
      await this.#runtime.connection(locationId).client.cancelAgentAuth(flowId);
    } catch {
      this.#activeAuthFlows.delete(key);
    }
  }

  async logoutAgent(locationId: string, agent: string): Promise<AgentAuthLogoutAnswer> {
    const envKind = this.#runtime.kindOf(locationId);
    try {
      await this.#runtime.connection(locationId).client.logoutAgent(agent);
      this.#runtime.track("agent_signed_out", {
        agent: agentOf(agent),
        location: envKind,
        ok: true,
      });
      return { ok: true };
    } catch (error) {
      this.#runtime.track("agent_signed_out", {
        agent: agentOf(agent),
        location: envKind,
        ok: false,
      });
      return { ok: false, reason: authProblemReasonOf(error) };
    }
  }

  #emitAuthCompleted(
    locationId: string,
    flowId: string,
    agent: string,
    ok: boolean,
    reason?: AgentAuthProblemReason,
  ): void {
    const result = ok
      ? "ok"
      : reason === "cancelled" || reason === "disconnected"
        ? reason
        : "failed";
    this.#runtime.track("agent_auth_completed", {
      agent: agentOf(agent),
      location: this.#runtime.kindOf(locationId),
      result,
    });
    this.#runtime.options.emit({
      type: "agent-auth-completed",
      locationId,
      flowId,
      agent,
      ok,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * A completion is kept aside only while a start on its location awaits the daemon's answer (it may come first, in
   * the same chunk). Once no start is waiting there, what nobody claimed was not ours: dropped, so it cannot pile up.
   */
  #forgetUnclaimedCompletions(locationId: string): void {
    if ((this.#startingAuthCount.get(locationId) ?? 0) > 0) return;
    const prefix = `${locationId}:`;
    for (const key of [...this.#earlyAuthCompleted.keys()]) {
      if (key.startsWith(prefix)) this.#earlyAuthCompleted.delete(key);
    }
  }

  /** The location's connection went (dropped, or closed here): its flows end, as disconnected. */
  lost(locationId: string): void {
    const envKind = this.#runtime.kindOf(locationId);
    const prefix = `${locationId}:`;
    this.#localConfigPath.delete(locationId);
    for (const key of [...this.#signInModes.keys()]) {
      if (key.startsWith(prefix)) this.#signInModes.delete(key);
    }
    for (const key of [...this.#rejectedAuthFlows]) {
      if (key.startsWith(prefix)) this.#rejectedAuthFlows.delete(key);
    }
    for (const key of [...this.#earlyAuthCompleted.keys()]) {
      if (key.startsWith(prefix)) this.#earlyAuthCompleted.delete(key);
    }
    for (const [key, entry] of [...this.#activeAuthFlows.entries()]) {
      if (entry.locationId !== locationId) continue;
      this.#activeAuthFlows.delete(key);
      this.#runtime.track("agent_auth_completed", {
        agent: agentOf(entry.agent),
        location: envKind,
        result: "disconnected",
      });
      this.#runtime.options.emit({
        type: "agent-auth-completed",
        locationId,
        flowId: entry.flowId,
        agent: entry.agent,
        ok: false,
        reason: "disconnected",
      });
    }
  }
}
