// The environments: their status, their agents and those agents' defaults and plan usage, and adding or removing one.
import type {
  AgentAuthLogoutAnswer,
  AgentAuthStartAnswer,
  AgentAuthSubmitAnswer,
  AgentInfo,
  AgentRuntimePatchValue,
  AppEvent,
  EnvironmentConfig,
  EnvironmentStatus,
  PlanUsage,
} from "../api.ts";
import { messageOf, type StoreKit } from "./core.ts";

/** Each agent's plan usage, the newer of the two where both have one: an answer can come after a change it predates. */
const newerPlanUsage = (
  known: Record<string, PlanUsage> | undefined,
  told: Record<string, PlanUsage>,
): Record<string, PlanUsage> => {
  const next = { ...known };
  for (const [agent, usage] of Object.entries(told)) {
    const was = next[agent];
    if (was === undefined || was.at <= usage.at) next[agent] = usage;
  }
  return next;
};

/** True when a live `config_option_update` reports a model list that differs from the cached agent schema. */
const hasNewModelCatalog = (
  agents: readonly AgentInfo[] | undefined,
  agentId: string | undefined,
  update: unknown,
): boolean => {
  const u = update as {
    sessionUpdate?: string;
    configOptions?: {
      configId?: string;
      options?: { value?: unknown; _meta?: Record<string, unknown> }[];
    }[];
  };
  if (u.sessionUpdate !== "config_option_update" || !Array.isArray(u.configOptions)) return false;
  const modelOpt = u.configOptions.find((o) => o.configId === "model");
  if (!Array.isArray(modelOpt?.options)) return false;
  const incoming = modelOpt.options
    .filter(
      (c): c is { value: string; _meta?: Record<string, unknown> } =>
        typeof c?.value === "string" && c.value !== "" && c._meta?.["cycle/custom"] !== true,
    )
    .map((c) => c.value);
  if (incoming.length === 0) return false;
  const agent = agentId !== undefined ? agents?.find((a) => a.id === agentId) : undefined;
  const properties = (
    agent?.configSchema as { properties?: Record<string, { oneOf?: { const?: unknown }[] }> }
  )?.properties;
  const existing = (properties?.model?.oneOf ?? [])
    .map((c) => c.const)
    .filter((v): v is string => typeof v === "string");
  if (existing.length !== incoming.length) return true;
  return incoming.some((value, index) => existing[index] !== value);
};

const toStatus = (event: AppEvent & { type: "environment-status" }): EnvironmentStatus => ({
  environmentId: event.environmentId,
  state: event.state,
  ...(event.error !== undefined ? { error: event.error } : {}),
  ...(event.daemon !== undefined ? { daemon: event.daemon } : {}),
  ...(event.incompatible !== undefined ? { incompatible: event.incompatible } : {}),
  ...(event.capabilities !== undefined ? { capabilities: event.capabilities } : {}),
});

export class EnvironmentsSlice {
  readonly #kit: StoreKit;
  /** Told when an environment's agents have been read: a blank conversation on it may be waiting for them. */
  readonly #agentsRead: (environmentId: string) => void;
  /** In-flight `agents()` refreshes per environment, coalesced so bursts never spam the daemon. */
  readonly #loadingAgents = new Map<string, Promise<void>>();
  /**
   * How many plan-usage events each environment has had: a read's answer does not replace one told while it was
   * asked. Counted here, not by time: a remote daemon's clock is not this one's.
   */
  readonly #planEvents = new Map<string, number>();

  constructor(kit: StoreKit, agentsRead: (environmentId: string) => void) {
    this.#kit = kit;
    this.#agentsRead = agentsRead;
  }

  /** The environments, their status and their sessions as main has them, and the agents of those that are connected. */
  async load(): Promise<void> {
    const { bridge, set, attempt, state } = this.#kit;
    await attempt(async () => {
      const { environments, status, sessions } = await bridge.environments();
      set({
        environments,
        status: Object.fromEntries(status.map((s) => [s.environmentId, s])),
        // What main has read so far, also from an environment that has since gone away.
        sessions,
        selectedEnvironment: state().selectedEnvironment ?? environments[0]?.id,
      });
      // Main connects every environment: the agents of those that already are, now; of the others, when each connects.
      await Promise.all(
        status.filter((s) => s.state === "connected").map((s) => this.loadAgents(s.environmentId)),
      );
    });
  }

  /** An environment's status, as main told it. True when it has just connected. */
  statusTold(event: AppEvent & { type: "environment-status" }): boolean {
    const was = this.#kit.state().status[event.environmentId]?.state;
    this.#kit.set((s) => ({ status: { ...s.status, [event.environmentId]: toStatus(event) } }));
    const connected = event.state === "connected" && was !== "connected";
    if (connected) void this.loadAgents(event.environmentId);
    return connected;
  }

  /** An agent's defaults changed there: a form that shows them reads them again. */
  defaultsChanged(environmentId: string): void {
    this.#kit.set((s) => ({
      defaultsRevision: {
        ...s.defaultsRevision,
        [environmentId]: (s.defaultsRevision[environmentId] ?? 0) + 1,
      },
    }));
  }

  /** An agent's setup changed there (`_cycle/agent_setup_changed`): its Harness page reads it again. */
  setupChanged(environmentId: string, agent: string): void {
    this.#kit.set((s) => {
      const key = `${environmentId}:${agent}`;
      return {
        agentSetupRevision: {
          ...s.agentSetupRevision,
          [key]: (s.agentSetupRevision[key] ?? 0) + 1,
        },
      };
    });
  }

  /** A sign-in this window started ended: its dialog hears how, and the agent's page reads its setup again. */
  authCompleted(event: AppEvent & { type: "agent-auth-completed" }): void {
    this.#kit.set((s) => {
      const flowKey = `${event.environmentId}:${event.flowId}`;
      const setupKey = `${event.environmentId}:${event.agent}`;
      const completions: typeof s.agentAuthCompletions = {
        ...s.agentAuthCompletions,
        [flowKey]: {
          ok: event.ok,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
      // Only the latest few are kept: a dialog reads its own flow's at once.
      const keys = Object.keys(completions);
      for (const oldest of keys.slice(0, Math.max(0, keys.length - 50))) delete completions[oldest];
      return {
        agentAuthCompletions: completions,
        agentSetupRevision: {
          ...s.agentSetupRevision,
          [setupKey]: (s.agentSetupRevision[setupKey] ?? 0) + 1,
        },
      };
    });
  }

  planUsageTold(event: AppEvent & { type: "plan-usage" }): void {
    this.#planEvents.set(event.environmentId, (this.#planEvents.get(event.environmentId) ?? 0) + 1);
    this.#kit.set((s) => ({
      planUsage: {
        ...s.planUsage,
        [event.environmentId]: newerPlanUsage(s.planUsage[event.environmentId], {
          [event.agent]: event.usage,
        }),
      },
    }));
  }

  /** A session's update was applied: one that says its agent has other models now has the agents read again. */
  sessionUpdated(event: AppEvent & { type: "update" }): void {
    const state = this.#kit.state();
    if (state.status[event.environmentId]?.state !== "connected") return;
    const agentId = state.sessions[event.environmentId]?.find(
      (s) => s.sessionId === event.sessionId,
    )?.agent;
    if (hasNewModelCatalog(state.agents[event.environmentId], agentId, event.update))
      void this.loadAgents(event.environmentId);
  }

  /** Asks main to connect to an environment again. Why it cannot is in the environment's status, not in an error to dismiss. */
  connect = async (environmentId: string): Promise<void> => {
    try {
      await this.#kit.bridge.connect(environmentId);
    } catch {
      // The status says why.
    }
  };

  /** Reads the environment's agents again, e.g. after credentials or binaries are fixed. */
  loadAgents = (environmentId: string): Promise<void> => {
    const inflight = this.#loadingAgents.get(environmentId);
    if (inflight !== undefined) return inflight;
    const { bridge, set, attempt } = this.#kit;
    const load = (async () => {
      await attempt(async () => {
        const agents = await bridge.agents(environmentId);
        set((s) => ({ agents: { ...s.agents, [environmentId]: agents } }));
      });
      // What the daemon has of its agents' plan limits, on this connection: it replaces what was kept from before (a
      // daemon that restarted, or an agent signed in otherwise, has none), but not a change told while it was asked.
      const before = this.#planEvents.get(environmentId) ?? 0;
      void bridge
        .planUsage(environmentId)
        .then((told) =>
          set((s) => {
            const meanwhile = (this.#planEvents.get(environmentId) ?? 0) !== before;
            // Both come from the same daemon, so their times compare.
            const heard = meanwhile ? s.planUsage[environmentId] : undefined;
            return { planUsage: { ...s.planUsage, [environmentId]: newerPlanUsage(heard, told) } };
          }),
        )
        .catch(() => undefined);
      this.#agentsRead(environmentId);
    })().finally(() => {
      this.#loadingAgents.delete(environmentId);
    });
    this.#loadingAgents.set(environmentId, load);
    return load;
  };

  save = async (environment: EnvironmentConfig): Promise<string | undefined> => {
    try {
      await this.#kit.bridge.saveEnvironment(environment);
    } catch (error) {
      return messageOf(error);
    }
    // An environment that is added is connected at once, as every environment is when the app starts.
    await this.connect(environment.id);
    return undefined;
  };

  remove = async (environmentId: string): Promise<string | undefined> => {
    const { bridge, set, drafts, sidePanels } = this.#kit;
    try {
      await bridge.removeEnvironment(environmentId);
    } catch (error) {
      return messageOf(error);
    }
    drafts.forgetEnvironment(environmentId);
    sidePanels.forgetEnvironment(environmentId);
    set((s) => {
      const { [environmentId]: _sessions, ...sessions } = s.sessions;
      const { [environmentId]: _agents, ...agents } = s.agents;
      const { [environmentId]: _status, ...status } = s.status;
      const { [environmentId]: _plan, ...planUsage } = s.planUsage;
      const views = Object.fromEntries(
        Object.entries(s.views).filter(([, view]) => view.environmentId !== environmentId),
      );
      const terminals = Object.fromEntries(
        Object.entries(s.terminals).filter(([key]) => !key.startsWith(`${environmentId}:`)),
      );
      const open = s.selectedEnvironment === environmentId;
      return {
        terminals,
        ...(s.blank?.environmentId === environmentId ? { blank: undefined } : {}),
        sessions,
        agents,
        status,
        planUsage,
        views,
        ...(open
          ? {
              selectedEnvironment: s.environments.find((h) => h.id !== environmentId)?.id,
              selectedSession: undefined,
            }
          : {}),
      };
    });
    return undefined;
  };

  readAgentDefaults = (
    environmentId: string,
    agent: string,
  ): Promise<Record<string, string> | undefined> =>
    // A read that failed is told as one (and not as "nothing saved"): what is saved over a failed read would be the near-empty form.
    this.#kit.bridge.agentDefaults(environmentId, agent).catch((error: unknown) => {
      this.#kit.set({ error: messageOf(error) });
      throw error;
    });

  /** Whether they were saved: what went wrong is shown as any other error. */
  setAgentDefaults = async (
    environmentId: string,
    agent: string,
    config: Record<string, string>,
  ): Promise<boolean> =>
    (await this.#kit.attempt(async () => {
      await this.#kit.bridge.setAgentDefaults(environmentId, agent, config);
      return true;
    })) === true;

  // ---- an agent's setup and account (Settings → Harness) ----

  /** Read-only Harness setup snapshot (auth, usage, runtime config, host diagnostics). */
  readAgentSetup = (
    environmentId: string,
    agent: string,
    options?: { refreshUsage?: boolean; forceRefresh?: boolean },
  ) => this.#kit.bridge.readAgentSetup(environmentId, agent, options);

  setAgentRuntimeSettings = (
    environmentId: string,
    agent: string,
    patch: Record<string, AgentRuntimePatchValue>,
    expectedRevision: number,
  ) => this.#kit.bridge.setAgentRuntimeSettings(environmentId, agent, patch, expectedRevision);

  /** Shows the local daemon's `config.json` in the system file manager; false on remote environments. */
  revealDaemonConfig = (environmentId: string): Promise<boolean> =>
    this.#kit.bridge.revealDaemonConfig(environmentId).catch(() => false);

  // A sign-in call the bridge refused (the window's IPC failed) is an answer the dialog shows, not a dialog left
  // waiting: main already turns every daemon failure into a reason, so only the bridge itself can throw here.
  startAgentAuth = (environmentId: string, agent: string): Promise<AgentAuthStartAnswer> =>
    this.#kit.bridge
      .startAgentAuth(environmentId, agent)
      .catch((): AgentAuthStartAnswer => ({ started: false, reason: "failed" }));

  openAgentAuthUrl = (environmentId: string, flowId: string): Promise<boolean> =>
    this.#kit.bridge.openAgentAuthUrl(environmentId, flowId).catch(() => false);

  submitAgentAuth = (
    environmentId: string,
    flowId: string,
    code: string,
  ): Promise<AgentAuthSubmitAnswer> =>
    this.#kit.bridge
      .submitAgentAuth(environmentId, flowId, code)
      .catch((): AgentAuthSubmitAnswer => ({ ok: false, reason: "failed" }));

  cancelAgentAuth = (environmentId: string, flowId: string): Promise<void> =>
    this.#kit.bridge.cancelAgentAuth(environmentId, flowId).catch(() => undefined);

  logoutAgent = (environmentId: string, agent: string): Promise<AgentAuthLogoutAnswer> =>
    this.#kit.bridge
      .logoutAgent(environmentId, agent)
      .catch((): AgentAuthLogoutAnswer => ({ ok: false, reason: "failed" }));
}
