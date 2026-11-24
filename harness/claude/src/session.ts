import {
  type AgentContext,
  methods,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { EffortLevel, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "./config-options.ts";
import type { SdkContent } from "./content.ts";
import { Schedules } from "./schedules.ts";
import type { SessionSetup } from "./setup.ts";
import { Subagents } from "./subagents.ts";
import { BackgroundTasks } from "./tasks.ts";
import { Transcripts } from "./transcripts.ts";
import { PlanState, TurnTranslator } from "./translate.ts";

/** The SDK's `query`, in streaming-input mode: the prompt is a stream, so one process serves many turns. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

export type AdapterConfig = {
  /**
   * Everything the Claude process may see. Nothing is inherited from this process: the daemon
   * decides, from its allowlist, and passes it in (decision 0001).
   */
  env: Record<string, string>;
  /**
   * A file of the session's environment variables (docs/protocol.md §6 "环境") that the daemon wrote, given to Claude as
   * CLAUDE_ENV_FILE so that its commands have them and the Claude process does not (env-file.ts).
   */
  sessionEnvFile?: string;
  /** The SDK's own binary is used when this is absent. */
  claudeExecutable?: string;
  /**
   * How long a session's Claude process may sit idle before it is let go (ms). A process is about
   * 230 MB, and there is one per open session; the next prompt resumes the session. Default 5 minutes.
   */
  idleMs?: number;
  /** How long a cancelled turn may take to stop before its process is killed (ms). Default 3 seconds. */
  cancelGraceMs?: number;
  /**
   * Start the session's process when the session is made, not at its first prompt, so that what a
   * process can say (the slash commands) is known before anything is typed. It costs a process
   * (about 230 MB) for each new session until it is let go after `idleMs`. Default off.
   */
  warmStart?: boolean;
  /** How many processes started ahead of a first prompt may be held at once; the oldest is let go. Default 3. */
  maxWarm?: number;
  /** Ask the SDK for model-written progress lines for sub-agents (a model call each). Default off. */
  progressSummaries?: boolean;
  /**
   * What Claude has recorded about a session, to learn the title it gave it. The SDK's own
   * `getSessionInfo` in the real process; absent means titles are not looked for.
   */
  sessionInfo?: (sessionId: string, cwd: string) => Promise<SessionInfo | undefined>;
};

export type SessionInfo = { summary?: string; customTitle?: string; firstPrompt?: string };

export type Turn = {
  translator: TurnTranslator;
  /** Aborted on cancel: it ends a permission request that is still waiting for an answer. */
  permissions: AbortController;
  cancelled: boolean;
  done: boolean;
  /**
   * Prompts put into this turn that Claude has not yet said it took (a result's `user_message_uuids`).
   * While there are any, a result does not end the turn: Claude goes on with them.
   */
  steers: Set<string>;
  /** The turn's own prompt is in the process: only then can another be put after it. */
  pushed: boolean;
  /** The process this turn runs on: the one whose exit ends it. */
  process: Live | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
};

/** A Claude process, and the stream that feeds it. It lives for many turns. */
export type Live = {
  query: Query;
  abort: AbortController;
  /**
   * Hands the process a user message. `uuid` is how a result names it among what it took; `next`:
   * into the turn that is running, at its next tool call.
   */
  push: (content: string | SdkContent[], uuid: string, priority?: "next") => void;
  /** Ends the input: the process finishes what it is doing and exits. */
  end: () => void;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Whether the process was last told to suggest what to say next (its `promptSuggestionEnabled` flag setting). */
  suggestions: boolean;
};

export type SessionState = {
  id: string;
  cwd: string;
  /** False until a process has started the session: then the id exists on disk and is resumed, not created. */
  started: boolean;
  /** The sub-agents the model has started, as far as clients were told. */
  subagents: Subagents;
  /** What each sub-agent said and called, told as its own session's updates (CYCL-134). */
  transcripts: Transcripts;
  /** The background tasks that are not sub-agents (commands, watchers, workflows), as far as clients were told. */
  tasks: BackgroundTasks;
  /**
   * What is set to wake the session (CronCreate, ScheduleWakeup, /loop), as the Stop hook last said and calls since then
   * set. Kept when the process goes: the next one, resumed, sets again the ones not yet due, and says so at the end of
   * its first turn.
   */
  schedules: Schedules;
  /** The command list clients were last told, to say it again only when it changes. */
  commandsKey: string | undefined;
  /** The configOptions snapshot clients were last told via `config_option_update`, to avoid duplicate broadcasts. */
  configKey: string | undefined;
  mode: PermissionMode;
  model: string | undefined;
  effort: EffortLevel | undefined;
  turn: Turn | undefined;
  live: Live | undefined;
  /** The task list, which outlives a turn. */
  plan: PlanState;
  /** Directories, MCP servers and system prompt: what a process is started with, every time. */
  setup: SessionSetup;
  /** The title last told to the client, so it is not told twice. */
  title: string | undefined;
  /** The id of the compaction that is running, if one is. */
  compaction: string | undefined;
  /**
   * Tokens in context once the running compaction is done (`compact_boundary`'s `post_tokens`), held until the
   * compaction is told as completed so the usage that follows it is never older than it.
   */
  compacted: number | undefined;
  /** The context window the last `usage_update` gave: what a usage told between turns is measured against. */
  contextSize: number | undefined;
  /** Who to tell when something ends outside a turn (a compaction cut short). */
  client: AgentContext | undefined;
  /** True while a mode the user chose is on its way to the process: what it says meanwhile is stale. */
  modeChanging: number;
  /** The last prompt asked for a suggestion of what to say next (`cycle/promptSuggestions`). None until one does. */
  suggestions: boolean;
};

/** A session as it is when Cycle first holds it: no process, no turn, nothing told yet. */
export const newSession = (fields: {
  id: string;
  cwd: string;
  started: boolean;
  mode: PermissionMode;
  setup: SessionSetup;
}): SessionState => ({
  ...fields,
  subagents: new Subagents(),
  transcripts: new Transcripts(),
  tasks: new BackgroundTasks(),
  schedules: new Schedules(),
  commandsKey: undefined,
  configKey: undefined,
  model: undefined,
  effort: undefined,
  turn: undefined,
  live: undefined,
  plan: new PlanState(),
  title: undefined,
  compaction: undefined,
  compacted: undefined,
  contextSize: undefined,
  client: undefined,
  modeChanging: 0,
  suggestions: false,
});

/** A turn with nothing in it yet. `process` is the one it runs on, once there is one. */
export const newTurn = (session: SessionState, process?: Live): Turn => ({
  translator: new TurnTranslator(session.plan, Object.keys(session.setup.mcpServers)),
  permissions: new AbortController(),
  cancelled: false,
  done: false,
  steers: new Set(),
  pushed: process !== undefined,
  process,
  killTimer: undefined,
});

/** Tells a client an update of `sessionId`. */
export const notify = (client: AgentContext, sessionId: string, update: SessionUpdate) =>
  client.notify(methods.client.session.update, { sessionId, update });

/** Tells the session's client, if there is one, and does not wait: for what happens outside a turn. */
export const tell = (session: SessionState, update: SessionUpdate, sessionId = session.id) => {
  if (session.client === undefined) return;
  void notify(session.client, sessionId, update).catch(() => undefined);
};
