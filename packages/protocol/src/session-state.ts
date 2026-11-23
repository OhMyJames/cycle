// What a session is doing besides its turns, told by the agent and kept in the history (docs/protocol.md §9): the tasks
// it runs in the background that are not sub-agents, and the goal the user set it (CYCL-87). Each is a `session/update`
// the daemon writes and replays like any other, so a client rebuilds them from the history.
import { z } from "zod";

/** The `sessionUpdate` of a background task's news. */
export const TASK_UPDATE = "_cycle/task_update";

/** What kind of task: a command, a watcher, a workflow, an MCP server's task, or one not known by name. */
export const TaskKindSchema = z.enum(["shell", "monitor", "workflow", "mcp", "other"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/** Where a task is: running, ended (how), or gone from the agent's list without an end (`unknown`, never a success). */
export const TaskStateSchema = z.enum(["running", "completed", "failed", "stopped", "unknown"]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** A task's news. Fields left out keep what the last one said; `kind` is on the first. */
export const TaskUpdateSchema = z.object({
  sessionUpdate: z.literal(TASK_UPDATE),
  taskId: z.string(),
  kind: TaskKindSchema.optional(),
  title: z.string().optional(),
  toolCallId: z.string().optional(),
  parentId: z.string().optional(),
  state: TaskStateSchema,
});
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;

/** The `sessionUpdate` of the session's goal. */
export const GOAL_UPDATE = "_cycle/goal_update";

export const GoalSchema = z.object({
  /** The goal as the user wrote it. */
  condition: z.string(),
  /** How many times it was checked and found not met. */
  iterations: z.number().int().nonnegative(),
  /** When it was set, in milliseconds since the epoch. */
  setAt: z.number(),
  /** Why it was found not met the last time. */
  lastReason: z.string().optional(),
});
export type Goal = z.infer<typeof GoalSchema>;

/** The whole goal after each change; `null` when it was cleared or met. The last one is the goal. */
export const GoalUpdateSchema = z.object({
  sessionUpdate: z.literal(GOAL_UPDATE),
  goal: GoalSchema.nullable(),
});
export type GoalUpdate = z.infer<typeof GoalUpdateSchema>;

/** The `sessionUpdate` of a sub-agent's conversation, carried in its parent session (docs/protocol.md §9, CYCL-134). */
export const CHILD_UPDATE = "_cycle/child_update";

/** What a sub-agent's conversation may hold: what it said, thought and called. Its state is only `subagent_update`'s. */
export const CHILD_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "agent_message",
  "agent_message_chunk",
  "agent_thought",
  "agent_thought_chunk",
  "tool_call_update",
  "tool_call_content_chunk",
]);

/** One update of a sub-agent's conversation. `childId` is its `subagent_update`'s `sessionId`. */
export const ChildUpdateSchema = z.object({
  sessionUpdate: z.literal(CHILD_UPDATE),
  childId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
});
export type ChildUpdate = z.infer<typeof ChildUpdateSchema>;

/** The `sessionUpdate` of what is set to wake the session later (docs/protocol.md §9, CYCL-146). */
export const SCHEDULE_UPDATE = "_cycle/schedule_update";

/** One thing set to wake the session: a cron (CronCreate, /loop) or a wakeup (ScheduleWakeup). */
export const ScheduledJobSchema = z.object({
  id: z.string(),
  kind: z.enum(["cron", "wakeup"]),
  /** Its five-field cron expression, in the local time of the machine the agent runs on. */
  schedule: z.string(),
  /** The schedule in words, when the agent said it. */
  humanSchedule: z.string().optional(),
  /** Fires on every match until deleted or expired; false: once, then it is gone. */
  recurring: z.boolean(),
  /** Saved in the project, outliving the session; what is known of it is what was last heard. */
  durable: z.boolean(),
  /** What it will say when it fires, cut short. */
  prompt: z.string(),
  /** When it is expected to fire next, in milliseconds: worked out, so a guess, not a promise. */
  nextFireAt: z.number().optional(),
  /** The call that set it, to go back to. */
  toolCallId: z.string().optional(),
});
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>;

/**
 * The whole list after each change; the last one is the list. `dormant`: the agent's process is gone, and what is not
 * durable fires only if the session is used again before it is due.
 */
export const ScheduleUpdateSchema = z.object({
  sessionUpdate: z.literal(SCHEDULE_UPDATE),
  jobs: z.array(ScheduledJobSchema),
  dormant: z.boolean().optional(),
});
export type ScheduleUpdate = z.infer<typeof ScheduleUpdateSchema>;
