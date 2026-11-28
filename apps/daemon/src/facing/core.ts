// What a client-facing registration module (src/facing/, CYCL-262) reaches of the daemon: its parts, and the
// operations on a session that more than the daemon itself needs. The daemon makes one of these and hands it to every
// module; a module never holds the daemon. The operations are the daemon's own, and are documented there.
import type {
  AgentApp,
  ContentBlock,
  NewSessionRequest,
  NewSessionResponse,
  PromptResponse,
} from "@agentclientprotocol/sdk/experimental/v2";
import type {
  AgentAuthMode,
  AgentAuthStartResult,
  AgentRuntimePatchValue,
  AgentSetupSnapshot,
  DaemonUpdateState,
  PlanUsage,
  QueueEntry,
  QueueReason,
} from "@cycle/protocol";
import type { z } from "zod";
import { type CycleHandler, onCycle } from "../acp.ts";
import type { AgentLink } from "../agent-link.ts";
import type { AgentDefinition } from "../agents.ts";
import type { Clients } from "../clients.ts";
import type { ConnectorService } from "../connectors/service.ts";
import type { AgentDefaults } from "../defaults-file.ts";
import type { SessionEntry, SessionIndex } from "../index-file.ts";
import type { LogStore, NewRecord } from "../log/types.ts";
import type { Logger } from "../logger.ts";
import type { AgentOptionsCache } from "../options-cache.ts";
import type { PluginService } from "../plugins.ts";
import type { ModelProviders } from "../providers.ts";
import type { SearchIndex } from "../search.ts";
import type { Attachment, ClientConn, Pending, Session } from "../session.ts";
import type { AgentHome } from "../storage.ts";
import type { Terminals } from "../terminals.ts";
import type { FolderTrust } from "../trust-file.ts";

export type Core = {
  // ---- the daemon's parts ----
  readonly version: string;
  /** Where the daemon keeps its data, and each agent's home as it gives it (docs/protocol.md §16 "本地存储"). */
  readonly dataDir: string;
  readonly agentHomes: () => AgentHome[];
  readonly log: Logger;
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly store: LogStore;
  /** The full-text index over the sessions' histories (docs/protocol.md §8 "搜索对话内容"). */
  readonly search: SearchIndex;
  readonly index: SessionIndex;
  /** The loaded sessions, by id. */
  readonly sessions: Map<string, Session>;
  readonly defaults: AgentDefaults;
  readonly optionsCache: AgentOptionsCache;
  readonly trust: FolderTrust;
  /** The owner's model providers, and the gateway that serves them to Codex. */
  readonly providers: ModelProviders;
  readonly connectors: ConnectorService;
  readonly plugins: PluginService;
  readonly terminals: Terminals;
  readonly clients: Clients;
  /** The latest plan usage each agent told. */
  readonly planUsage: ReadonlyMap<string, PlanUsage>;
  /** The daemon's own update state (docs/protocol.md §3). */
  updateState(): DaemonUpdateState;
  now(): number;

  // ---- sessions ----
  /** An agent by id; `AgentUnavailable` when there is none. */
  definition(id: string): AgentDefinition;
  /** A loaded session, loading it if it is not yet; `RESOURCE_NOT_FOUND` for none. */
  session(sessionId: string): Promise<Session>;
  /** A session's folder, from the index: nothing of the session needs loading to read in it. */
  cwdOf(sessionId: string): string;
  /** Follows what is written to a session's log, for what the list shows of it. */
  watch(session: Session): void;
  /** Starts a new session's agent and has it create the session. */
  startAgent(
    session: Session,
    create: NewSessionRequest,
  ): Promise<{ link: AgentLink; created: NewSessionResponse | undefined }>;
  /** The session's agent, started if it is not running. */
  ensureAgent(session: Session): Promise<AgentLink>;
  /** Lets go of the oldest agents started ahead of a prompt, past their agent's `maxAhead`. */
  letGoOfOldestAhead(keep: Session): void;
  /** Stops a session's agent started with a trust, runtime or account state changed since, once it has nothing to do. */
  restartIfStale(session: Session): void;
  /** Stops each agent in a folder whose trust decision changed, once it has nothing to do. */
  applyTrust(folder: string): Promise<void>;
  /** Appends to a session's log; false when it is not on record. */
  write(session: Session, record: NewRecord): Promise<boolean>;
  /** Changes a session's index entry, and announces the list unless told not to. */
  remember(session: Session, patch: Partial<SessionEntry>, announce?: boolean): void;
  /** Tells every client the session list changed. */
  changed(): void;

  // ---- turns and the queue ----
  /** Gives a prompt to the agent as a new turn. */
  send(session: Session, prompt: ContentBlock[]): Promise<PromptResponse>;
  /** Gives a prompt to the running turn; undefined when the agent cannot take it. */
  steer(session: Session, prompt: ContentBlock[]): Promise<PromptResponse | undefined>;
  /** A prompt that could not be given to the agent: the turn ends in failure, on record. */
  promptFailed(session: Session, error: unknown): void;
  /** Writes the queue as it is now; whether it is on record. */
  publishQueue(
    session: Session,
    back?: { returnId: string; returned: QueueEntry[]; reason: QueueReason },
  ): Promise<boolean>;
  /** Hands everything waiting back to the clients. */
  returnQueue(session: Session, reason: QueueReason, force?: boolean): void;
  /** Whether the daemon is draining for an update: no new turn starts. */
  draining(): boolean;
  /** A queue left behind with no turn to send it is handed back. */
  returnStale(session: Session): void;
  /** Offers what was handed back to a client that is ready. */
  offerReturn(session: Session): void;
  /** A client took what was handed back; whether it was the one asked. */
  ackReturn(session: Session, conn: ClientConn, id: string): Promise<boolean>;

  // ---- requests put to the owner ----
  /** Asks one client a waiting request, once. */
  offer(session: Session, pending: Pending, attachment: Attachment): void;
  /** Settles a waiting request with an outcome. */
  settle(session: Session, pending: Pending, outcome: unknown, by?: Attachment): void;

  // ---- an agent's setup and account (docs/protocol.md §16) ----
  readAgentSetup(params: {
    agent: string;
    refreshUsage?: boolean | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentSetupSnapshot>;
  setAgentRuntime(params: {
    agent: string;
    patch: Record<string, AgentRuntimePatchValue>;
    expectedRevision: number;
  }): Promise<{
    values: Record<string, string | number | boolean>;
    overrides: string[];
    revision: number;
  }>;
  /** Starts an agent ahead of the session that will want it, when it can be (`Daemon.prewarmAgent`). */
  prewarmAgent(agent: string): Promise<void>;
  /** A sign-in flow, bound to the connection that starts it. */
  startAgentAuth(
    connectionId: string,
    params: { agent: string; mode?: AgentAuthMode | undefined },
  ): Promise<AgentAuthStartResult>;
  submitAgentAuth(
    connectionId: string,
    params: { flowId: string; code: string },
  ): Promise<{ ok: true }>;
  cancelAgentAuth(connectionId: string, params: { flowId: string }): Promise<Record<string, never>>;
  logoutAgent(params: { agent: string }): Promise<Record<string, never>>;
};

/** This connection's client. Throws before the connection is ready. */
export type Me = () => ClientConn;

/**
 * Registers Cycle's own methods on an app: the handler answers what the method's result schema says (a field the
 * schema has and the handler leaves out, or one of another shape, does not compile), and an answer the schema refuses
 * is not sent (`onCycle`).
 */
export const cycleOn =
  (app: AgentApp, log: Logger) =>
  <P extends z.ZodType, R extends z.ZodType>(
    method: { name: `_cycle/${string}`; params: P; result: R },
    handler: CycleHandler<P, R>,
  ): void =>
    onCycle(app, log, method, handler);
