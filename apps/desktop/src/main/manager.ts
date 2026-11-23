import { randomUUID } from "node:crypto";
import {
  agentOf,
  type EventName,
  type EventProps,
  renameWhereOf,
  settingOf,
  sizeOf,
  viaOf,
} from "@cycle/analytics/events";
import {
  type Channel,
  CycleClient,
  type ElicitationAnswer,
  type PermissionAnswer,
  ProtocolMismatchError,
  type SessionRow,
} from "@cycle/client";
import {
  type AgentInfo,
  type AppApi,
  type AppEvent,
  type Attention,
  applyUpdate,
  attentionOf,
  type ConnectorAnswer,
  type ConnectorChange,
  type ConnectorDraft,
  type ConnectorInfo,
  type ConnectorProblem,
  type Conversation,
  type EnvironmentConfig,
  type EnvironmentStatus,
  emptyConversation,
  type FileContent,
  type FileListing,
  type FileSearch,
  type FolderListing,
  type FolderTrust,
  type NewSession,
  type PermissionRequest,
  type PlanUsage,
  type PromptBlock,
  type SessionSnapshot,
  type SessionSummary,
  type TerminalAttached,
  type TerminalInfo,
  type TerminalProblem,
  type WorkspacePatch,
  type WorkspaceStatus,
} from "@cycle/ui";
import { type DaemonStop, daemonTooOld, daemonUpgradeCommand } from "../shared/release.ts";
import { authorizeInBrowser, type OpenBrowser } from "./connector-auth.ts";
import { environmentOf, LOCAL_ENVIRONMENT, type Settings } from "./settings.ts";

export type ManagerOptions = {
  settings: Settings;
  /** How to reach an environment. The one place that knows about ssh, a local proxy, or a test socket. */
  channelFor: (environment: EnvironmentConfig) => () => Promise<Channel>;
  emit: (event: AppEvent) => void;
  chooseDirectory?: () => Promise<string | undefined>;
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
};

/** Reports one event of the dictionary in @cycle/analytics. */
export type Tracker = <N extends EventName>(name: N, props: EventProps<N>) => void;

/** What the main process is told when a session that was changing is in a state that wants the person. */
export type AttentionNotice = {
  environmentId: string;
  environmentName: string;
  session: SessionSummary;
  kind: Attention;
};

type Pending = {
  request: PermissionRequest;
  /** The daemon's id for it, when it said (an older daemon does not). */
  requestId: string | undefined;
  answer: (answer: PermissionAnswer) => void;
  /** A form's own answer; `answer` then only dismisses it. */
  answerForm?: (answer: ElicitationAnswer) => void;
  /** Asked before the connection was lost and not asked again since: the daemon may have had it answered elsewhere. */
  stale: boolean;
};

/** What main holds for a session being watched, so a renderer that reloads can be given it whole. */
type Watched = {
  conversation: Conversation;
  pending: Map<string, Pending>;
  /** Events sent about this session. The renderer compares it with the snapshot it was given. */
  version: number;
};

type Connection = {
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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** How a daemon update was asked for, as `daemon_upgraded` reports it: nothing was working, interrupt, or wait. */
const whenOf = (stop: DaemonStop): "idle" | "now" | "later" => (stop === "ask" ? "idle" : stop);

const PROBLEMS: readonly ConnectorProblem[] = [
  "invalid_name",
  "reserved_header",
  "invalid_cwd",
  "name_taken",
  "insecure_url",
  "state_mismatch",
  "no_registration",
  "auth_rejected",
  "unreachable",
];

const TERMINAL_REASONS: readonly TerminalProblem[] = [
  "archived",
  "cwd_missing",
  "spawn_failed",
  "daemon_stopping",
];

/** Why the daemon would not open a terminal, as a word the page has a sentence for (docs/protocol.md §8 "终端"). */
export const terminalProblemOf = (
  error: unknown,
): { problem: TerminalProblem; message?: string } => {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: { reason?: unknown } };
  const reason = data?.reason;
  if (typeof reason === "string" && (TERMINAL_REASONS as readonly string[]).includes(reason))
    return { problem: reason as TerminalProblem };
  if (code === -32019) return { problem: "limit" };
  if (code === -32002) return { problem: "not_found" };
  return { problem: "failed", message: messageOf(error) };
};

/** What the daemon's error says, as a word the page has a sentence for (docs/protocol.md §14). */
export const connectorProblemOf = (
  error: unknown,
): { problem: ConnectorProblem; message?: string } => {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: { reason?: unknown } };
  const reason = data?.reason;
  if (typeof reason === "string" && (PROBLEMS as readonly string[]).includes(reason))
    return { problem: reason as ConnectorProblem };
  if (code === -32002) return { problem: "not_found" };
  if (code === -32017) return { problem: "unreachable" };
  if (code === -32602) return { problem: "invalid" };
  if (messageOf(error).includes("too old to keep connectors")) return { problem: "unsupported" };
  return { problem: "failed", message: messageOf(error) };
};

const sessionSummary = (environmentId: string, row: SessionRow): SessionSummary => {
  const meta = (row._meta ?? {}) as Record<string, unknown>;
  return {
    environmentId,
    sessionId: row.sessionId,
    cwd: row.cwd,
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
    archived: meta["cycle/archived"] === true,
    agent: String(meta["cycle/agent"] ?? ""),
    state: (meta["cycle/state"] as SessionSummary["state"]) ?? "stopped",
    lastSeq: Number(meta["cycle/lastSeq"] ?? 0),
    ...(typeof meta["cycle/unread"] === "boolean" ? { unread: meta["cycle/unread"] } : {}),
    ...(typeof meta["cycle/background"] === "number"
      ? { background: meta["cycle/background"] }
      : {}),
    ...(Array.isArray(meta["cycle/backgroundUnknown"])
      ? {
          unknownBackground: meta["cycle/backgroundUnknown"].filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
    ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    ...(typeof meta["cycle/config"] === "object" && meta["cycle/config"] !== null
      ? { config: meta["cycle/config"] as Record<string, string> }
      : {}),
  };
};

/**
 * The main process's half of the app: the connections to daemons, and the state of every session
 * being watched. It is the whole of what the renderer can ask for (`AppApi`) and knows nothing of
 * Electron, so it is tested against a real daemon without a window.
 */
export class ConnectionManager
  implements
    Omit<
      AppApi,
      | "chooseDirectory"
      | "copyText"
      | "updateState"
      | "checkForUpdate"
      | "installUpdate"
      | "track"
      | "analytics"
      | "setAnalytics"
      | "preferences"
      | "setPreferences"
    >
{
  readonly #options: ManagerOptions;
  #environments: EnvironmentConfig[] = [LOCAL_ENVIRONMENT];
  /** Environments whose daemon is being updated from here, and the last one's failure. */
  readonly #upgrading = new Map<
    string,
    { running: true } | { error: string } | { waiting: true }
  >();
  readonly #connections = new Map<string, Connection>();
  /** The last list read from each environment, kept when its connection goes: what the interface greys out. */
  readonly #lastSessions = new Map<string, SessionSummary[]>();
  /** Why the last attempt to connect to an environment failed, for a renderer that asks after the event went by. */
  readonly #lastError = new Map<string, string>();
  readonly #lastIncompatible = new Map<string, NonNullable<EnvironmentStatus["incompatible"]>>();
  /** The sign-in waiting for the browser: one at a time, a new one stops it. */
  #signIn: AbortController | undefined;

  constructor(options: ManagerOptions) {
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#environments = await this.#options.settings.load();
  }

  #track: Tracker = (name, props) => this.#options.track?.(name, props);

  #kindOf(environmentId: string): "local" | "remote" {
    return this.#environments.find((e) => e.id === environmentId)?.kind ?? "remote";
  }

  /** The agent of a session, as one of the words the dictionary has. */
  #agentOf(environmentId: string, sessionId: string): "claude" | "other" {
    const connection = this.#connections.get(environmentId);
    const row = connection?.sessions.find((s) => s.sessionId === sessionId);
    return agentOf(row?.agent ?? connection?.madeAgent.get(sessionId) ?? "");
  }

  async close(): Promise<void> {
    this.#signIn?.abort();
    for (const connection of this.#connections.values()) await connection.client.close();
    this.#connections.clear();
  }

  // ---- environments ----

  async environments() {
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
      await this.#options.settings.save(next);
      this.#environments = next;
      // What it was refused for belongs to the host it was: a changed environment has not been tried yet.
      this.#lastIncompatible.delete(checked.id);
      this.#options.emit({ type: "environments", environments: this.#environments });
    });
    this.#track("environment_saved", { transport: "ssh" });
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    if (environmentId === LOCAL_ENVIRONMENT.id)
      throw new Error("The local daemon cannot be removed");
    // All of it in turn, the disconnecting too: a connect that comes while a removal waits its turn
    // finds the environment still listed, and the removal then closes what it opened.
    let kind: "local" | "remote" = "remote";
    await this.#edit(async () => {
      kind = this.#kindOf(environmentId);
      await this.disconnect(environmentId);
      this.#lastSessions.delete(environmentId);
      this.#lastError.delete(environmentId);
      this.#lastIncompatible.delete(environmentId);
      const next = this.#environments.filter((h) => h.id !== environmentId);
      await this.#options.settings.save(next);
      this.#environments = next;
      this.#options.emit({ type: "environments", environments: this.#environments });
    });
    this.#track("environment_removed", { kind });
  }

  async connect(environmentId: string): Promise<void> {
    const existing = this.#connections.get(environmentId);
    if (existing && existing.status.state !== "closed") return;
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
      connect: this.#options.channelFor(environment),
      name: "cycle-desktop",
      ackReturns: true,
      ...(this.#options.protocolVersion !== undefined
        ? { protocolVersion: this.#options.protocolVersion }
        : {}),
      ...(this.#options.backoff !== undefined ? { backoff: this.#options.backoff } : {}),
      events: {
        update: (sessionId, update, _seq, at) =>
          this.#onUpdate(environmentId, connection, sessionId, update, at),
        permission: (sessionId, request, requestId) =>
          this.#onPermission(environmentId, connection, sessionId, request, requestId),
        // Saying this is saying the app can show a form: the daemon then asks it the agent's questions.
        elicitation: (sessionId, request, requestId) =>
          this.#onForm(environmentId, connection, sessionId, request, requestId),
        resolved: (sessionId, requestId) =>
          this.#onResolved(environmentId, connection, sessionId, String(requestId)),
        listChanged: () =>
          void this.#refreshSessions(environmentId, connection).catch(() => undefined),
        defaultsChanged: (agent) =>
          this.#options.emit({ type: "agent-defaults", environmentId, agent }),
        connectorsChanged: () => this.#options.emit({ type: "connectors", environmentId }),
        planUsage: (agent, usage) =>
          this.#options.emit({ type: "plan-usage", environmentId, agent, usage }),
        terminalsChanged: (sessionId, terminals) =>
          this.#options.emit({ type: "terminals", environmentId, sessionId, terminals }),
        terminalOutput: (output) =>
          this.#options.emit({ type: "terminal-output", environmentId, ...output }),
        terminalReset: (reset) =>
          this.#options.emit({ type: "terminal-reset", environmentId, ...reset }),
        gone: (sessionId) => this.#onGone(environmentId, connection, sessionId),
        // A history that cannot be read after a reconnect: nothing more comes to it, the list row says why.
        unreadable: (sessionId) => this.#onUnreadable(connection, sessionId),
        resumed: (sessionId, pending) =>
          this.#dropStale(environmentId, connection, sessionId, pending),
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
              ? {
                  capabilities: {
                    queue: connection.client.capabilities.queue === true,
                    steer: connection.client.capabilities.steer === true,
                    files: connection.client.capabilities.files === true,
                    folders: connection.client.capabilities.folders === true,
                    filesInFolder: connection.client.capabilities.filesInFolder === true,
                    trust: connection.client.capabilities.trust === true,
                    connectors: connection.client.capabilities.connectors === true,
                    sessionMentions: connection.client.capabilities.sessionMentions === true,
                    fs: connection.client.capabilities.fs === true,
                    diff: connection.client.capabilities.diff === true,
                    terminal: connection.client.capabilities.terminal === true,
                  },
                }
              : state === "reconnecting" && connection.status.capabilities !== undefined
                ? { capabilities: connection.status.capabilities }
                : {}),
          };
          this.#options.emit({ type: "environment-status", ...connection.status });
          if (state !== "connecting")
            this.#track("environment_connection", { kind: this.#kindOf(environmentId), state });
          if (state === "reconnecting") {
            for (const watched of connection.watched.values())
              for (const pending of watched.pending.values()) pending.stale = true;
          }
          if (state === "connected" && was === "reconnecting") {
            void this.#refreshSessions(environmentId, connection, true).catch(() => undefined);
          }
        },
      },
    });
    this.#connections.set(environmentId, connection);
    this.#options.emit({ type: "environment-status", ...connection.status });
    try {
      await connection.client.start();
    } catch (error) {
      // Removed or replaced while it was starting: what is there now is not this attempt's to change.
      if (this.#connections.get(environmentId) !== connection) throw error;
      this.#connections.delete(environmentId);
      this.#lastError.set(environmentId, messageOf(error));
      const incompatible = this.#incompatibleOf(error, environment);
      if (incompatible !== undefined) this.#lastIncompatible.set(environmentId, incompatible);
      else this.#lastIncompatible.delete(environmentId);
      this.#options.emit({
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
      await this.#refreshSessions(environmentId, connection);
    } catch (error) {
      // A daemon that answers but cannot list is not usable: say so, instead of sitting connected with no list.
      const current = this.#connections.get(environmentId) === connection;
      if (current) this.#connections.delete(environmentId);
      await connection.client.close().catch(() => undefined);
      if (!current) throw error;
      this.#lastError.set(environmentId, messageOf(error));
      this.#options.emit({
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
    const { appVersion } = this.#options;
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
    const { appVersion } = this.#options;
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
    const { runOnHost } = this.#options;
    const upgrade = connection?.status.daemon?.upgrade;
    if (connection === undefined || environment === undefined || upgrade === undefined) return;
    // Only an update that is running holds a click back. After a failure the person tries again (the plain stop
    // refuses when sessions started working since, and they then choose); while it waits for the sessions, what is
    // left to choose is to interrupt them.
    const doing = this.#upgrading.get(environmentId);
    if (runOnHost === undefined || (doing !== undefined && "running" in doing)) return;
    if (doing !== undefined && "waiting" in doing && stop !== "now") return;
    // Kept here and not in the status, which every change of the connection builds anew.
    const say = (now: { running: true } | { error: string } | { waiting: true } | undefined) => {
      if (now === undefined) this.#upgrading.delete(environmentId);
      else this.#upgrading.set(environmentId, now);
      if (this.#connections.get(environmentId) !== connection) return;
      connection.status = {
        ...connection.status,
        ...this.#daemonOf(environment, connection.client),
      };
      this.#options.emit({ type: "environment-status", ...connection.status });
    };
    say({ running: true });
    try {
      await runOnHost(environment, daemonUpgradeCommand(upgrade.to, stop));
    } catch (error) {
      this.#track("daemon_upgraded", { ok: false, when: whenOf(stop) });
      say({ error: messageOf(error) });
      return;
    }
    this.#track("daemon_upgraded", { ok: true, when: whenOf(stop) });
    // Installed; the old daemon goes when its sessions are done. Said until the connection comes back to the new one.
    if (stop === "later") {
      say({ waiting: true });
      return;
    }
    // Stopping the daemon drops the connection, and the status that comes with the new one has no upgrade. If it never
    // drops, the person is shown the button again after a while, not a wait without end. Not awaited: the click is done.
    setTimeout(() => {
      if ("running" in (this.#upgrading.get(environmentId) ?? {})) say(undefined);
    }, this.#options.settle ?? 15_000).unref?.();
  }

  async disconnect(environmentId: string): Promise<void> {
    const connection = this.#connections.get(environmentId);
    if (connection === undefined) return;
    this.#connections.delete(environmentId);
    for (const watched of connection.watched.values()) {
      for (const pending of watched.pending.values()) pending.answer({ outcome: "cancelled" });
    }
    await connection.client.close();
    this.#options.emit({ type: "environment-status", environmentId, state: "closed" });
  }

  #connection(environmentId: string): Connection {
    const connection = this.#connections.get(environmentId);
    if (connection === undefined) throw new Error("Not connected to that environment");
    return connection;
  }

  // ---- sessions ----

  async sessions(environmentId: string): Promise<SessionSummary[]> {
    return this.#refreshSessions(environmentId, this.#connection(environmentId));
  }

  /**
   * Reads the session list and tells the renderer. `afterOutage`: the connection was away, so a session that went from
   * working to stopped may only have been released while nobody watched, and what finished is old news: only a session
   * that is asking (and is still asking) is told.
   */
  async #refreshSessions(
    environmentId: string,
    connection: Connection,
    afterOutage = false,
  ): Promise<SessionSummary[]> {
    const asked = ++connection.asked;
    const sessions: SessionSummary[] = [];
    let pages = 0;
    for await (const page of connection.client.sessionPages()) {
      pages++;
      for (const row of page.sessions) sessions.push(sessionSummary(environmentId, row));
      // Only preview the first connection. Replacing a known list with a partial one would
      // briefly hide search results and could misclassify attention on a later page.
      if (
        pages === 1 &&
        page.hasMore &&
        !connection.listed &&
        asked === connection.asked &&
        !this.#lastSessions.has(environmentId) &&
        this.#connections.get(environmentId) === connection
      ) {
        this.#options.emit({ type: "sessions", environmentId, sessions: [...sessions] });
      }
    }
    // An answer to an older question, arriving after the answer to a newer one, would put the list back.
    if (asked < connection.applied) return connection.sessions;
    connection.applied = asked;
    // The environment may have been removed while the question was out: its list must not come back.
    if (this.#connections.get(environmentId) !== connection) return sessions;
    const before = new Map(connection.sessions.map((s) => [s.sessionId, s]));
    const first = !connection.listed;
    if (first) this.#track("session_list_loaded", { pages });
    connection.listed = true;
    connection.sessions = sessions;
    this.#lastSessions.set(environmentId, sessions);
    this.#options.emit({ type: "sessions", environmentId, sessions });
    this.#tell(environmentId, before, sessions, afterOutage, first);
    return sessions;
  }

  /** What changed since the list before is what the person may want to be told. A hook that fails must not break the list. */
  #tell(
    environmentId: string,
    before: ReadonlyMap<string, SessionSummary>,
    sessions: readonly SessionSummary[],
    afterOutage: boolean,
    first: boolean,
  ): void {
    const attention = this.#options.attention;
    const environmentName =
      this.#environments.find((h) => h.id === environmentId)?.name ?? environmentId;
    for (const session of sessions) {
      // A session enters the list with its first message (docs/protocol.md §6), already at work: after the first list,
      // one that appears is taken to have been idle, so that one already waiting on the person is told; or, if a turn of
      // it has ended unseen, to have been running, so that one that has finished by the time it is read is told too.
      const was =
        before.get(session.sessionId) ??
        (first
          ? undefined
          : {
              ...session,
              state: session.unread === true ? ("running" as const) : ("idle" as const),
            });
      const kind = attentionOf(was, session);
      if (kind === undefined || (afterOutage && kind !== "needs-you")) continue;
      this.#track("session_attention", { kind });
      if (attention === undefined) continue;
      try {
        attention({ environmentId, environmentName, session, kind });
      } catch {
        // A notification that cannot be shown is a notification missed, not a list that cannot be read.
      }
    }
  }

  async createSession(environmentId: string, params: NewSession): Promise<string> {
    const connection = this.#connection(environmentId);
    const sessionId = await connection.client.newSession(params);
    // Not in the list until its first message (docs/protocol.md §6): the daemon announces it then, and it is read again.
    connection.made.set(sessionId, params.cwd);
    // Its agent is not in the list yet either, and the reports about it (opened, a prompt) need the word for it.
    connection.madeAgent.set(sessionId, params.agent ?? "");
    this.#track("session_created", {
      agent: agentOf(params.agent ?? ""),
      environment: this.#kindOf(environmentId),
      configured: Object.keys(params.config ?? {}).length > 0,
    });
    return sessionId;
  }

  async openSession(environmentId: string, sessionId: string): Promise<SessionSnapshot> {
    const connection = this.#connection(environmentId);
    let opening = connection.opening.get(sessionId);
    if (opening === undefined) {
      opening = this.#watch(connection, sessionId).finally(() =>
        connection.opening.delete(sessionId),
      );
      connection.opening.set(sessionId, opening);
    }
    await opening;
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) throw new Error("The session is gone");
    this.#track("session_opened", {
      agent: this.#agentOf(environmentId, sessionId),
      environment: this.#kindOf(environmentId),
    });
    return {
      conversation: watched.conversation,
      permissions: [...watched.pending.values()].map((p) => p.request),
      version: watched.version,
    };
  }

  async #watch(connection: Connection, sessionId: string): Promise<void> {
    if (connection.watched.has(sessionId)) return;
    const cwd =
      connection.sessions.find((s) => s.sessionId === sessionId)?.cwd ??
      connection.made.get(sessionId);
    if (cwd === undefined) throw new Error("No such session");
    connection.watched.set(sessionId, {
      conversation: { ...emptyConversation(), replaying: true },
      pending: new Map(),
      version: 0,
    });
    try {
      await connection.client.watch(sessionId, cwd);
    } catch (error) {
      connection.watched.delete(sessionId);
      throw error;
    }
  }

  /** A watched session's history could not be read on reconnecting: it is not watched, and nothing waits on it. */
  #onUnreadable(connection: Connection, sessionId: string): void {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) return;
    for (const pending of watched.pending.values()) pending.answer({ outcome: "cancelled" });
    connection.watched.delete(sessionId);
  }

  /** A watched session was deleted elsewhere while the connection was away: nothing is waiting on it any more. */
  #onGone(environmentId: string, connection: Connection, sessionId: string): void {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) return;
    for (const pending of watched.pending.values()) pending.answer({ outcome: "cancelled" });
    connection.watched.delete(sessionId);
    // The renderer drops the view (and with it the permission dialogs), the draft and the selection.
    this.#options.emit({ type: "session-gone", environmentId, sessionId });
  }

  #onUpdate(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    update: Parameters<typeof applyUpdate>[1],
    at: number | undefined,
  ) {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined) return;
    watched.conversation = applyUpdate(watched.conversation, update, { at });
    watched.version += 1;
    this.#options.emit({
      type: "update",
      environmentId,
      sessionId,
      update,
      ...(at !== undefined ? { at } : {}),
      version: watched.version,
    });
  }

  async prompt(
    environmentId: string,
    sessionId: string,
    content: string | PromptBlock[],
    options: { steer?: boolean; via?: unknown } = {},
  ): Promise<void> {
    const blocks =
      typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
    // The page's blocks are the daemon's to check: a block it does not take is refused whole there (decision 0010).
    await this.#connection(environmentId).client.prompt(
      sessionId,
      blocks as Parameters<CycleClient["prompt"]>[1],
      {
        ...(options.steer === true ? { steer: true } : {}),
      },
    );
    // How much, never what: the length in three words and the number of images, files and mentions.
    this.#track("prompt_sent", {
      agent: this.#agentOf(environmentId, sessionId),
      environment: this.#kindOf(environmentId),
      size: sizeOf(blocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0)),
      images: blocks.filter((b) => b.type === "image").length,
      files: blocks.filter((b) => b.type === "resource").length,
      mentions: blocks.filter((b) => b.type === "resource_link").length,
      steered: options.steer === true,
      // The page says which key or button; only the dictionary's words are counted, anything else is "other".
      via: viaOf(options.via),
    });
  }

  async cancel(environmentId: string, sessionId: string): Promise<void> {
    await this.#connection(environmentId).client.cancel(sessionId);
    this.#track("prompt_cancelled", { agent: this.#agentOf(environmentId, sessionId) });
  }

  async listFolders(
    environmentId: string,
    path?: string,
    hidden?: boolean,
  ): Promise<FolderListing> {
    return this.#connection(environmentId).client.listFolders(path, hidden);
  }

  async planUsage(environmentId: string): Promise<Record<string, PlanUsage>> {
    return this.#connection(environmentId).client.readPlanUsage();
  }

  async readTrust(environmentId: string, path: string): Promise<FolderTrust> {
    return this.#connection(environmentId).client.readTrust(path);
  }

  async setTrust(environmentId: string, path: string, trusted: boolean): Promise<FolderTrust> {
    return this.#connection(environmentId).client.setTrust(path, trusted);
  }

  async searchFiles(
    environmentId: string,
    where: { sessionId: string } | { cwd: string },
    query: string,
  ): Promise<FileSearch> {
    return this.#connection(environmentId).client.searchFiles(
      "sessionId" in where ? where.sessionId : { cwd: where.cwd },
      query,
    );
  }

  async listFiles(environmentId: string, sessionId: string, path: string): Promise<FileListing> {
    return this.#connection(environmentId).client.listFiles(sessionId, path);
  }

  async readFile(
    environmentId: string,
    sessionId: string,
    path: string,
    offset?: number,
  ): Promise<FileContent> {
    return this.#connection(environmentId).client.readFile(sessionId, path, offset);
  }

  async listTerminals(environmentId: string, sessionId: string): Promise<TerminalInfo[]> {
    return this.#connection(environmentId).client.listTerminals(sessionId);
  }

  async createTerminal(
    environmentId: string,
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalAttached | { problem: TerminalProblem; message?: string }> {
    try {
      return await this.#connection(environmentId).client.createTerminal(sessionId, cols, rows);
    } catch (error) {
      return terminalProblemOf(error);
    }
  }

  async attachTerminal(environmentId: string, terminalId: string): Promise<TerminalAttached> {
    return this.#connection(environmentId).client.attachTerminal(terminalId);
  }

  async detachTerminal(environmentId: string, terminalId: string): Promise<void> {
    await this.#connection(environmentId).client.detachTerminal(terminalId);
  }

  async terminalInput(environmentId: string, terminalId: string, data: string): Promise<void> {
    await this.#connection(environmentId).client.terminalInput(terminalId, data);
  }

  async resizeTerminal(
    environmentId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    await this.#connection(environmentId).client.resizeTerminal(terminalId, cols, rows);
  }

  async closeTerminal(environmentId: string, terminalId: string): Promise<void> {
    await this.#connection(environmentId).client.closeTerminal(terminalId);
  }

  async workspaceStatus(environmentId: string, sessionId: string): Promise<WorkspaceStatus> {
    return this.#connection(environmentId).client.workspaceStatus(sessionId);
  }

  async workspaceFile(
    environmentId: string,
    sessionId: string,
    path: string,
  ): Promise<WorkspacePatch> {
    return this.#connection(environmentId).client.workspaceFile(sessionId, path);
  }

  async ackReturn(environmentId: string, sessionId: string, returnId: string): Promise<void> {
    if (await this.#connection(environmentId).client.ackReturn(sessionId, returnId))
      this.#track("queue_return_restored", {});
  }

  async dequeue(environmentId: string, sessionId: string, queueId: string): Promise<PromptBlock[]> {
    return (await this.#connection(environmentId).client.dequeue(
      sessionId,
      queueId,
    )) as PromptBlock[];
  }

  async setSessionConfig(
    environmentId: string,
    sessionId: string,
    configId: string,
    value: string,
  ) {
    await this.#connection(environmentId).client.setConfig(sessionId, configId, value);
    this.#track("session_config_changed", { setting: settingOf(configId) });
  }

  /** `where`: what the page says it was edited in; checked here, since the page's word is not trusted. */
  async renameSession(
    environmentId: string,
    sessionId: string,
    title: string,
    where?: unknown,
  ): Promise<void> {
    await this.#connection(environmentId).client.rename(sessionId, title);
    this.#track("session_renamed", { where: renameWhereOf(where) });
  }

  async dismissBackground(
    environmentId: string,
    sessionId: string,
    taskIds: string[],
  ): Promise<void> {
    const count = await this.#connection(environmentId).client.dismissBackground(
      sessionId,
      taskIds,
    );
    if (count > 0) this.#track("background_dismissed", { count });
  }

  async archiveSession(environmentId: string, sessionId: string, archived: boolean): Promise<void> {
    await this.#connection(environmentId).client.archive(sessionId, archived);
    this.#track("session_archived", { archived });
  }

  /**
   * The person has seen the session up to what the daemon has now. Never a seq past the log: the row's own
   * `lastSeq`. A daemon that cannot is not asked.
   */
  async markRead(environmentId: string, sessionId: string): Promise<void> {
    const connection = this.#connection(environmentId);
    // The list as the daemon has it now: a row read before the news came in would say a seq below it.
    const row = (await this.#refreshSessions(environmentId, connection)).find(
      (s) => s.sessionId === sessionId,
    );
    if (row === undefined) return;
    await connection.client.markRead(sessionId, row.lastSeq);
  }

  async deleteSession(environmentId: string, sessionId: string): Promise<void> {
    const connection = this.#connection(environmentId);
    await connection.client.delete(sessionId);
    connection.watched.delete(sessionId);
    this.#track("session_deleted", {});
  }

  // ---- permissions ----

  #onPermission(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
    form?: {
      form: { message: string; schema: unknown };
      resolve: (answer: ElicitationAnswer) => void;
    },
  ): Promise<PermissionAnswer> {
    const key = `${environmentId}:${sessionId}:${requestId ?? randomUUID()}`;
    return new Promise<PermissionAnswer>((resolve) => {
      let watched = connection.watched.get(sessionId);
      if (watched === undefined) {
        // Asked about a session not open here: nobody can answer it yet. Let the daemon ask again
        // when it is, rather than answering for the user.
        watched = {
          conversation: { ...emptyConversation(), replaying: true },
          pending: new Map(),
          version: 0,
        };
        connection.watched.set(sessionId, watched);
      }
      const old = watched.pending.get(key);
      // The daemon asks again after a reconnect: the request is the same, the answer goes to the new ask.
      old?.answer({ outcome: "cancelled" });
      const built: PermissionRequest = {
        key,
        environmentId,
        sessionId,
        title: String(request.title ?? "Permission"),
        subject: request.subject,
        options: (request.options as PermissionRequest["options"]) ?? [],
        ...(form !== undefined ? { form: form.form } : {}),
      };
      watched.pending.set(key, {
        request: built,
        requestId,
        answer: resolve,
        ...(form !== undefined ? { answerForm: form.resolve } : {}),
        stale: false,
      });
      if (old === undefined) {
        watched.version += 1;
        this.#options.emit({ type: "permission", request: built, version: watched.version });
      }
    });
  }

  /**
   * The agent asks for answers (`elicitation/create`). Held like a permission request, so the card, a reload and the
   * daemon asking again after a reconnect work the same; anything that closes a request without an answer dismisses it.
   */
  #onForm(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<ElicitationAnswer> {
    return new Promise<ElicitationAnswer>((resolve) => {
      const form = {
        message: typeof request.message === "string" ? request.message : "",
        schema: request.requestedSchema,
      };
      void this.#onPermission(
        environmentId,
        connection,
        sessionId,
        { title: form.message },
        requestId,
        {
          form,
          resolve,
        },
      ).then(() => resolve({ action: "cancel" }));
    });
  }

  async answerForm(key: string, answer: unknown): Promise<void> {
    for (const [environmentId, connection] of this.#connections) {
      for (const [sessionId, watched] of connection.watched) {
        const pending = watched.pending.get(key);
        if (pending?.answerForm === undefined) continue;
        // Only the fields the form asked for go on.
        const checked = formAnswerOf(answer, fieldsAsked(pending.request.form?.schema));
        pending.answerForm(checked);
        // The request that holds the form is settled too: it was answered, nothing waits on it.
        pending.answer({ outcome: "cancelled" });
        // What was done with it, never what was written in it.
        this.#track("form_answered", {
          outcome:
            checked.action === "accept"
              ? "answered"
              : checked.action === "decline"
                ? "declined"
                : "dismissed",
        });
        this.#closePermission(environmentId, sessionId, watched, key);
        return;
      }
    }
  }

  async answerPermission(key: string, optionId: string | "cancelled"): Promise<void> {
    for (const [environmentId, connection] of this.#connections) {
      for (const [sessionId, watched] of connection.watched) {
        const pending = watched.pending.get(key);
        if (pending === undefined) continue;
        // A form is answered with `answerForm`; here it can only be dismissed.
        if (pending.answerForm !== undefined) {
          if (optionId === "cancelled") await this.answerForm(key, { action: "cancel" });
          return;
        }
        pending.answer(
          optionId === "cancelled" ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        );
        // Which kind of answer (ACP names them allow_once, allow_always, reject_once, reject_always), never what was asked.
        const kind =
          optionId === "cancelled"
            ? "cancelled"
            : (pending.request.options.find((o) => o.optionId === optionId)?.kind ?? "");
        const outcome = kind.startsWith("allow")
          ? "allowed"
          : kind.startsWith("reject")
            ? "rejected"
            : kind === "cancelled"
              ? "cancelled"
              : undefined;
        // An answer that is none of these (an option of a kind this does not know) is not counted as another.
        if (outcome !== undefined)
          this.#track("permission_answered", {
            outcome,
            remembered: kind.endsWith("_always"),
            queued: watched.pending.size - 1,
          });
        this.#closePermission(environmentId, sessionId, watched, key);
        return;
      }
    }
  }

  /**
   * A session was attached again and the daemon said which requests it still waits on (asking each again). One this
   * client had from before the loss and is not among them was answered by another client while it was away: its card
   * is closed. One asked since the loss is not touched, nor is any when the daemon does not say.
   */
  #dropStale(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    waiting: string[] | undefined,
  ): void {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined || waiting === undefined) return;
    for (const [key, pending] of [...watched.pending]) {
      if (!pending.stale || pending.requestId === undefined) continue;
      if (waiting.includes(pending.requestId)) continue;
      pending.answer({ outcome: "cancelled" });
      this.#closePermission(environmentId, sessionId, watched, key);
    }
  }

  #closePermission(environmentId: string, sessionId: string, watched: Watched, key: string): void {
    watched.pending.delete(key);
    watched.version += 1;
    this.#options.emit({
      type: "permission-closed",
      environmentId,
      sessionId,
      key,
      version: watched.version,
    });
  }

  #onResolved(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    requestId: string,
  ): void {
    const watched = connection.watched.get(sessionId);
    const key = `${environmentId}:${sessionId}:${requestId}`;
    const pending = watched?.pending.get(key);
    if (watched === undefined || pending === undefined) return;
    // Answered somewhere else. Free this client's request, and close the dialog.
    pending.answer({ outcome: "cancelled" });
    this.#closePermission(environmentId, sessionId, watched, key);
  }

  // ---- agents ----

  async agents(environmentId: string): Promise<AgentInfo[]> {
    return (await this.#connection(environmentId).client.agents()).agents;
  }

  async agentDefaults(environmentId: string, agent: string): Promise<Record<string, string>> {
    return this.#connection(environmentId).client.agentDefaults(agent);
  }

  async setAgentDefaults(
    environmentId: string,
    agent: string,
    config: Record<string, string>,
  ): Promise<void> {
    await this.#connection(environmentId).client.setAgentDefaults(agent, config);
    this.#track("agent_defaults_saved", { agent: agentOf(agent) });
  }

  // ---- connectors (docs/protocol.md §14) ----

  async listConnectors(environmentId: string): Promise<ConnectorInfo[]> {
    return this.#connection(environmentId).client.listConnectors();
  }

  async addConnector(environmentId: string, draft: ConnectorDraft): Promise<ConnectorAnswer> {
    try {
      const connector = await this.#connection(environmentId).client.addConnector(draft);
      this.#track("connector_added", {
        transport: connector.transport.type,
        auth: connector.auth.type,
        secrets: connector.secrets.headers.length + connector.secrets.env.length,
      });
      return { connector };
    } catch (error) {
      return connectorProblemOf(error);
    }
  }

  async updateConnector(
    environmentId: string,
    id: string,
    change: ConnectorChange,
  ): Promise<ConnectorAnswer> {
    try {
      const connector = await this.#connection(environmentId).client.updateConnector({
        id,
        ...change,
      });
      const onlyEnabled = Object.keys(change).every((key) => key === "enabled");
      this.#track("connector_changed", {
        change:
          onlyEnabled && change.enabled !== undefined
            ? change.enabled
              ? "enabled"
              : "disabled"
            : "edited",
      });
      return { connector };
    } catch (error) {
      return connectorProblemOf(error);
    }
  }

  async removeConnector(
    environmentId: string,
    id: string,
  ): Promise<{ removed: true } | { problem: ConnectorProblem; message?: string }> {
    try {
      const client = this.#connection(environmentId).client;
      const transport = (await client.listConnectors()).find((c) => c.id === id)?.transport.type;
      await client.removeConnector(id);
      if (transport !== undefined) this.#track("connector_removed", { transport });
      return { removed: true };
    } catch (error) {
      return connectorProblemOf(error);
    }
  }

  /**
   * Signs in to a connector: a loopback callback here, the page in the browser, the code to the daemon (which keeps the
   * PKCE verifier). The code never reaches the page. A sign-in already waiting is stopped first.
   */
  async authorizeConnector(
    environmentId: string,
    id: string,
  ): Promise<ConnectorAnswer | { cancelled: true }> {
    this.#signIn?.abort();
    const signIn = new AbortController();
    this.#signIn = signIn;
    try {
      const client = this.#connection(environmentId).client;
      const open = this.#options.openBrowser;
      if (open === undefined) throw new Error("This app cannot open a browser");
      const outcome = await authorizeInBrowser({
        start: (redirectUri) => client.startConnectorAuth(id, redirectUri),
        finish: (params) => client.finishConnectorAuth(params),
        open,
        signal: signIn.signal,
        ...(this.#options.authTimeoutMs !== undefined
          ? { timeoutMs: this.#options.authTimeoutMs }
          : {}),
      });
      if (outcome.kind === "cancelled") {
        this.#track("connector_authorized", { result: "cancelled" });
        return { cancelled: true };
      }
      if (outcome.kind === "refused") {
        this.#track("connector_authorized", { result: "failed" });
        return { problem: "auth_rejected" };
      }
      this.#track("connector_authorized", { result: "ok" });
      return { connector: outcome.value };
    } catch (error) {
      this.#track("connector_authorized", { result: "failed" });
      return connectorProblemOf(error);
    } finally {
      if (this.#signIn === signIn) this.#signIn = undefined;
    }
  }

  async cancelConnectorAuth(): Promise<void> {
    this.#signIn?.abort();
  }

  async signOutConnector(environmentId: string, id: string): Promise<ConnectorAnswer> {
    try {
      const connector = await this.#connection(environmentId).client.clearConnectorAuth(id);
      this.#track("connector_signed_out", {});
      return { connector };
    } catch (error) {
      return connectorProblemOf(error);
    }
  }

  chooseDirectory(): Promise<string | undefined> {
    return this.#options.chooseDirectory?.() ?? Promise.resolve(undefined);
  }
}

/**
 * A form's answer as the page sent it, checked: the page is not trusted with what goes to the agent. Only `accept`
 * carries content, and only text, numbers, yes/no and lists of text; anything else is a dismissal.
 */
export const formAnswerOf = (answer: unknown, asked?: ReadonlySet<string>): ElicitationAnswer => {
  const given = (answer ?? {}) as { action?: unknown; content?: unknown };
  if (given.action === "decline") return { action: "decline" };
  if (given.action !== "accept" || typeof given.content !== "object" || given.content === null)
    return { action: "cancel" };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [field, value] of Object.entries(given.content)) {
    if (asked !== undefined && !asked.has(field)) continue;
    if (typeof value === "string" || typeof value === "boolean") content[field] = value;
    else if (typeof value === "number" && Number.isFinite(value)) content[field] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      content[field] = value;
  }
  return { action: "accept", content };
};

/** The fields a form's schema asks for: its `properties`. */
const fieldsAsked = (schema: unknown): ReadonlySet<string> => {
  const properties = (schema as { properties?: unknown } | null | undefined)?.properties;
  return new Set(
    typeof properties === "object" && properties !== null ? Object.keys(properties) : [],
  );
};
