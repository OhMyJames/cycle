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
