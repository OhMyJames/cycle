import type {
  AgentRuntimePatchValue,
  LocationConfig,
  SessionSnapshot,
  SessionSummary,
} from "@cycle/ui";
import { LocationActions } from "./actions.ts";
import { AgentAuthFlows } from "./agent-auth-flows.ts";
import type { ManagerApi } from "./dispatch.ts";
import { Environments, memoryEnvironments } from "./environments.ts";
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
 * A facade over four parts: the connections and locations (`Runtime`, runtime.ts), the session lists and the
 * sessions being watched (`SessionWatcher`, watcher.ts), what the agents wait on the person for (`PendingStore`,
 * pending.ts), and what the page asks of one location (`LocationActions`, actions.ts). Those it inherits, so the
 * page's many calls to a location are not restated here; the rest it passes on.
 */
export class ConnectionManager extends LocationActions implements ManagerApi {
  readonly #runtime: Runtime;
  readonly #watcher: SessionWatcher;
  readonly #pending: PendingStore;
  readonly #auth: AgentAuthFlows;

  constructor(options: ManagerOptions) {
    // The runtime builds each connection and hands what happens in its sessions to the watcher and the pending store.
    const runtime: Runtime = new Runtime(options, {
      sessionEvents: (locationId, connection) => ({
        update: (sessionId, update, _seq, at) =>
          watcher.update(locationId, connection, sessionId, update, at),
        permission: (sessionId, request, requestId) =>
          pending.ask(locationId, connection, sessionId, request, requestId),
        // Saying this is saying the app can show a form: the daemon then asks it the agent's questions.
        elicitation: (sessionId, request, requestId) =>
          pending.askForm(locationId, connection, sessionId, request, requestId),
        resolved: (sessionId, requestId) =>
          pending.resolved(locationId, connection, sessionId, String(requestId)),
        gone: (sessionId) => watcher.gone(locationId, connection, sessionId),
        // A history that cannot be read after a reconnect: nothing more comes to it, the list row says why.
        unreadable: (sessionId) => watcher.unreadable(connection, sessionId),
        resumed: (sessionId, waiting) =>
          pending.dropStale(locationId, connection, sessionId, waiting),
      }),
      refresh: (locationId, connection, afterOutage) =>
        watcher.refresh(locationId, connection, afterOutage),
      lost: (connection) => pending.markStale(connection),
      dropped: (connection, cancel) => pending.release(connection, { cancel }),
      authCompleted: (locationId, completed) => auth.completed(locationId, completed),
      authLost: (locationId) => auth.lost(locationId),
    });
    const auth = new AgentAuthFlows(runtime);
    const pending = new PendingStore(runtime);
    const watcher = new SessionWatcher(runtime, pending);
    super(
      runtime,
      watcher,
      new Environments(options.environments ?? memoryEnvironments(), (name, props) =>
        options.track?.(name, props),
      ),
    );
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

  // ---- locations ----

  async locations() {
    return this.#runtime.snapshot();
  }

  connectAll(): Promise<void> {
    return this.#runtime.connectAll();
  }

  saveLocation(location: LocationConfig): Promise<void> {
    return this.#runtime.saveLocation(location);
  }

  removeLocation(locationId: string): Promise<void> {
    return this.#runtime.removeLocation(locationId);
  }

  connect(locationId: string): Promise<void> {
    return this.#runtime.connect(locationId);
  }

  disconnect(locationId: string): Promise<void> {
    return this.#runtime.disconnect(locationId);
  }

  upgradeDaemon(locationId: string, when?: unknown): Promise<void> {
    return this.#runtime.upgradeDaemon(locationId, when);
  }

  // ---- sessions ----

  async sessions(locationId: string): Promise<SessionSummary[]> {
    return this.#watcher.refresh(locationId, this.#runtime.connection(locationId));
  }

  openSession(locationId: string, sessionId: string): Promise<SessionSnapshot> {
    return this.#watcher.open(locationId, sessionId);
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
    locationId: string,
    agent: string,
    options?: { refreshUsage?: boolean; forceRefresh?: boolean },
  ) {
    return this.#auth.readAgentSetup(locationId, agent, options);
  }

  prewarmAgent(locationId: string, agent: string) {
    return this.#auth.prewarmAgent(locationId, agent);
  }

  setAgentRuntimeSettings(
    locationId: string,
    agent: string,
    patch: Record<string, AgentRuntimePatchValue>,
    expectedRevision: number,
  ) {
    return this.#auth.setAgentRuntimeSettings(locationId, agent, patch, expectedRevision);
  }

  revealDaemonConfig(locationId: string) {
    return this.#auth.revealDaemonConfig(locationId);
  }

  startAgentAuth(locationId: string, agent: string) {
    return this.#auth.startAgentAuth(locationId, agent);
  }

  openAgentAuthUrl(locationId: string, flowId: string) {
    return this.#auth.openAgentAuthUrl(locationId, flowId);
  }

  submitAgentAuth(locationId: string, flowId: string, code: string) {
    return this.#auth.submitAgentAuth(locationId, flowId, code);
  }

  cancelAgentAuth(locationId: string, flowId: string) {
    return this.#auth.cancelAgentAuth(locationId, flowId);
  }

  logoutAgent(locationId: string, agent: string) {
    return this.#auth.logoutAgent(locationId, agent);
  }

  // ---- environments (environments.ts) ----

  environments() {
    return this.environmentStore.list();
  }

  saveEnvironment(environment: unknown) {
    return this.environmentStore.save(environment);
  }

  removeEnvironment(environmentId: unknown) {
    return this.environmentStore.remove(environmentId);
  }

  setEnvironmentDefault(locationId: unknown, cwd: unknown, environmentId: unknown) {
    return this.environmentStore.setDefault(locationId, cwd, environmentId);
  }

  chooseDirectory(): Promise<string | undefined> {
    return this.#runtime.options.chooseDirectory?.() ?? Promise.resolve(undefined);
  }
}
