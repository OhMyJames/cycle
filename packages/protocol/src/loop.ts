import { z } from "zod";
import { SessionOriginRoleSchema } from "./meta.ts";

/**
 * The Loop server's methods, `projects/list` and `runs/list` (docs/protocol.md §17). The Loop server is its own
 * process, not the daemon, so its methods are not `_cycle/*`. A response never holds a token, a repository address
 * or a local path.
 */

export const LOOP_PROJECTS_LIST = "projects/list";
export const LOOP_RUNS_LIST = "runs/list";

export const LoopForgeSchema = z.enum(["github", "gitlab"]);
export type LoopForge = z.infer<typeof LoopForgeSchema>;

export const LoopProjectSchema = z.object({
  /** The name to show. */
  name: z.string().min(1),
  /** The itsaplan Project key, such as `CYC`; one per Loop server. */
  projectKey: z.string().min(1),
  repo: z.object({
    /** `owner/name`: no host, no scheme, no credentials. */
    displayName: z.string().min(1),
    forge: LoopForgeSchema,
  }),
});
export type LoopProject = z.infer<typeof LoopProjectSchema>;

export const LoopProjectsListResultSchema = z.object({ projects: z.array(LoopProjectSchema) });
export type LoopProjectsListResult = z.infer<typeof LoopProjectsListResultSchema>;

/**
 * Where a run is, in three words. `active` means the Loop has not finished or blocked it; it does not prove a
 * process is alive.
 */
export const LoopRunStateSchema = z.enum(["active", "blocked", "done"]);
export type LoopRunState = z.infer<typeof LoopRunStateSchema>;

export const LoopRunSchema = z.object({
  /** The work item key, such as `CYC-390`. */
  key: z.string().min(1),
  kind: z.enum(["dev", "research"]),
  state: LoopRunStateSchema,
  /** ISO times from the run record. */
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LoopRun = z.infer<typeof LoopRunSchema>;

export const LoopProjectRunsSchema = z.object({
  projectKey: z.string().min(1),
  runs: z.array(LoopRunSchema),
});
export type LoopProjectRuns = z.infer<typeof LoopProjectRunsSchema>;

export const LoopRunsListResultSchema = z.object({ projects: z.array(LoopProjectRunsSchema) });
export type LoopRunsListResult = z.infer<typeof LoopRunsListResultSchema>;

export const LOOP_EVENTS_LIST = "events/list";

/**
 * One thing that happened in a Project's loop (docs/protocol.md §17). `seq` is the event's line number in
 * `events.jsonl`, starting at 1. Only these four fields are sent: the rest of a line may hold paths or addresses.
 */
export const LoopEventSchema = z.object({
  seq: z.number().int().min(1),
  ts: z.string().min(1),
  /** The work item key, or `plan-<round>` for a planning round. */
  run: z.string().min(1),
  kind: z.string().min(1),
});
export type LoopEvent = z.infer<typeof LoopEventSchema>;

export const LoopEventsListParamsSchema = z.object({
  projectKey: z.string().min(1),
  /** The last `seq` the client has; only larger ones come back. 0 (the default) means from the start. */
  afterSeq: z.number().int().min(0).default(0),
  /** At most this many events (default 500, at most 1000). */
  limit: z.number().int().min(1).max(1000).default(500),
});
export type LoopEventsListParams = z.input<typeof LoopEventsListParamsSchema>;

export const LoopEventsListResultSchema = z.object({
  projectKey: z.string().min(1),
  events: z.array(LoopEventSchema),
  /** The `seq` to send next time: the last event returned, or `afterSeq` when none was. */
  lastSeq: z.number().int().min(0),
  /** More events are already there; ask again at once with `lastSeq`. */
  hasMore: z.boolean(),
});
export type LoopEventsListResult = z.infer<typeof LoopEventsListResultSchema>;

/**
 * The `loop/` methods (CYC-482): the one way a desktop or an operator agent reads the board, the runs and the Notices
 * and approves or returns tickets. The Loop server alone talks to itsaplan. `project` is the itsaplan Project key.
 * `projects/list`, `runs/list` and `events/list` above keep their names; `loop/projects/list` answers like
 * `projects/list`.
 */
export const LOOP_API_PROJECTS_LIST = "loop/projects/list";
export const LOOP_BOARD_GET = "loop/board/get";
export const LOOP_API_RUNS_LIST = "loop/runs/list";
export const LOOP_RUN_GET = "loop/run/get";
export const LOOP_NOTICES_LIST = "loop/notices/list";
export const LOOP_TICKET_GET = "loop/ticket/get";
export const LOOP_TICKETS_ACT = "loop/tickets/act";
export const LOOP_INTENTS_RETRY = "loop/intents/retry";
export const LOOP_STATUS = "loop/status";
export const LOOP_GRAPH_ACT = "loop/graph/act";
export const LOOP_RUN_CANCEL = "loop/run/cancel";
export const LOOP_TIMELINE_LIST = "loop/timeline/list";

/** The most bytes of one request line; a connection that sends more without a newline is closed. */
export const LOOP_MAX_LINE_BYTES = 1_048_576;

/** The kind of session a run has, by the role it plays. */
export const LoopSessionKindSchema = z.enum([
  "dev",
  "qa",
  "review",
  "research",
  "research_qa",
  "triage",
  "shape",
  "shape_qa",
]);
export type LoopSessionKind = z.infer<typeof LoopSessionKindSchema>;
export const LoopSessionRefSchema = z.object({
  kind: LoopSessionKindSchema,
  id: z.string().min(1),
});
export type LoopSessionRef = z.infer<typeof LoopSessionRefSchema>;

export const LoopProjectParamsSchema = z.object({ project: z.string().min(1) });
export type LoopProjectParams = z.infer<typeof LoopProjectParamsSchema>;

/** Who asked for a write. Self-declared: this names the caller in the record, it does not authenticate it. */
export const LoopActorKindSchema = z.enum(["desktop", "operator"]);
export type LoopActorKind = z.infer<typeof LoopActorKindSchema>;

/** Level-2 Task Graph (CYC-512, docs/protocol.md §17): where a work item's execution graph stands, for the board. */
export const LoopGraphSourceSchema = z.enum([
  "single",
  "plan_doc",
  "auto_plan",
  "auto_planner",
  "edited",
]);
export const LoopGraphNodeStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
]);
export type LoopGraphNodeStatus = z.infer<typeof LoopGraphNodeStatusSchema>;

export const LoopGraphSummarySchema = z.object({
  source: LoopGraphSourceSchema,
  total: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  blocked: z.number().int().min(0),
  running: z.number().int().min(0),
  currentNodeId: z.string().nullable(),
  currentNodeTitle: z.string().nullable(),
});
export type LoopGraphSummary = z.infer<typeof LoopGraphSummarySchema>;

export const LoopGraphNodeSchema = z.object({
  id: z.string().min(1),
  /** Topological order, from 0. */
  position: z.number().int().min(0),
  origin: z.enum(["planned", "fix"]),
  title: z.string().min(1),
  goal: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
  filesHint: z.array(z.string()),
  verify: z.array(z.string().min(1)).min(1),
  status: LoopGraphNodeStatusSchema,
  sessionId: z.string().nullable(),
  commitSha: z.string().nullable(),
  rounds: z.number().int().min(0),
  lastError: z.string().nullable(),
  summary: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type LoopGraphNode = z.infer<typeof LoopGraphNodeSchema>;

export const LoopGraphSchema = z.object({
  runKey: z.string().min(1),
  source: LoopGraphSourceSchema,
  revision: z.number().int().min(1),
  currentNodeId: z.string().nullable(),
  /** In `position` order. */
  nodes: z.array(LoopGraphNodeSchema).min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LoopGraph = z.infer<typeof LoopGraphSchema>;

export const LoopGraphActionSchema = z.enum(["retry_node", "skip_node", "edit_node"]);
export type LoopGraphAction = z.infer<typeof LoopGraphActionSchema>;

export const LoopGraphActParamsSchema = z
  .object({
    project: z.string().min(1),
    /** The work item key whose graph it is, such as `CYC-390`. */
    key: z.string().min(1),
    nodeId: z.string().min(1),
    action: LoopGraphActionSchema,
    /** `edit_node` only; at least one of the three. */
    title: z.string().trim().min(1).max(200).optional(),
    goal: z.string().trim().min(1).max(4000).optional(),
    verify: z.array(z.string().trim().min(1).max(500)).min(1).max(20).optional(),
    actor: z.string().min(1).max(100),
    actorKind: LoopActorKindSchema,
  })
  .refine((p) => {
    const edits = p.title !== undefined || p.goal !== undefined || p.verify !== undefined;
    return p.action === "edit_node" ? edits : !edits;
  });
export type LoopGraphActParams = z.infer<typeof LoopGraphActParamsSchema>;

export const LoopGraphActResultSchema = z.object({
  key: z.string().min(1),
  nodeId: z.string().min(1),
  action: LoopGraphActionSchema,
  /** The run's phase after the action: `graph_plan` when a blocked run was put back. */
  phase: z.string().min(1),
  graph: LoopGraphSchema,
});
export type LoopGraphActResult = z.infer<typeof LoopGraphActResultSchema>;

export const LoopCardSchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  /** The issue type's name, or null when unset. */
  type: z.string().nullable(),
  priority: z.string().nullable(),
  /** Label names as the tracker has them now. */
  labels: z.array(z.string()),
  /** For a card marked 待批准: a short summary of why; null otherwise or when none could be read. */
  pendingReason: z.string().nullable(),
  /** The parent issue (an Epic, say); null for a top-level card. Older servers leave it out. */
  parent: z
    .object({ key: z.string().min(1), title: z.string() })
    .nullable()
    .optional(),
  /** The Loop phase of a card the Loop is working on (from the run record), and when that phase began. */
  phase: z.object({ name: z.string().min(1), since: z.string().min(1) }).nullable(),
  /** The run's Task Graph in short; left out when the run has none. */
  graph: LoopGraphSummarySchema.optional(),
});
export type LoopCard = z.infer<typeof LoopCardSchema>;

export const LoopColumnSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  stateType: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]),
  cards: z.array(LoopCardSchema),
});
export type LoopColumn = z.infer<typeof LoopColumnSchema>;

export const LoopBoardSchema = z.object({
  project: z.string().min(1),
  /** By stateType (backlog first), then board order. */
  columns: z.array(LoopColumnSchema),
  /** True when the tracker could not be read and this is the last good read. */
  stale: z.boolean(),
  /** ISO time the tracker was last read successfully. */
  readAt: z.string().min(1),
});
export type LoopBoard = z.infer<typeof LoopBoardSchema>;

export const LoopRunFilterSchema = z.object({ state: LoopRunStateSchema.optional() });
export const LoopApiRunsListParamsSchema = z.object({
  project: z.string().min(1),
  filter: LoopRunFilterSchema.optional(),
});
export type LoopApiRunsListParams = z.infer<typeof LoopApiRunsListParamsSchema>;

export const LoopRunSummarySchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  kind: z.enum(["dev", "research"]),
  phase: z.string().min(1),
  state: LoopRunStateSchema,
  round: z.number().int().min(0),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LoopRunSummary = z.infer<typeof LoopRunSummarySchema>;
export const LoopApiRunsListResultSchema = z.object({
  project: z.string().min(1),
  runs: z.array(LoopRunSummarySchema),
});
export type LoopApiRunsListResult = z.infer<typeof LoopApiRunsListResultSchema>;

export const LoopRunGetParamsSchema = z.object({
  project: z.string().min(1),
  key: z.string().min(1),
});
export type LoopRunGetParams = z.infer<typeof LoopRunGetParamsSchema>;

export const LoopRunDetailSchema = LoopRunSummarySchema.extend({
  blockedReason: z.string().nullable(),
  sessions: z.array(LoopSessionRefSchema),
  prUrl: z.string().nullable(),
  /** The latest 50 events of the run, oldest first. */
  events: z.array(z.object({ ts: z.string().min(1), kind: z.string().min(1) })).max(50),
  /** The last time the loop reported it was working on the run, or null when it never has. */
  heartbeat: z.object({ at: z.string().min(1), detail: z.string().nullable() }).nullable(),
  /** The run's Task Graph; left out when it has none. */
  graph: LoopGraphSchema.optional(),
});
export type LoopRunDetail = z.infer<typeof LoopRunDetailSchema>;

export const LoopNoticeKindSchema = z.enum([
  "permission",
  "blocked",
  "review",
  "stuck",
  "intent_stuck",
  "supervisor",
  "operator",
]);
export type LoopNoticeKind = z.infer<typeof LoopNoticeKindSchema>;

export const LoopNoticeSchema = z.object({
  /** Stable while the Notice lasts: `<project>:<source>:<…>`. */
  id: z.string().min(1),
  project: z.string().min(1),
  kind: LoopNoticeKindSchema,
  /** The work item key, such as `CYC-390`; null for a Notice about the Project itself (a `supervisor` one). */
  key: z.string().min(1).nullable(),
  session: LoopSessionRefSchema.nullable(),
  text: z.string(),
  at: z.string().min(1),
});
export type LoopNotice = z.infer<typeof LoopNoticeSchema>;
export const LoopNoticesListParamsSchema = z.object({ project: z.string().min(1).optional() });
export const LoopNoticesListResultSchema = z.object({ notices: z.array(LoopNoticeSchema) });
export type LoopNoticesListResult = z.infer<typeof LoopNoticesListResultSchema>;

export const LoopTicketsActParamsSchema = z.object({
  project: z.string().min(1),
  verb: z.enum(["approve", "return", "to_backlog", "to_todo"]),
  keys: z.array(z.string().min(1)).min(1).max(50),
  reason: z.string().max(2000).optional(),
  /** Approve writes nothing unless this is true. */
  confirmed: z.boolean(),
  actor: z.string().min(1).max(100),
  actorKind: LoopActorKindSchema,
});
export type LoopTicketsActParams = z.infer<typeof LoopTicketsActParamsSchema>;

/** Why a ticket was skipped: it is not where the verb expects it. */
export const LoopSkipReasonSchema = z.enum([
  "not_found",
  "not_in_backlog",
  "not_pending",
  "not_allowed",
]);
/** Why a ticket failed: a fixed word, never the tracker's text. */
export const LoopFailReasonSchema = z.enum([
  "offline",
  "forbidden",
  "conflict",
  "label_missing",
  "refused",
]);
export const LoopTicketResultSchema = z.discriminatedUnion("status", [
  z.object({ key: z.string(), status: z.literal("ok") }),
  z.object({ key: z.string(), status: z.literal("skipped"), reason: LoopSkipReasonSchema }),
  z.object({ key: z.string(), status: z.literal("failed"), reason: LoopFailReasonSchema }),
]);
export type LoopTicketResult = z.infer<typeof LoopTicketResultSchema>;
export const LoopTicketsActResultSchema = z.object({ results: z.array(LoopTicketResultSchema) });
export type LoopTicketsActResult = z.infer<typeof LoopTicketsActResultSchema>;

/** Puts intents the loop gave up on back in the queue: one by `id`, or all of a ticket by `key`; exactly one of the two. */
export const LoopIntentsRetryParamsSchema = z
  .object({
    project: z.string().min(1),
    id: z.number().int().min(1).optional(),
    key: z.string().min(1).optional(),
    actor: z.string().min(1).max(100),
    actorKind: LoopActorKindSchema,
  })
  .refine((p) => (p.id === undefined) !== (p.key === undefined));
export type LoopIntentsRetryParams = z.infer<typeof LoopIntentsRetryParamsSchema>;
export const LoopIntentsRetryResultSchema = z.object({ retried: z.number().int().min(0) });
export type LoopIntentsRetryResult = z.infer<typeof LoopIntentsRetryResultSchema>;

export const LoopTicketGetParamsSchema = z.object({
  project: z.string().min(1),
  key: z.string().min(1),
});
export type LoopTicketGetParams = z.infer<typeof LoopTicketGetParamsSchema>;

export const LoopTicketActionSchema = z.enum(["approve", "return", "to_backlog", "to_todo"]);
export type LoopTicketAction = z.infer<typeof LoopTicketActionSchema>;
/** Whether a conversation may be opened: `new` a fresh one, `watch` look only, `none` nothing. */
export const LoopTicketChatSchema = z.enum(["new", "watch", "none"]);
export type LoopTicketChat = z.infer<typeof LoopTicketChatSchema>;

/** Why a Blocked or escalated ticket needs a person, from the Loop's own run and Notice records. */
export const LoopTicketAttentionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("blocked"),
    text: z.string(),
    session: LoopSessionRefSchema.nullable(),
  }),
  z.object({
    kind: z.literal("review"),
    text: z.string(),
    prUrl: z.string().nullable(),
  }),
]);
export type LoopTicketAttention = z.infer<typeof LoopTicketAttentionSchema>;

export const LoopTicketDetailSchema = z.object({
  identifier: z.string().min(1),
  title: z.string(),
  priority: z.string().nullable(),
  /** The column's name. */
  column: z.string(),
  actions: z.array(LoopTicketActionSchema),
  chat: LoopTicketChatSchema,
  /** The ticket's text as written (Markdown). */
  body: z.string(),
  attention: LoopTicketAttentionSchema.optional(),
  /** The items of its acceptance criteria section. */
  acceptance: z.array(z.string()),
  /** Pull or merge request addresses (https only). */
  links: z.array(z.string()),
  /** The Task Graph of the ticket's run; left out when it has none. */
  graph: LoopGraphSchema.optional(),
});
export type LoopTicketDetail = z.infer<typeof LoopTicketDetailSchema>;

export const LoopRunCancelParamsSchema = z.object({
  project: z.string().min(1),
  key: z.string().min(1),
  actor: z.string().min(1).max(100),
  actorKind: z.enum(["desktop", "operator", "supervisor"]),
});
export type LoopRunCancelParams = z.infer<typeof LoopRunCancelParamsSchema>;
export const LoopRunCancelResultSchema = z.object({ cancelled: z.boolean() });
export type LoopRunCancelResult = z.infer<typeof LoopRunCancelResultSchema>;

export const LoopStatusResultSchema = z.object({
  version: z.string().min(1),
  /** When this server process started. */
  restartedAt: z.string().min(1),
  projects: z.array(
    z.object({
      project: z.string().min(1),
      workers: z.number().int().min(0),
      /** What the runs that are not finished are doing. */
      working: z.array(
        z.object({
          key: z.string().min(1),
          kind: z.enum(["dev", "research"]),
          phase: z.string().min(1),
        }),
      ),
    }),
  ),
});
export type LoopStatusResult = z.infer<typeof LoopStatusResultSchema>;

/** Paginated chronological progress feed of a Loop Project: runs + graph nodes + planning rounds (CYC-534). */
export const LoopTimelineListParamsSchema = z.object({
  project: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(30),
  before: z.string().min(1).optional(),
});
export type LoopTimelineListParams = z.input<typeof LoopTimelineListParamsSchema>;

export const LoopTimelineStepStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
]);
export type LoopTimelineStepStatus = z.infer<typeof LoopTimelineStepStatusSchema>;

export const LoopTimelineStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  role: SessionOriginRoleSchema,
  status: LoopTimelineStepStatusSchema,
  sessionId: z.string().min(1).nullable(),
  startedAt: z.string().min(1).nullable(),
  finishedAt: z.string().min(1).nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  /** Ids of the steps this one waits for; only Task Graph nodes have any. */
  dependsOn: z.array(z.string().min(1)).default([]),
});
export type LoopTimelineStep = z.infer<typeof LoopTimelineStepSchema>;

export const LoopTimelineRunEntrySchema = z.object({
  entryKind: z.literal("run"),
  id: z.string().min(1),
  key: z.string().min(1),
  title: z.string(),
  kind: z.enum(["dev", "research"]),
  phase: z.string().min(1),
  state: LoopRunStateSchema,
  round: z.number().int().min(0),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  prUrl: z.string().nullable(),
  blockedReason: z.string().nullable(),
  graph: LoopGraphSummarySchema.nullable(),
  steps: z.array(LoopTimelineStepSchema),
});
export type LoopTimelineRunEntry = z.infer<typeof LoopTimelineRunEntrySchema>;

export const LoopTimelinePlanItemSchema = z.object({
  key: z.string().min(1),
  state: z.enum([
    "waiting",
    "shape",
    "shape_qa",
    "writing",
    "done",
    "stopped",
    "asked",
    "abandoned",
  ]),
  round: z.number().int().min(0),
  resultKind: z.enum(["rewrite", "split"]).nullable(),
  splitCount: z.number().int().min(0),
  stoppedReason: z.string().nullable(),
  shapeSessionId: z.string().min(1).nullable(),
  qaSessionId: z.string().min(1).nullable(),
});
export type LoopTimelinePlanItem = z.infer<typeof LoopTimelinePlanItemSchema>;

export const LoopTimelinePlanEntrySchema = z.object({
  entryKind: z.literal("plan"),
  id: z.string().min(1),
  planId: z.string().min(1),
  phase: z.enum(["triage", "shaping", "finished", "abandoned"]),
  state: z.enum(["active", "done"]),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  endedAt: z.string().min(1).nullable(),
  candidateCount: z.number().int().min(0),
  stoppedReason: z.string().nullable(),
  triageSessionId: z.string().min(1).nullable(),
  items: z.array(LoopTimelinePlanItemSchema),
});
export type LoopTimelinePlanEntry = z.infer<typeof LoopTimelinePlanEntrySchema>;

export const LoopTimelineEntrySchema = z.discriminatedUnion("entryKind", [
  LoopTimelineRunEntrySchema,
  LoopTimelinePlanEntrySchema,
]);
export type LoopTimelineEntry = z.infer<typeof LoopTimelineEntrySchema>;

export const LoopTimelineListResultSchema = z.object({
  project: z.string().min(1),
  entries: z.array(LoopTimelineEntrySchema),
  hasMore: z.boolean(),
  nextBefore: z.string().min(1).nullable(),
  knownSessionIds: z.array(z.string().min(1)),
});
export type LoopTimelineListResult = z.infer<typeof LoopTimelineListResultSchema>;
