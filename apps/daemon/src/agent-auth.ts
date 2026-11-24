// Per-agent subscription auth flow & logout manager (docs/protocol.md §16, CYCL-233).
// Enforces:
// - per-agent mutual exclusion (`auth_in_progress`),
// - `(connectionId, agent, flowId)` binding,
// - atomic single-use `pending -> submitting | cancelled | expired -> completed` state machine,
// - fixed 10-minute TTL with immediate subprocess cleanup on disconnect / expiry / daemon.close(),
// - zero persistence or logging of one-time authorization codes.
import { randomUUID } from "node:crypto";
import {
  type AgentAuthCompleted,
  type AgentAuthFailureReason,
  type AgentAuthMode,
  type AgentAuthStartResult,
  CycleErrorCode,
} from "@cycle/protocol";
import {
  AgentAuthDriverError,
  type AgentAuthFlowHandle,
  type AgentSetupProvider,
} from "./agent-setup.ts";
import { INVALID_PARAMS, RpcError } from "./errors.ts";
import { type Logger, silentLogger } from "./logger.ts";

export const AUTH_FLOW_TTL_MS = 10 * 60_000;
const FINISHED_FLOW_CAP = 200;

type FlowState = "pending" | "submitting" | "cancelled" | "expired" | "completed";

type ActiveFlow = {
  kind: "flow";
  flowId: string;
  agent: string;
  connectionId: string;
  mode: AgentAuthMode;
  state: FlowState;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  handle: AgentAuthFlowHandle;
  invalidateCache?: (() => void) | undefined;
};

type ActiveEntry = { kind: "starting"; connectionId: string } | { kind: "logout" } | ActiveFlow;

type FinishedFlowRecord = {
  connectionId: string;
  outcome: "consumed" | "inactive";
};

export type AgentAuthManagerOptions = {
  /** Override 10-minute TTL in tests. */
  ttlMs?: number | undefined;
  now?: (() => number) | undefined;
  log?: Logger | undefined;
  /** Sends `_cycle/agent_auth_completed` ONLY to the initiating connection. */
  onCompleted: (connectionId: string, payload: AgentAuthCompleted) => void;
  /** Broadcasts `_cycle/agent_setup_changed` to all connected clients. */
  onChanged: (agent: string) => void;
};

const authError = (reason: AgentAuthFailureReason, message: string): RpcError =>
  new RpcError(CycleErrorCode.AgentAuthFailed, message, { reason });

const paramError = (reason: string, message: string): RpcError =>
  new RpcError(INVALID_PARAMS, message, { reason });

const toFailureReason = (error: unknown): AgentAuthFailureReason =>
  error instanceof AgentAuthDriverError ? error.reason : "process_failed";

export class AgentAuthManager {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #onCompleted: (connectionId: string, payload: AgentAuthCompleted) => void;
  readonly #onChanged: (agent: string) => void;

  readonly #activeByAgent = new Map<string, ActiveEntry>();
  readonly #flowsById = new Map<string, ActiveFlow>();
  readonly #finishedFlows = new Map<string, FinishedFlowRecord>();
  #closed = false;

  constructor(options: AgentAuthManagerOptions) {
    this.#ttlMs = options.ttlMs ?? AUTH_FLOW_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? silentLogger;
    this.#onCompleted = options.onCompleted;
    this.#onChanged = options.onChanged;
  }

  /** Current live auth transition state for an agent, if any (`signing_in` / `signing_out`). */
  stateFor(agent: string): "signing_in" | "signing_out" | undefined {
    const entry = this.#activeByAgent.get(agent);
    if (entry === undefined) return undefined;
    return entry.kind === "logout" ? "signing_out" : "signing_in";
  }

  async start(
    connectionId: string,
    agent: string,
    requestedMode: AgentAuthMode | undefined,
    provider: AgentSetupProvider,
  ): Promise<AgentAuthStartResult> {
    if (this.#closed) throw authError("cancelled", "Daemon is shutting down");

    const binary = await provider.probeBinary();
    if (binary.problem !== undefined) {
      throw authError("binary_unavailable", "Agent binary is unavailable");
    }

    const allowedModes = provider.signInModes();
    const mode = requestedMode ?? allowedModes[0]?.mode;
    if (mode === undefined || !allowedModes.some((m) => m.mode === mode)) {
      throw paramError("unsupported_mode", "Requested sign-in mode is not supported");
    }
    const driver = provider.authDriver;
    if (driver === undefined) {
      throw paramError("unsupported_mode", "In-app sign-in is not enabled for this agent");
    }

    // Acquire per-agent lock synchronously before any await.
    if (this.#activeByAgent.has(agent)) {
      throw authError("auth_in_progress", "An authentication operation is already in progress");
    }
    const placeholder: ActiveEntry = { kind: "starting", connectionId };
    this.#activeByAgent.set(agent, placeholder);

    let handle: AgentAuthFlowHandle;
    try {
      handle = await driver.start(mode);
    } catch (error) {
      if (this.#activeByAgent.get(agent) === placeholder) this.#activeByAgent.delete(agent);
      const reason = toFailureReason(error);
      this.#log.warn("agent_auth_start_failed", { agent, mode, reason });
      throw authError(reason, "Failed to start agent sign-in");
    }

    // If the connection closed or daemon closed while starting, cancel immediately.
    if (this.#closed || this.#activeByAgent.get(agent) !== placeholder) {
      await Promise.resolve(handle.cancel()).catch(() => {});
      throw authError("cancelled", "Sign-in was cancelled before it started");
    }

    const flowId = randomUUID();
    const expiresAt = this.#now() + this.#ttlMs;
    const timer = setTimeout(() => {
      void this.#expire(flowId);
    }, this.#ttlMs);

    const flow: ActiveFlow = {
      kind: "flow",
      flowId,
      agent,
      connectionId,
      mode,
      state: "pending",
      expiresAt,
      timer,
      handle,
      invalidateCache: driver.invalidateCache,
    };
    this.#activeByAgent.set(agent, flow);
    this.#flowsById.set(flowId, flow);
    this.#log.info("agent_auth_started", { agent, mode, flowId });
    this.#onChanged(agent);

    void handle.completed.then(
      (outcome) => this.#onFlowSettled(flow, outcome),
      (error) => this.#onFlowSettled(flow, { ok: false, reason: toFailureReason(error) }),
    );

    return {
      flowId,
      mode,
      expiresAt,
      ...(handle.authorizationUrl !== undefined
        ? { authorizationUrl: handle.authorizationUrl }
        : {}),
      ...(handle.verificationUrl !== undefined ? { verificationUrl: handle.verificationUrl } : {}),
      ...(handle.userCode !== undefined ? { userCode: handle.userCode } : {}),
    };
  }

  /**
   * Single-use code submission for `"code"` mode.
   * `code` is NEVER logged, persisted, or interpolated into errors.
   */
  async submit(connectionId: string, flowId: string, code: string): Promise<{ ok: true }> {
    const flow = this.#flowsById.get(flowId);
    if (flow === undefined) {
      const finished = this.#finishedFlows.get(flowId);
      if (finished !== undefined) {
        if (finished.connectionId !== connectionId) {
          throw paramError("flow_forbidden", "Auth flow belongs to another connection");
        }
        throw paramError(
          finished.outcome === "consumed" ? "flow_consumed" : "flow_not_active",
          "Auth flow is no longer accepting submissions",
        );
      }
      throw paramError("flow_not_found", "Unknown auth flow");
    }
    if (flow.connectionId !== connectionId) {
      throw paramError("flow_forbidden", "Auth flow belongs to another connection");
    }
    if (flow.mode !== "code" || flow.handle.submit === undefined) {
      throw paramError("flow_not_active", "Auth flow does not accept code submission");
    }
    if (flow.state === "submitting" || flow.state === "completed") {
      throw paramError("flow_consumed", "Authorization code was already submitted");
    }
    if (flow.state !== "pending") {
      throw paramError("flow_not_active", "Auth flow is no longer active");
    }

    // Atomic state transition before awaiting driver.
    flow.state = "submitting";
    this.#log.info("agent_auth_submitting", { agent: flow.agent, flowId });

    let outcome: { ok: true } | { ok: false; reason: AgentAuthFailureReason };
    try {
      outcome = await flow.handle.submit(code);
    } catch (error) {
      outcome = { ok: false, reason: toFailureReason(error) };
    }

    if (!outcome.ok) {
      this.#finishFlow(flow, "completed", "consumed", {
        flowId: flow.flowId,
        agent: flow.agent,
        ok: false,
        reason: outcome.reason,
      });
      await Promise.resolve(flow.handle.cancel()).catch(() => {});
      throw authError(outcome.reason, "Authorization code submission failed");
    }

    return { ok: true };
  }

  async cancel(connectionId: string, flowId: string): Promise<void> {
    const flow = this.#flowsById.get(flowId);
    if (flow === undefined) {
      const finished = this.#finishedFlows.get(flowId);
      if (finished !== undefined) {
        if (finished.connectionId !== connectionId) {
          throw paramError("flow_forbidden", "Auth flow belongs to another connection");
        }
        throw paramError("flow_not_active", "Auth flow is no longer active");
      }
      throw paramError("flow_not_found", "Unknown auth flow");
    }
    if (flow.connectionId !== connectionId) {
      throw paramError("flow_forbidden", "Auth flow belongs to another connection");
    }
    if (flow.state !== "pending") {
      throw paramError("flow_not_active", "Auth flow can no longer be cancelled");
    }

    this.#finishFlow(flow, "cancelled", "inactive", {
      flowId: flow.flowId,
      agent: flow.agent,
      ok: false,
      reason: "cancelled",
    });
    this.#log.info("agent_auth_cancelled", { agent: flow.agent, flowId });
    await Promise.resolve(flow.handle.cancel()).catch(() => {});
  }

  async logout(
    agent: string,
    provider: AgentSetupProvider,
    onSignedOut: () => Promise<void> | void,
  ): Promise<void> {
    if (this.#closed) throw authError("cancelled", "Daemon is shutting down");
    if (!provider.canSignOut() || provider.authDriver?.logout === undefined) {
      throw paramError("unsupported_mode", "Sign-out is not supported for this agent");
    }
    if (this.#activeByAgent.has(agent)) {
      throw authError("auth_in_progress", "An authentication operation is already in progress");
    }

    const entry: ActiveEntry = { kind: "logout" };
    this.#activeByAgent.set(agent, entry);
    this.#onChanged(agent);

    try {
      await provider.authDriver.logout();
      provider.authDriver.invalidateCache?.();
      await onSignedOut();
      this.#log.info("agent_signed_out", { agent });
    } catch (error) {
      const reason = toFailureReason(error);
      this.#log.warn("agent_sign_out_failed", { agent, reason });
      throw authError(reason, "Failed to sign out");
    } finally {
      if (this.#activeByAgent.get(agent) === entry) this.#activeByAgent.delete(agent);
      this.#onChanged(agent);
    }
  }

  /** Immediately tears down any active auth flows started by a disconnected client. */
  onConnectionClosed(connectionId: string): void {
    // Cancel any in-flight start placeholder for this connection so it aborts when driver resolves.
    for (const [agent, entry] of this.#activeByAgent) {
      if (entry.kind === "starting" && entry.connectionId === connectionId) {
        this.#activeByAgent.delete(agent);
      }
    }
    const owned = [...this.#flowsById.values()].filter((f) => f.connectionId === connectionId);
    for (const flow of owned) {
      this.#detachFlow(flow, "cancelled", "inactive");
      this.#log.info("agent_auth_aborted_disconnect", { agent: flow.agent, flowId: flow.flowId });
      void Promise.resolve(flow.handle.cancel()).catch(() => {});
      this.#onChanged(flow.agent);
    }
  }

  /** Stops all active auth flows and waits for their subprocesses to terminate (`daemon.close()`). */
  async close(): Promise<void> {
    this.#closed = true;
    const flows = [...this.#flowsById.values()];
    this.#flowsById.clear();
    this.#activeByAgent.clear();
    await Promise.all(
      flows.map(async (flow) => {
        clearTimeout(flow.timer);
        if (flow.state === "pending" || flow.state === "submitting") {
          flow.state = "cancelled";
          this.#recordFinished(flow.flowId, flow.connectionId, "inactive");
        }
        await Promise.resolve(flow.handle.cancel()).catch(() => {});
      }),
    );
  }

  async #expire(flowId: string): Promise<void> {
    const flow = this.#flowsById.get(flowId);
    if (flow === undefined) return;
    if (flow.state !== "pending" && flow.state !== "submitting") return;
    this.#finishFlow(flow, "expired", "inactive", {
      flowId: flow.flowId,
      agent: flow.agent,
      ok: false,
      reason: "expired",
    });
    this.#log.info("agent_auth_expired", { agent: flow.agent, flowId });
    await Promise.resolve(flow.handle.cancel()).catch(() => {});
  }

  #onFlowSettled(
    flow: ActiveFlow,
    outcome: { ok: true } | { ok: false; reason: AgentAuthFailureReason },
  ): void {
    if (flow.state !== "pending" && flow.state !== "submitting") return;
    const finishedOutcome = flow.state === "submitting" || outcome.ok ? "consumed" : "inactive";
    flow.invalidateCache?.();
    this.#finishFlow(flow, "completed", finishedOutcome, {
      flowId: flow.flowId,
      agent: flow.agent,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { reason: outcome.reason }),
    });
    this.#log.info("agent_auth_completed", {
      agent: flow.agent,
      flowId: flow.flowId,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { reason: outcome.reason }),
    });
  }

  #finishFlow(
    flow: ActiveFlow,
    nextState: "cancelled" | "expired" | "completed",
    finishedOutcome: "consumed" | "inactive",
    payload: AgentAuthCompleted,
  ): void {
    this.#detachFlow(flow, nextState, finishedOutcome);
    this.#onCompleted(flow.connectionId, payload);
    this.#onChanged(flow.agent);
  }

  #detachFlow(
    flow: ActiveFlow,
    nextState: "cancelled" | "expired" | "completed",
    finishedOutcome: "consumed" | "inactive",
  ): void {
    clearTimeout(flow.timer);
    flow.state = nextState;
    this.#flowsById.delete(flow.flowId);
    if (this.#activeByAgent.get(flow.agent) === flow) {
      this.#activeByAgent.delete(flow.agent);
    }
    this.#recordFinished(flow.flowId, flow.connectionId, finishedOutcome);
  }

  #recordFinished(flowId: string, connectionId: string, outcome: "consumed" | "inactive"): void {
    this.#finishedFlows.set(flowId, { connectionId, outcome });
    if (this.#finishedFlows.size > FINISHED_FLOW_CAP) {
      const oldest = this.#finishedFlows.keys().next().value;
      if (oldest !== undefined) this.#finishedFlows.delete(oldest);
    }
  }
}
