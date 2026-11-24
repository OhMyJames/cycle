import { z } from "zod";

/** Keys Cycle puts in ACP's `_meta`. See docs/protocol.md. */
export const META = {
  /** The daemon's per-session sequence number of a record, on every forwarded `session/update`. */
  seq: "cycle/seq",
  /**
   * When the daemon logged that record: its log line's `ts`, ISO 8601 UTC to the millisecond, on every forwarded
   * `session/update` that has a record. Absent on synthesized updates and from older daemons (docs/protocol.md §5).
   */
  ts: "cycle/ts",
  /** In `initialize`: Cycle's own protocol version, "major.minor". */
  protocolVersion: "cycle/protocolVersion",
  /** In the `initialize` response: what this daemon can do. */
  capabilities: "cycle/capabilities",
  /** In `session/new`: the agent to run. */
  agent: "cycle/agent",
  /** In `session/new`: the initial configuration, checked against the agent's `configSchema`. */
  config: "cycle/config",
  /**
   * In `session/new`: the session's environment, `SessionEnvironmentSchema` (docs/protocol.md §6 "环境"). In a
   * `session/list` row: its summary, `SessionEnvironmentSummarySchema`, never a variable's value.
   */
  environment: "cycle/environment",
  /**
   * In `session/new`: make a worktree and run in it, `WorktreeRequestSchema`. In a `session/list` row: the one the
   * session is in, `WorktreeSummarySchema`. In `session/delete`: `{ discard: true }` removes a worktree that holds
   * unsaved work (docs/protocol.md §6 "Worktree").
   */
  worktree: "cycle/worktree",
  /** On a choice an agent offers (an ACP select option, a `configSchema` `oneOf` entry): true on the one it suggests. */
  recommended: "cycle/recommended",
  /** On a choice an agent offers: true on a high-risk option (such as skipping all permission checks) that the UI should warn on. */
  danger: "cycle/danger",
  /**
   * On a session `configSchema` property: true when the agent takes a change only from its next turn, so a turn
   * already running keeps what it started with (docs/protocol.md §10).
   */
  nextTurn: "cycle/nextTurn",
  /** On a runtime `configSchema` property: when changes take effect (docs/protocol.md §16). */
  applyScope: "cycle/applyScope",
  /** On a runtime `configSchema` property: `{ key, equals }` enabling condition (docs/protocol.md §16). */
  enabledWhen: "cycle/enabledWhen",
  /** On a `configSchema` property that lists choices: true when the agent takes values that are not listed, so the list is a menu, not a limit. */
  open: "cycle/open",
  /** On a `configSchema` property: false when it is not one of the choices beside the message box, only in settings (docs/protocol.md §10). */
  composer: "cycle/composer",
  /**
   * On a model choice: `{ id, name }` of the owner's model provider that serves it. Absent on the agent's own models.
   * A session keeps to one kind: the agent's own models, or the owner's (a thread stays with the provider it began on).
   */
  provider: "cycle/provider",
  /** In the `session/new` and `session/resume` the daemon sends an agent: the model the session starts with, so the agent begins it on the right provider. */
  model: "cycle/model",
  /** On a model choice: the effort levels that model takes (`[]` when it takes none); absent when not known (docs/protocol.md §10). */
  efforts: "cycle/efforts",
  /** On a `usage_update`: what the context window holds, by part (docs/protocol.md §8). */
  context: "cycle/context",
  /** In `session/new`: the id the daemon proposes for the agent's own session. */
  sessionId: "cycle/sessionId",
  /** In a `session/list` row. */
  archived: "cycle/archived",
  state: "cycle/state",
  lastSeq: "cycle/lastSeq",
  /** In a `session/list` row: whether something worth seeing came after the last `_cycle/session/mark_read`. */
  unread: "cycle/unread",
  /** In a `session/list` row: how many background sub-agents and background tasks are still running. Absent when none. */
  background: "cycle/background",
  backgroundUnknown: "cycle/backgroundUnknown",
  /** In a session/list row, and in the state_update a client opens a session with: true once the session's history could not be written (docs/protocol.md section 12). Absent otherwise. */
  historyFailed: "cycle/historyFailed",
  /**
   * In the `session/resume` the daemon sends an agent: true when a turn of this session
   * has been answered (it ended with `end_turn`), so the agent has a record of it of its own. An agent that finds none says so
   * instead of starting the session over. Absent for a session that has had no such turn.
   */
  hadTurn: "cycle/hadTurn",
  /**
   * In an agent's answer to `session/resume`: the agent's new id for a session that had no answered turn and of which it
   * found no record (docs/protocol.md §6). The daemon stores it as `agentSessionId`; never allowed once `hadTurn` is set.
   */
  agentSessionId: "cycle/agentSessionId",
  /** In a `subagent_update`: what the adapter says of the task beyond ACP's fields (decision 0014). */
  subagent: "cycle/subagent",
  /** On a permission request sent to a client: the sub-agent that asked, by its `subagent_update` id (docs/protocol.md §9). Absent when the main agent asked. */
  subagentId: "cycle/subagentId",
  /** In a finished `tool_call_update`: what the call amounts to in numbers, never contents (docs/protocol.md §9, `ToolResultSchema`). */
  toolResult: "cycle/toolResult",
  /** On a text content item of a tool call: `"stderr"` when it is what a command printed as errors (docs/protocol.md §9). */
  stream: "cycle/stream",
  /** In a `session/list` row: the context the session uses and what it has cost (`SessionUsageSchema`). */
  usage: "cycle/usage",
  /** On a permission request sent to a client: the daemon's id for it, as `_cycle/request_resolved` names it. */
  requestId: "cycle/requestId",
  /** In a `session/resume` answer: the `requestId` of every request the daemon still waits on, which it has asked of this client again. */
  pending: "cycle/pending",
  /** On the answer to an `elicitation/create` nobody could be asked: no attached client has the capability. */
  noClient: "cycle/noClient",
  /** On the answer to a `session/prompt` that was queued, not sent: the agent was still working. */
  queued: "cycle/queued",
  ackReturns: "cycle/ackReturns",
  /** On `session/list`: leave out the sessions nothing has been said in yet (docs/protocol.md §6). */
  onlyPrompted: "cycle/onlyPrompted",
  /** On session/list: opt into a bounded scan with SessionPageSchema. */
  page: "cycle/page",
  /**
   * On a `session/prompt` (client to daemon, and daemon to agent): put it into the turn that is
   * running instead of queueing it (docs/protocol.md §8). Ignored when the session is not busy.
   */
  steer: "cycle/steer",
  /**
   * On a `session/prompt` (client to daemon, and daemon to agent): whether the sender wants the agent to suggest what to
   * say next once the turn ends (`_cycle/prompt_suggestion`, docs/protocol.md §8). The daemon keeps the last value per
   * session and gives it with every prompt it sends; absent means none was asked for.
   */
  promptSuggestions: "cycle/promptSuggestions",
  /** On the answer to a `session/prompt` that the agent took into the running turn. */
  steered: "cycle/steered",
  /**
   * In the `session/new` and `session/resume` the daemon sends an agent: whether the session's folder
   * may run the commands its own configuration names (docs/protocol.md §8 "信任文件夹"). Absent:
   * nobody has decided, and the agent leaves what it had as it was.
   */
  trusted: "cycle/trusted",
  /**
   * On a `notice`: the agent's model request failed and the agent tries it again by itself, `{attempt, maxRetries,
   * delayMs, status?}` (docs/protocol.md §8). Shown as a state while it is the last thing in the turn, never as a row.
   */
  retry: "cycle/retry",
  /**
   * On a block the daemon put in a prompt in place of a mention of another session (daemon to agent): the
   * `resource_link` it stands for, which the daemon puts back in the agent's echo before it is written
   * (docs/protocol.md §8 "提及(@)另一个 session").
   */
  expandedFrom: "cycle/expandedFrom",
} as const;

/** The version of Cycle's protocol, "major.minor". A different major is refused. */
export const CYCLE_PROTOCOL_VERSION = "0.2";

export const ProtocolVersionSchema = z.string().regex(/^\d+\.\d+$/);

/** `replayFrom` kinds the daemon understands: ACP's `start`, and Cycle's own `_cycle.seq`. */
export const REPLAY_KINDS = ["start", "_cycle.seq"] as const;

export const CapabilitiesSchema = z.object({
  replay: z.array(z.string()),
  agents: z.array(z.string()),
  sessionOps: z.array(z.string()),
  /** Prompts sent while the agent works are queued by the daemon (docs/protocol.md §8). */
  sessionListPages: z.boolean().optional(),
  queue: z.boolean().optional(),
  /** A prompt with `_meta["cycle/steer"]` goes into the running turn where the agent can (docs/protocol.md §8). */
  steer: z.boolean().optional(),
  /** `_cycle/files/search` is there (docs/protocol.md §8). */
  files: z.boolean().optional(),
  /** `_cycle/folders/list` is there (docs/protocol.md §8). */
  folders: z.boolean().optional(),
  /** `_cycle/files/search` also takes a `cwd` in place of a session (docs/protocol.md §8). */
  filesInFolder: z.boolean().optional(),
  /** `_cycle/fs/list` and `_cycle/fs/read` are there (docs/protocol.md §8 "浏览和预览文件"). */
  fs: z.boolean().optional(),
  /** `_cycle/diff/status` and `_cycle/diff/file` are there (docs/protocol.md §8 "工作区的改动"). */
  diff: z.boolean().optional(),
  /** `_cycle/trust/read` and `_cycle/trust/set` are there (docs/protocol.md §8). */
  trust: z.boolean().optional(),
  /** `_cycle/plan_usage/read` and `_cycle/plan_usage_changed` are there (docs/protocol.md §8 "套餐用量"). */
  planUsage: z.boolean().optional(),
  /** `_cycle/agent_setup/*` and `_cycle/agent_auth/*` are there (docs/protocol.md §16). */
  agentSetup: z.boolean().optional(),
  /** `_cycle/agent_setup/prewarm` is there (docs/protocol.md §16). */
  agentPrewarm: z.boolean().optional(),
  /** `_cycle/storage/read` and `_cycle/storage/clean` are there (docs/protocol.md §16 "本地存储"). */
  storage: z.boolean().optional(),
  /** A `cycle://session/` mention in a prompt reaches the agent as that session's record (docs/protocol.md §8). */
  sessionMentions: z.boolean().optional(),
  /** `session/new` takes `_meta["cycle/environment"]`, and `_cycle/terminal/create` an `actionId` (docs/protocol.md §6 "环境"). */
  environments: z.boolean().optional(),
  /** `session/new` takes `_meta["cycle/worktree"]`, and `_cycle/git/branches` is there (docs/protocol.md §6 "Worktree"). */
  worktrees: z.boolean().optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

const sessionTime = z.iso
  .datetime()
  .refine((value) => !/\.\d{4}/.test(value), "Expected millisecond precision or coarser");

/** Options for a bounded scan of the session index (protocol §6). */
export const SessionPageSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  agent: z.string().optional(),
  createdFrom: sessionTime.optional(),
  createdBefore: sessionTime.optional(),
});
export type SessionPageOptions = z.input<typeof SessionPageSchema>;

/** Replay everything after a sequence number. An extension of ACP's `ReplayFrom`. */
export const ReplayFromSeqSchema = z.object({
  type: z.literal("_cycle.seq"),
  after: z.number().int().nonnegative(),
});
export type ReplayFromSeq = z.infer<typeof ReplayFromSeqSchema>;

/** What a session is doing, as the session list shows it. `stopped`: no agent process. */
export const SessionStateSchema = z.enum(["running", "idle", "requires_action", "stopped"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * What the latest `usage_update` said: tokens in context, the window they are in, and the cost so
 * far. The daemon keeps it in the index, so a list shows it without replaying a log.
 */
export const SessionUsageSchema = z.object({
  used: z.number().nonnegative(),
  size: z.number().positive(),
  cost: z.object({ amount: z.number().nonnegative(), currency: z.string() }).nullish(),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/** The sequence number on an update's `_meta`, or undefined if it carries none. */
export const seqOf = (meta: unknown): number | undefined => {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[META.seq];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
};

/**
 * The time on an update's `_meta["cycle/ts"]`, in milliseconds since the epoch, or undefined if it carries none or one
 * that is not a time. Undefined is "not known": never read it as now or as 0.
 */
export const tsOf = (meta: unknown): number | undefined => {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[META.ts];
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
};

/** `_meta["cycle/toolResult"]` of a finished tool call: counts and flags only (docs/protocol.md §9 "工具调用的结果"). */
const count = z.number().int().nonnegative();
export const ToolResultSchema = z.union([
  z.object({
    edit: z.object({
      additions: count,
      deletions: count,
      created: z.literal(true).optional(),
      staged: z.literal(true).optional(),
    }),
  }),
  z.object({
    read: z.object({ startLine: count, numLines: count, totalLines: count.optional() }),
  }),
  z.object({
    search: z.object({
      files: count,
      matches: count.optional(),
      lines: count.optional(),
      more: z.literal(true).optional(),
    }),
  }),
  z.object({
    run: z.object({
      interrupted: z.literal(true).optional(),
      timedOutMs: count.optional(),
      background: z.literal(true).optional(),
      exitCode: count.optional(),
    }),
  }),
  z.object({
    fetch: z.object({ status: z.number().int().min(100).max(599), bytes: count.optional() }),
  }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;
