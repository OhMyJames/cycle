import type {
  AgentRuntimePatchValue,
  EnvironmentConfig,
  SessionSnapshot,
  SessionSummary,
} from "@cycle/ui";
import { EnvironmentActions } from "./actions.ts";
import { AgentAuthFlows } from "./agent-auth-flows.ts";
import type { ManagerApi } from "./dispatch.ts";
import { PendingStore } from "./pending.ts";
import { type ManagerOptions, Runtime } from "./runtime.ts";
import { SessionWatcher } from "./watcher.ts";

export { connectorProblemOf, pluginProblemOf, terminalProblemOf } from "./actions.ts";
export { formAnswerOf } from "./pending.ts";
export type { ManagerOptions, Tracker } from "./runtime.ts";
export type { AttentionNotice } from "./watcher.ts";

/**
 * The main process's half of the app: the connections to daemons, and the state of every session
 * being watched. It is what the renderer can ask for beyond main's own methods (`ManagerApi`) and knows nothing of
 * Electron, so it is tested against a real daemon without a window.
 *
 * A facade over four parts: the connections and environments (`Runtime`, runtime.ts), the session lists and the
 * sessions being watched (`SessionWatcher`, watcher.ts), what the agents wait on the person for (`PendingStore`,
 * pending.ts), and what the page asks of one environment (`EnvironmentActions`, actions.ts). Those it inherits, so the
 * page's many calls to an environment are not restated here; the rest it passes on.
 */
export class ConnectionManager extends EnvironmentActions implements ManagerApi {
  readonly #runtime: Runtime;
  readonly #watcher: SessionWatcher;
  readonly #pending: PendingStore;
  readonly #auth: AgentAuthFlows;

  constructor(options: ManagerOptions) {
    // The runtime builds each connection and hands what happens in its sessions to the watcher and the pending store.
    const runtime: Runtime = new Runtime(options, {
      sessionEvents: (environmentId, connection) => ({
        update: (sessionId, update, _seq, at) =>
          watcher.update(environmentId, connection, sessionId, update, at),
        permission: (sessionId, request, requestId) =>
          pending.ask(environmentId, connection, sessionId, request, requestId),
        // Saying this is saying the app can show a form: the daemon then asks it the agent's questions.
        elicitation: (sessionId, request, requestId) =>
          pending.askForm(environmentId, connection, sessionId, request, requestId),
        resolved: (sessionId, requestId) =>
          pending.resolved(environmentId, connection, sessionId, String(requestId)),
        gone: (sessionId) => watcher.gone(environmentId, connection, sessionId),
        // A history that cannot be read after a reconnect: nothing more comes to it, the list row says why.
        unreadable: (sessionId) => watcher.unreadable(connection, sessionId),
        resumed: (sessionId, waiting) =>
          pending.dropStale(environmentId, connection, sessionId, waiting),
      }),
      refresh: (environmentId, connection, afterOutage) =>
        watcher.refresh(environmentId, connection, afterOutage),
      lost: (connection) => pending.markStale(connection),
      dropped: (connection, cancel) => pending.release(connection, { cancel }),
      authCompleted: (environmentId, completed) => auth.completed(environmentId, completed),
      authLost: (environmentId) => auth.lost(environmentId),
    });
    const auth = new AgentAuthFlows(runtime);
    const pending = new PendingStore(runtime);
    const watcher = new SessionWatcher(runtime, pending);
    super(runtime, watcher);
    this.#runtime = runtime;
    this.#watcher = watcher;
    this.#pending = pending;
    this.#auth = auth;
  }

  init(): Promise<void> {
    return this.#runtime.init();
  }

  async close(): Promise<void> {
    await this.cancelConnectorAuth();
    await this.#runtime.close();
  }

  // ---- environments ----

  async environments() {
    return this.#runtime.snapshot();
  }

  connectAll(): Promise<void> {
    return this.#runtime.connectAll();
  }

  saveEnvironment(environment: EnvironmentConfig): Promise<void> {
    return this.#runtime.saveEnvironment(environment);
  }

  removeEnvironment(environmentId: string): Promise<void> {
    return this.#runtime.removeEnvironment(environmentId);
  }

  connect(environmentId: string): Promise<void> {
    return this.#runtime.connect(environmentId);
  }

  disconnect(environmentId: string): Promise<void> {
    return this.#runtime.disconnect(environmentId);
  }

  upgradeDaemon(environmentId: string, when?: unknown): Promise<void> {
    return this.#runtime.upgradeDaemon(environmentId, when);
  }

  // ---- sessions ----

  async sessions(environmentId: string): Promise<SessionSummary[]> {
    return this.#watcher.refresh(environmentId, this.#runtime.connection(environmentId));
  }

  openSession(environmentId: string, sessionId: string): Promise<SessionSnapshot> {
    return this.#watcher.open(environmentId, sessionId);
  }

  // ---- permissions and forms ----

  answerPermission(key: string, optionId: string | "cancelled"): Promise<void> {
    return this.#pending.answer(key, optionId);
  }

  answerForm(key: string, answer: unknown): Promise<void> {
    return this.#pending.answerForm(key, answer);
  }

  // ---- an agent's setup and account (agent-auth-flows.ts) ----

  readAgentSetup(
    environmentId: string,
    agent: string,
    options?: { refreshUsage?: boolean; forceRefresh?: boolean },
  ) {
    return this.#auth.readAgentSetup(environmentId, agent, options);
  }

  setAgentRuntimeSettings(
    environmentId: string,
    agent: string,
    patch: Record<string, AgentRuntimePatchValue>,
    expectedRevision: number,
  ) {
    return this.#auth.setAgentRuntimeSettings(environmentId, agent, patch, expectedRevision);
  }

  revealDaemonConfig(environmentId: string) {
    return this.#auth.revealDaemonConfig(environmentId);
  }

  startAgentAuth(environmentId: string, agent: string) {
    return this.#auth.startAgentAuth(environmentId, agent);
  }

  openAgentAuthUrl(environmentId: string, flowId: string) {
    return this.#auth.openAgentAuthUrl(environmentId, flowId);
  }

  submitAgentAuth(environmentId: string, flowId: string, code: string) {
    return this.#auth.submitAgentAuth(environmentId, flowId, code);
  }

  cancelAgentAuth(environmentId: string, flowId: string) {
    return this.#auth.cancelAgentAuth(environmentId, flowId);
  }

  logoutAgent(environmentId: string, agent: string) {
    return this.#auth.logoutAgent(environmentId, agent);
  }

  chooseDirectory(): Promise<string | undefined> {
    return this.#runtime.options.chooseDirectory?.() ?? Promise.resolve(undefined);
  }
}
