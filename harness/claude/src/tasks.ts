import type {
  BackgroundTask,
  Item,
  TaskKind,
  TaskStatus,
  TaskUsage,
  TurnOrigin,
} from "@cycle/protocol";
import type { WireBackgroundTask, WireMessage, WireOrigin } from "./wire.ts";

/** A `task` item. */
export type TaskItem = Extract<Item, { kind: "task" }>;

/** What Claude Code's kind of task is, as the conversation shows it. */
export function taskKind(type: string | undefined): TaskKind {
  switch (type) {
    case "local_agent":
    case "remote_agent":
      return "agent";
    case "local_bash":
      return "command";
    case "local_workflow":
      return "workflow";
    default:
      return "other";
  }
}

/** Where a task is, from `task_updated`'s or `task_notification`'s word for it. */
export function taskStatus(status: string | undefined): TaskStatus | null {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
    case "completed":
    case "failed":
    case "stopped":
      return status;
    case "killed":
      return "stopped";
    default:
      return null;
  }
}

export function taskUsage(usage: WireMessage["usage"]): TaskUsage | null {
  if (!usage || usage.total_tokens === undefined) return null;
  return {
    tokens: usage.total_tokens,
    toolUses: usage.tool_uses ?? 0,
    durationMs: usage.duration_ms ?? 0,
  };
}

/** A task as it starts, before Claude Code says more of it. */
export function newTask(
  id: string,
  fields: Partial<Omit<TaskItem, "id" | "kind">> & Pick<TaskItem, "task" | "description">,
): TaskItem {
  return {
    id,
    kind: "task",
    taskId: null,
    agent: null,
    prompt: null,
    status: "running",
    background: false,
    usage: null,
    summary: null,
    error: null,
    ...fields,
  };
}

/** The background tasks Claude Code listed, as the owner may stop them. Watchers are no work. */
export function backgroundTasks(
  tasks: WireBackgroundTask[],
  itemOf: (taskId: string) => string | null,
): BackgroundTask[] {
  return tasks
    .filter((task) => task.ambient !== true)
    .map((task) => ({
      id: task.task_id,
      task: taskKind(task.task_type),
      description: task.description,
      agent: task.subagent_type ?? null,
      itemId: itemOf(task.task_id),
    }));
}

/**
 * Whether a message that comes when no turn runs is the agent beginning one by itself, as it does
 * to take up a task's news. A helper agent's messages belong to its task, not to a turn.
 */
export function agentBegins(message: WireMessage): boolean {
  if (message.parent_tool_use_id) return false;
  return message.type === "assistant" || message.type === "stream_event";
}

/** Who a turn the owner did not begin is for, from the `origin` Claude Code gives its result. */
export function turnOrigin(origin: WireOrigin | undefined, taskId: string | null): TurnOrigin {
  switch (origin?.kind) {
    case "peer":
      return { kind: "peer", from: origin.fromSession ?? origin.from ?? null };
    case "task-notification":
      return { kind: "task", taskId };
    default:
      return taskId ? { kind: "task", taskId } : { kind: "agent" };
  }
}

/** A task's news as Claude Code keeps it in the conversation, for the agent to read. */
export interface StoredNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: TaskStatus | null;
  summary: string | null;
}

const NOTIFICATION = /^<task-notification>/;

function tag(text: string, name: string): string | null {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return found?.[1]?.trim() || null;
}

/** Reads a stored `<task-notification>`, or answers null for any other text. */
export function readNotification(text: string): StoredNotification | null {
  if (!NOTIFICATION.test(text.trimStart())) return null;
  return {
    taskId: tag(text, "task-id"),
    toolUseId: tag(text, "tool-use-id"),
    status: taskStatus(tag(text, "status") ?? undefined),
    summary: tag(text, "summary"),
  };
}
