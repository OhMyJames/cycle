// The connections to daemons: the environments there are, connecting to each, its status, and updating its daemon.
// What a connection holds of its sessions is the watcher's (watcher.ts) and the pending store's (pending.ts); this
// file only builds the connection and hands their events to them (RuntimeHooks).
import { type AgentWord, agentOf, type EventName, type EventProps } from "@cycle/analytics/events";
import { type Channel, type ClientEvents, CycleClient, ProtocolMismatchError } from "@cycle/client";
import type { AppEvent, EnvironmentConfig, EnvironmentStatus, SessionSummary } from "@cycle/ui";
import { type DaemonStop, daemonTooOld, daemonUpgradeCommand } from "../shared/release.ts";
import type { OpenBrowser } from "./connector-auth.ts";
import { environmentOf, LOCAL_ENVIRONMENT, type Settings } from "./settings.ts";
import type { AttentionNotice, Watched } from "./watcher.ts";

export type ManagerOptions = {
  settings: Settings;
  /** How to reach an environment. The one place that knows about ssh, a local proxy, or a test socket. */
  channelFor: (environment: EnvironmentConfig) => () => Promise<Channel>;
  emit: (event: AppEvent) => void;
  chooseDirectory?: () => Promise<string | undefined>;
  /** Shows a local file in the OS file manager (`shell.showItemInFolder`). */
  revealPath?: (path: string) => void;
  backoff?: { first: number; max: number };
  /** The version of this app: the one an update of a daemon puts there. Without it, nothing is said. */
  appVersion?: string;
  /** The Cycle protocol version asked of a daemon. Default: this build's. Another is for tests. */
  protocolVersion?: string;
  /**
   * Runs a shell command on the machine of a remote environment (over its ssh) and resolves when it succeeded; rejects
   * with what went wrong. Without it, a daemon cannot be updated from the app, only by hand.
   */
  runOnHost?: (environment: EnvironmentConfig, command: string) => Promise<void>;
  /** How long after a daemon update to wait for the connection to drop and come back before giving up on it (ms). */
  settle?: number;
  /** A session changed in a way worth telling (it asks, it is done, its agent is gone). Without it, nothing is said. */
  attention?: (notice: AttentionNotice) => void;
  /** What the person does, for product analytics (docs/analytics.md). Without it, nothing is reported. */
  track?: Tracker;
  /** Opens a connector's sign-in page in the person's browser. Without it, signing in fails. */
  openBrowser?: OpenBrowser;
  /** How long a sign-in waits for the browser. Default ten minutes. */
  authTimeoutMs?: number;
  /**
   * Whether the person wants the agent to suggest what to say next (Settings, CYCL-225): said with every prompt. Without
   * it, nothing is said, and the daemon keeps what it was told last.
   */
  promptSuggestions?: () => boolean;
};

/** Reports one event of the dictionary in @cycle/analytics. */
export type Tracker = <N extends EventName>(name: N, props: EventProps<N>) => void;

export type Connection = {
  client: CycleClient;
  status: EnvironmentStatus;
  sessions: SessionSummary[];
  watched: Map<string, Watched>;
  opening: Map<string, Promise<void>>;
  /**
   * The folders of the sessions made on this connection. A session is not in the daemon's list until its first message
   * is on record (docs/protocol.md §6), and it is opened as that message goes: its folder is known from here meanwhile.
   */
  made: Map<string, string>;
  /** The agent each of them was asked for (what `agent` was, or nothing), for the reports about it before it is listed. */
  madeAgent: Map<string, string>;
  /** A list has been read on this connection: what is in the first says nothing, what appears later is new. */
  listed: boolean;
  /** Counts the rereads of the list, and the newest one applied: an older answer arriving late is not applied over it. */
  asked: number;
  applied: number;
};

/** The client events about what happens in sessions: the watcher's and the pending store's to answer. */
export type SessionEvents = Pick<
  ClientEvents,
  "update" | "permission" | "elicitation" | "resolved" | "gone" | "unreadable" | "resumed"
>;

/** What the runtime asks of the parts that hold a connection's sessions. */
export type RuntimeHooks = {
  sessionEvents: (environmentId: string, connection: Connection) => SessionEvents;
  /** Reads the session list again. `afterOutage`: the connection was away (see SessionWatcher.refresh). */
  refresh: (
    environmentId: string,
    connection: Connection,
    afterOutage?: boolean,
  ) => Promise<SessionSummary[]>;
  /** The connection is down for now: what it was asked may be answered elsewhere meanwhile. */
  lost: (connection: Connection) => void;
  /** The connection is no longer used. `cancel`: what waits on it is answered cancelled (it was closed here). */
  dropped: (connection: Connection, cancel: boolean) => void;
  /** A sign-in flow this connection started ended (`_cycle/agent_auth_completed`). */
  authCompleted: (
    environmentId: string,
    completed: Parameters<NonNullable<ClientEvents["agentAuthCompleted"]>>[0],
  ) => void;
  /** The environment's connection dropped or closed: the sign-in flows on it end. */
  authLost: (environmentId: string) => void;
};

type Upgrade = { running: true } | { error: string } | { waiting: true };

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** How a daemon update was asked for, as `daemon_upgraded` reports it: nothing was working, interrupt, or wait. */
const whenOf = (stop: DaemonStop): "idle" | "now" | "later" => (stop === "ask" ? "idle" : stop);

export class Runtime {
  readonly options: ManagerOptions;
  readonly #hooks: RuntimeHooks;
  #environments: EnvironmentConfig[] = [LOCAL_ENVIRONMENT];
  /** Environments whose daemon is being updated from here, and the last one's failure. */
  readonly #upgrading = new Map<string, Upgrade>();
  readonly #connections = new Map<string, Connection>();
  /** The last list read from each environment, kept when its connection goes: what the interface greys out. */
  readonly #lastSessions = new Map<string, SessionSummary[]>();
  /** Why the last attempt to connect to an environment failed, for a renderer that asks after the event went by. */
  readonly #lastError = new Map<string, string>();
  readonly #lastIncompatible = new Map<string, NonNullable<EnvironmentStatus["incompatible"]>>();

  constructor(options: ManagerOptions, hooks: RuntimeHooks) {
    this.options = options;
    this.#hooks = hooks;
  }

  async init(): Promise<void> {
    this.#environments = await this.options.settings.load();
  }

  track: Tracker = (name, props) => this.options.track?.(name, props);

  emit(event: AppEvent): void {
    this.options.emit(event);
  }

  kindOf(environmentId: string): "local" | "remote" {
    return this.#environments.find((e) => e.id === environmentId)?.kind ?? "remote";
  }

  nameOf(environmentId: string): string {
    return this.#environments.find((h) => h.id === environmentId)?.name ?? environmentId;
  }

  /** The agent of a session, as one of the words the dictionary has. */
  agentOf(environmentId: string, sessionId: string): AgentWord {
    const connection = this.#connections.get(environmentId);
    const row = connection?.sessions.find((s) => s.sessionId === sessionId);
    return agentOf(row?.agent ?? connection?.madeAgent.get(sessionId) ?? "");
  }

  connection(environmentId: string): Connection {
    const connection = this.#connections.get(environmentId);
    if (connection === undefined) throw new Error("Not connected to that environment");
    return connection;
  }

  /** Whether `connection` is still the one of its environment: not closed, removed or replaced since. */
  isCurrent(environmentId: string, connection: Connection): boolean {
    return this.#connections.get(environmentId) === connection;
  }

  /** Whether a list has been read from the environment, on this connection or one before. */
  hasListed(environmentId: string): boolean {
    return this.#lastSessions.has(environmentId);
  }

  /** The list just read from the environment, kept for when its connection goes. */
  keepSessions(environmentId: string, sessions: SessionSummary[]): void {
    this.#lastSessions.set(environmentId, sessions);
  }

  async close(): Promise<void> {
    for (const connection of this.#connections.values()) {
      this.#hooks.dropped(connection, false);
      await connection.client.close();
    }
    this.#connections.clear();
  }

  /** The environments, the status of each, and the last list read from each. */
  snapshot() {
    return {
      environments: this.#environments,
      status: this.#environments.map((environment): EnvironmentStatus => {
        const error = this.#lastError.get(environment.id);
        const incompatible = this.#lastIncompatible.get(environment.id);
        return (
          this.#connections.get(environment.id)?.status ?? {
            environmentId: environment.id,
            state: "closed",
            ...(error !== undefined ? { error } : {}),
            ...(incompatible !== undefined ? { incompatible } : {}),
          }
        );
      }),
      sessions: Object.fromEntries(this.#lastSessions),
    };
  }

  /**
   * Connects to every environment, each on its own: one that cannot be reached is closed, with why, and the others
   * are not held up by it. What is wrong with an environment is in its status; nothing is thrown.
   */
  async connectAll(): Promise<void> {
    await Promise.allSettled(this.#environments.map((environment) => this.connect(environment.id)));
  }

  /**
   * Changes to the list of environments go one at a time: each reads the list as the one before left
   * it, so two saves at once keep both, and a save and a removal keep what each meant.
   */
  #editing: Promise<unknown> = Promise.resolve();
  #edit(change: () => Promise<void>): Promise<void> {
    const run = this.#editing.then(() => change());
    this.#editing = run.catch(() => undefined);
    return run;
  }

  async saveEnvironment(environment: EnvironmentConfig): Promise<void> {
    if (environment.id === LOCAL_ENVIRONMENT.id)
      throw new Error("The local daemon cannot be changed");
    // What the page sends is not trusted: it is read as the file is, so what is not an environment this app can reach
    // (an address ssh would read as an option, a shape it does not know) is refused, and what is kept is what was read.
    const checked = environmentOf(environment);
    if (checked === undefined)
      throw new Error("That is not an environment this app can connect to");
    await this.#edit(async () => {
      const next = [...this.#environments.filter((h) => h.id !== checked.id), checked];
      // The list changes once it is kept: a save that fails leaves things as they were.
      await this.options.settings.save(next);
      this.#environments = next;
      // What it was refused for belongs to the host it was: a changed environment has not been tried yet.
      this.#lastIncompatible.delete(checked.id);
      this.emit({ type: "environments", environments: this.#environments });
    });
    this.track("environment_saved", { transport: "ssh" });
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    if (environmentId === LOCAL_ENVIRONMENT.id)
      throw new Error("The local daemon cannot be removed");
    // All of it in turn, the disconnecting too: a connect that comes while a removal waits its turn
    // finds the environment still listed, and the removal then closes what it opened.
    let kind: "local" | "remote" = "remote";
    await this.#edit(async () => {
      kind = this.kindOf(environmentId);
      await this.disconnect(environmentId);
      this.#lastSessions.delete(environmentId);
      this.#lastError.delete(environmentId);
      this.#lastIncompatible.delete(environmentId);
      const next = this.#environments.filter((h) => h.id !== environmentId);
      await this.options.settings.save(next);
      this.#environments = next;
      this.emit({ type: "environments", environments: this.#environments });
    });
    this.track("environment_removed", { kind });
  }

  async connect(environmentId: string): Promise<void> {
    const existing = this.#connections.get(environmentId);
    if (existing && existing.status.state !== "closed") return;
    if (existing !== undefined) this.#hooks.dropped(existing, false);
    const environment = this.#environments.find((h) => h.id === environmentId);
    if (environment === undefined) throw new Error(`No such environment: ${environmentId}`);

    const connection: Connection = {
      client: undefined as unknown as CycleClient,
      status: { environmentId, state: "connecting" },
      sessions: [],
      watched: new Map(),
      opening: new Map(),
      made: new Map(),
      madeAgent: new Map(),
      listed: false,
      asked: 0,
      applied: 0,
    };
    connection.client = new CycleClient({
      connect: this.options.channelFor(environment),
      name: "cycle-desktop",
      ackReturns: true,
      ...(this.options.protocolVersion !== undefined
        ? { protocolVersion: this.options.protocolVersion }
        : {}),
      ...(this.options.backoff !== undefined ? { backoff: this.options.backoff } : {}),
      events: {
        ...this.#hooks.sessionEvents(environmentId, connection),
        listChanged: () =>
          void this.#hooks.refresh(environmentId, connection).catch(() => undefined),
        defaultsChanged: (agent) => this.emit({ type: "agent-defaults", environmentId, agent }),
        agentSetupChanged: (agent, revision) =>
          this.emit({
            type: "agent-setup-changed",
            environmentId,
            agent,
            ...(revision !== undefined ? { revision } : {}),
          }),
        agentAuthCompleted: (completed) => this.#hooks.authCompleted(environmentId, completed),
        connectorsChanged: () => this.emit({ type: "connectors", environmentId }),
        pluginsChanged: (agentId) => this.emit({ type: "plugins", environmentId, agentId }),
        planUsage: (agent, usage) => this.emit({ type: "plan-usage", environmentId, agent, usage }),
        terminalsChanged: (sessionId, terminals) =>
          this.emit({ type: "terminals", environmentId, sessionId, terminals }),
        terminalOutput: (output) =>
          this.emit({ type: "terminal-output", environmentId, ...output }),
        terminalReset: (reset) => this.emit({ type: "terminal-reset", environmentId, ...reset }),
        connection: (state, error) => {
          // A connection that came back asks for the list again: it may have changed while away.
          const was = connection.status.state;
          if (state === was && error === undefined) return;
          const incompatible = this.#incompatibleOf(error, environment);
          connection.status = {
            environmentId,
            state,
            ...(error !== undefined ? { error: messageOf(error) } : {}),
            ...(incompatible !== undefined ? { incompatible } : {}),
            ...(state === "connected" ? this.#daemonOf(environment, connection.client) : {}),
            // What the daemon can do is known from the connection it said it on: a drop that comes back to the same
            // daemon does not take it away, or the box would stop queueing for as long as the line is down.
            ...(state === "connected"
              ? { capabilities: capabilitiesOf(connection.client) }
              : state === "reconnecting" && connection.status.capabilities !== undefined
                ? { capabilities: connection.status.capabilities }
                : {}),
          };
          this.emit({ type: "environment-status", ...connection.status });
          if (state !== "connecting")
            this.track("environment_connection", { kind: this.kindOf(environmentId), state });
          if (state === "reconnecting") this.#hooks.lost(connection);
          if (state === "reconnecting" || state === "closed") this.#hooks.authLost(environmentId);
          if (state === "connected" && was === "reconnecting") {
            void this.#hooks.refresh(environmentId, connection, true).catch(() => undefined);
          }
        },
      },
    });
    this.#connections.set(environmentId, connection);
    this.emit({ type: "environment-status", ...connection.status });
    try {
      await connection.client.start();
    } catch (error) {
      // Removed or replaced while it was starting: what is there now is not this attempt's to change.
      if (!this.isCurrent(environmentId, connection)) throw error;
      this.#connections.delete(environmentId);
      this.#hooks.dropped(connection, false);
      this.#lastError.set(environmentId, messageOf(error));
      const incompatible = this.#incompatibleOf(error, environment);
      if (incompatible !== undefined) this.#lastIncompatible.set(environmentId, incompatible);
      else this.#lastIncompatible.delete(environmentId);
      this.emit({
        type: "environment-status",
        environmentId,
        state: "closed",
        error: messageOf(error),
        ...(incompatible !== undefined ? { incompatible } : {}),
      });
      throw error;
    }
    this.#lastError.delete(environmentId);
    this.#lastIncompatible.delete(environmentId);
    try {
      await this.#hooks.refresh(environmentId, connection);
    } catch (error) {
      // A daemon that answers but cannot list is not usable: say so, instead of sitting connected with no list.
      const current = this.isCurrent(environmentId, connection);
      if (current) this.#connections.delete(environmentId);
      this.#hooks.dropped(connection, false);
      await connection.client.close().catch(() => undefined);
      if (!current) throw error;
      this.#lastError.set(environmentId, messageOf(error));
      this.emit({
        type: "environment-status",
        environmentId,
        state: "closed",
        error: messageOf(error),
      });
      throw error;
    }
  }

  /**
   * Why a connection was refused when the daemon speaks another major version of the protocol, and which side has to
   * change: the daemon when it is the older one (on a remote machine the command that updates it is given), the app
   * when it is the newer. Undefined for any other failure: a network that is down is not a version problem.
   */
  #incompatibleOf(
    error: unknown,
    environment: EnvironmentConfig,
  ): EnvironmentStatus["incompatible"] | undefined {
    if (!(error instanceof ProtocolMismatchError)) return undefined;
    const major = (version: string) => Number.parseInt(version.split(".")[0] ?? "", 10);
    const theirs = Math.max(...error.supported.map(major));
    const mine = major(error.requested);
    const side =
      Number.isNaN(theirs) || Number.isNaN(mine) || theirs === mine
        ? "unknown"
        : theirs < mine
          ? "daemon"
          : "app";
    const { appVersion } = this.options;
    return {
      with: side,
      supported: error.supported,
      requested: error.requested,
      ...(side === "daemon" && environment.kind !== "local" && appVersion !== undefined
        ? { command: daemonUpgradeCommand(appVersion) }
        : {}),
    };
  }

  /** What a connected remote environment's daemon is, and whether it is too old for this app to work with. */
  #daemonOf(
    environment: EnvironmentConfig,
    client: CycleClient,
  ): Pick<EnvironmentStatus, "daemon"> {
    const version = client.serverVersion;
    if (environment.kind === "local" || version === undefined) return {};
    const { appVersion } = this.options;
    const old = appVersion !== undefined && daemonTooOld(version);
    // A daemon that is no longer too old has been updated: what was said about the update is done with.
    if (!old) this.#upgrading.delete(environment.id);
    const doing = this.#upgrading.get(environment.id);
    return {
      daemon: {
        version,
        ...(old
          ? {
              upgrade: {
                to: appVersion,
                command: daemonUpgradeCommand(appVersion),
                ...(doing !== undefined ? doing : {}),
              },
            }
          : {}),
      },
    };
  }

  /**
   * Updates the daemon of a remote environment by running the command on its machine. The command stops the old daemon,
   * so the connection drops and comes back to the new one by itself (what is open stays open). A failure is said in the
   * status, with the command left there to run by hand.
   *
   * `when` is the person's answer when sessions there were working (docs/daemon.md "停止和升级"): `now` interrupts
   * them, `later` installs now and stops the old daemon once nothing is working, which the status says until then.
   * Without it nothing was working, and the stop refuses if something has started since.
   */
  async upgradeDaemon(environmentId: string, when?: unknown): Promise<void> {
    // From the page: only the words it may send.
    const stop: DaemonStop = when === "now" || when === "later" ? when : "ask";
    const connection = this.#connections.get(environmentId);
    const environment = this.#environments.find((e) => e.id === environmentId);
    const { runOnHost } = this.options;
    const upgrade = connection?.status.daemon?.upgrade;
    if (connection === undefined || environment === undefined || upgrade === undefined) return;
    // Only an update that is running holds a click back. After a failure the person tries again (the plain stop
    // refuses when sessions started working since, and they then choose); while it waits for the sessions, what is
    // left to choose is to interrupt them.
    const doing = this.#upgrading.get(environmentId);
    if (runOnHost === undefined || (doing !== undefined && "running" in doing)) return;
    if (doing !== undefined && "waiting" in doing && stop !== "now") return;
    // Kept here and not in the status, which every change of the connection builds anew.
    const say = (now: Upgrade | undefined) => {
      if (now === undefined) this.#upgrading.delete(environmentId);
      else this.#upgrading.set(environmentId, now);
      if (!this.isCurrent(environmentId, connection)) return;
      connection.status = {
        ...connection.status,
        ...this.#daemonOf(environment, connection.client),
      };
      this.emit({ type: "environment-status", ...connection.status });
    };
    say({ running: true });
    try {
      await runOnHost(environment, daemonUpgradeCommand(upgrade.to, stop));
    } catch (error) {
      this.track("daemon_upgraded", { ok: false, when: whenOf(stop) });
      say({ error: messageOf(error) });
      return;
    }
    this.track("daemon_upgraded", { ok: true, when: whenOf(stop) });
    // Installed; the old daemon goes when its sessions are done. Said until the connection comes back to the new one.
    if (stop === "later") {
      say({ waiting: true });
      return;
    }
    // Stopping the daemon drops the connection, and the status that comes with the new one has no upgrade. If it never
    // drops, the person is shown the button again after a while, not a wait without end. Not awaited: the click is done.
    setTimeout(() => {
      if ("running" in (this.#upgrading.get(environmentId) ?? {})) say(undefined);
    }, this.options.settle ?? 15_000).unref?.();
  }

  async disconnect(environmentId: string): Promise<void> {
    const connection = this.#connections.get(environmentId);
    if (connection === undefined) return;
    this.#connections.delete(environmentId);
    this.#hooks.dropped(connection, true);
    await connection.client.close();
    this.emit({ type: "environment-status", environmentId, state: "closed" });
  }
}

/** What a connected daemon said it can do, as the page reads it. */
const capabilitiesOf = (client: CycleClient): NonNullable<EnvironmentStatus["capabilities"]> => ({
  queue: client.capabilities.queue === true,
  steer: client.capabilities.steer === true,
  files: client.capabilities.files === true,
  folders: client.capabilities.folders === true,
  filesInFolder: client.capabilities.filesInFolder === true,
  trust: client.capabilities.trust === true,
  connectors: client.capabilities.connectors === true,
  plugins: client.pluginAgents,
  agentSetup: client.capabilities.agentSetup === true,
  sessionMentions: client.capabilities.sessionMentions === true,
  fs: client.capabilities.fs === true,
  diff: client.capabilities.diff === true,
  terminal: client.capabilities.terminal === true,
  stopSubagent: client.canStopSubagent,
});
