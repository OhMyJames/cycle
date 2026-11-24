import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { type LedgerEntry, TaskLedger } from "./task-ledger.ts";

/** The `sessionUpdate` of a background task that is not a sub-agent (docs/protocol.md §9, CYCL-87). */
export const TASK_UPDATE = "_cycle/task_update";

/** The `sessionUpdate` of the session's goal (docs/protocol.md §9, CYCL-87). */
export const GOAL_UPDATE = "_cycle/goal_update";

type Kind = "shell" | "monitor" | "workflow" | "mcp" | "other";
type State = "running" | "completed" | "failed" | "stopped" | "unknown";

type Task = {
  task_id?: unknown;
  run_id?: string;
  tool_use_id?: string;
  task_type?: string;
  description?: string;
  parent_task_id?: string;
  status?: string;
  patch?: { status?: string; description?: string };
  ambient?: boolean;
  skip_transcript?: boolean;
};

/**
 * The SDK's `task_type` as one of the protocol's words. Only `local_agent` is a sub-agent, told elsewhere. A Monitor's
 * task is `local_bash` like any background command (SDK 0.3.327): only the tool that started it, when known, tells.
 */
export const kindOf = (taskType: string | undefined, toolName?: string): Kind => {
  if (toolName === "Monitor") return "monitor";
  const type = taskType ?? "";
  if (/bash|shell/.test(type)) return "shell";
  if (/monitor/.test(type)) return "monitor";
  if (/workflow/.test(type)) return "workflow";
  if (/mcp/.test(type)) return "mcp";
  return "other";
};

const endOf = (status: string | undefined): State | undefined => {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "stopped" || status === "killed") return "stopped";
  return undefined;
};

/** Not activity: housekeeping and the watchers Claude Code starts by itself (SDK: `ambient`, `skip_transcript`). */
const quiet = (task: Task) => task.ambient === true || task.skip_transcript === true;

/**
 * The SDK's `task_*` messages and its background list, for the tasks that are not sub-agents: a background command, a
 * watcher, a workflow, an MCP server's task. Each is announced with its kind, and told again when it ends, or when it
 * leaves the list with no end (`unknown`). Announcement only: nothing here stops a task.
 */
export class BackgroundTasks {
  readonly #known = new TaskLedger<LedgerEntry>();
  /** Tasks told as ended, with the run that ended: a list that lags behind the end must not bring them back. */
  readonly #ended = new Map<string, string | undefined>();
  /** The tool calls that start a task of a kind its `task_type` does not say (a Monitor), by call id. */
  readonly #calls = new Map<string, string>();
  /** The kind each task was found to be: a later list entry, which names no call, must not undo it. */
  readonly #kinds = new Map<string, Kind>();

  /** A tool call of the session, as it is seen: a task it starts may need its name to be told right. */
  noteCall(toolCallId: string, name: string): void {
    if (kindOf(undefined, name) !== "other") this.#calls.set(toolCallId, name);
  }

  /** A task told as running, not lost: the process must stay up for it (a command, a watcher). */
  get hasRunning(): boolean {
    return this.#known.some();
  }

  #end(id: string, run: string | undefined): void {
    this.#known.delete(id);
    this.#ended.set(id, run);
  }

  /** Whether a list entry is one of these tasks, and not one already told as ended. */
  #listed = (task: Task): task is Task & { task_id: string } => {
    // Every entry of the list names its type (SDK); one that does not is not known to be ours to tell.
    if (
      typeof task.task_id !== "string" ||
      task.task_type === undefined ||
      task.task_type === "local_agent" ||
      quiet(task)
    )
      return false;
    const ended = this.#ended.get(task.task_id);
    return !(
      this.#ended.has(task.task_id) &&
      (!task.run_id || ended === undefined || task.run_id <= ended)
    );
  };

  /** The SDK sends the whole list after each change. A task gone from it with no end is unknown, not finished. */
  reconcile(tasks: readonly Task[]): SessionUpdate[] {
    return this.#known.reconcile(
      tasks,
      this.#listed,
      (task) => {
        const known = this.#known.get(task.task_id);
        this.#known.set(task.task_id, { run: task.run_id ?? known?.run, unknown: false });
        return this.#make(task.task_id, "running", task);
      },
      (id) => this.#make(id, "unknown"),
    );
  }

  update(message: { subtype: string } & Record<string, unknown>): SessionUpdate | undefined {
    const task = message as Task;
    if (typeof task.task_id !== "string") return undefined;
    const id = task.task_id;
    if (this.#known.stale(id, task.run_id)) return undefined;
    if (message.subtype === "task_started") {
      if (task.task_type === undefined || task.task_type === "local_agent" || quiet(task))
        return undefined;
      this.#known.set(id, { run: task.run_id ?? this.#known.get(id)?.run, unknown: false });
      this.#ended.delete(id);
      if (task.tool_use_id !== undefined) {
        const name = this.#calls.get(task.tool_use_id);
        this.#calls.delete(task.tool_use_id);
        if (name !== undefined) this.#kinds.set(id, kindOf(task.task_type, name));
      }
      return this.#make(id, "running", task);
    }
    const known = this.#known.ofRun(id, task.run_id);
    if (known === undefined) return undefined;
    if (message.subtype === "task_notification") {
      const end = endOf(task.status);
      if (end === undefined) return undefined;
      this.#end(id, known.run);
      return this.#make(id, end);
    }
    if (message.subtype === "task_updated") {
      const end = endOf(task.patch?.status);
      if (end !== undefined) {
        this.#end(id, known.run);
        return this.#make(id, end);
      }
      if (task.patch?.description === undefined) return undefined;
      known.unknown = false;
      return this.#make(id, "running", { description: task.patch.description });
    }
    if (message.subtype === "task_progress" && known.unknown) {
      known.unknown = false;
      return this.#make(id, "running");
    }
    return undefined;
  }

  /** The process is gone, and the tasks it ran with it. */
  endAll(): SessionUpdate[] {
    return this.#known.endAll().map((id) => this.#make(id, "stopped"));
  }

  #make(taskId: string, state: State, task?: Task): SessionUpdate {
    return {
      sessionUpdate: TASK_UPDATE,
      taskId,
      ...(task?.task_type !== undefined
        ? { kind: this.#kinds.get(taskId) ?? kindOf(task.task_type) }
        : {}),
      ...(task?.description ? { title: task.description } : {}),
      ...(task?.tool_use_id !== undefined ? { toolCallId: task.tool_use_id } : {}),
      ...(task?.parent_task_id !== undefined ? { parentId: task.parent_task_id } : {}),
      state,
    } as unknown as SessionUpdate;
  }
}

/** The SDK's `active_goal` as the protocol's goal: the same fields, in its words. Undefined when it is not one. */
export const goalUpdateOf = (message: unknown): SessionUpdate | undefined => {
  const value = (message as { value?: unknown }).value;
  if (value === null) return { sessionUpdate: GOAL_UPDATE, goal: null } as unknown as SessionUpdate;
  if (typeof value !== "object" || value === undefined) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.condition !== "string") return undefined;
  return {
    sessionUpdate: GOAL_UPDATE,
    goal: {
      condition: v.condition,
      iterations:
        typeof v.iterations === "number" && v.iterations >= 0 ? Math.floor(v.iterations) : 0,
      setAt: typeof v.set_at === "number" ? v.set_at : 0,
      ...(typeof v.last_reason === "string" && v.last_reason !== ""
        ? { lastReason: v.last_reason }
        : {}),
    },
  } as unknown as SessionUpdate;
};
