import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { type LedgerEntry, TaskLedger } from "./task-ledger.ts";

/** In a `subagent_update`'s `_meta`: what the SDK says of the task beyond what ACP has a field for (decision 0014). */
export const SUBAGENT_META = "cycle/subagent";

type Task = {
  task_id: string;
  run_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  summary?: string;
  last_tool_name?: string;
  is_backgrounded?: boolean;
  parent_task_id?: string;
  task_type?: string;
  status?: string;
  patch?: { status?: string; description?: string; is_backgrounded?: boolean; error?: string };
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  ambient?: boolean;
  skip_transcript?: boolean;
};

/** Tools the SDK uses inside a sub-agent that are not the agent's own work. */
const INTERNAL_TOOLS: ReadonlySet<string> = new Set(["SubagentHandback"]);

type Known = LedgerEntry & { toolCallId: string | undefined; background: boolean };

type Ended = { stopReason: "end_turn" | "cancelled" } | { stopReason: "error"; error: unknown };

/** How a task's end is told as a state: ACP's idle, with the reason it stopped. */
const endOf = (status: string | undefined, why: string | undefined): Ended | undefined => {
  if (status === "completed") return { stopReason: "end_turn" };
  if (status === "stopped" || status === "killed") return { stopReason: "cancelled" };
  if (status === "failed") {
    return { stopReason: "error", error: { code: -32603, message: why || "The sub-agent failed" } };
  }
  return undefined;
};

/**
 * The SDK's `task_*` messages as ACP `subagent_update`s: a sub-agent the model started (the Agent
 * tool) is announced, reports progress, and ends. Announcement only: the sub-agent's own transcript
 * is not routed, so the child's id is the task's and no client can open it as a session.
 *
 * A task that is not an agent (a background shell, a watcher, a task that is only housekeeping) is
 * not a sub-agent and is left out. Progress is only for a task that was announced.
 */
export class Subagents {
  /** The tool call each announced task came from: later messages do not always say. Only a background one is listed. */
  readonly #known = new TaskLedger<Known>((task) => task.background);

  /**
   * The task each Agent call began, kept after the task ends: a sub-agent's last messages can come after its end is
   * told, and its messages name the call (`parent_tool_use_id`), not the task (CYCL-134).
   */
  readonly #byCall = new Map<string, string>();
  /** Every task announced to the client. Only those may have a conversation: ACP announces a child before its updates. */
  readonly #announced = new Set<string>();

  /** The announced sub-agent that the Agent call `toolCallId` started. */
  childOf(toolCallId: string): string | undefined {
    return this.#byCall.get(toolCallId);
  }

  /** Whether `id` is a sub-agent the client was told of. */
  announced(id: string): boolean {
    return this.#announced.has(id);
  }

  /** Whether `id` is a sub-agent that was announced and has not ended: one that can be stopped (CYCL-143). */
  running(id: string): boolean {
    return this.#known.has(id);
  }

  get hasBackground(): boolean {
    return this.#known.some((task) => task.background);
  }

  /** The SDK sends a replacement list, even between prompts. Absence gives no stop reason. */
  reconcile(tasks: readonly Task[]): SessionUpdate[] {
    return this.#known.reconcile(
      tasks,
      (task): task is Task => (task as Task).task_type === "local_agent" && !(task as Task).ambient,
      (task) => this.update({ ...task, subtype: "task_started", is_backgrounded: true }),
      (id) => this.#make({ task_id: id }, undefined, undefined, "unknown"),
    );
  }

  update(message: { subtype: string } & Record<string, unknown>): SessionUpdate | undefined {
    const task = message as unknown as Task;
    if (typeof task.task_id !== "string") return undefined;
    if (this.#known.stale(task.task_id, task.run_id)) return undefined;
    if (message.subtype === "task_started") {
      const known = this.#known.get(task.task_id);
      const agent = task.task_type === undefined || task.task_type === "local_agent";
      if (!agent || task.ambient === true || task.skip_transcript === true) return undefined;
      const previous = !task.run_id || !known?.run || known.run === task.run_id ? known : undefined;
      this.#known.set(task.task_id, {
        toolCallId: task.tool_use_id ?? previous?.toolCallId,
        run: task.run_id ?? previous?.run,
        background: task.is_backgrounded ?? previous?.background ?? false,
        unknown: false,
      });
      this.#announced.add(task.task_id);
      const call = task.tool_use_id ?? previous?.toolCallId;
      if (call !== undefined) this.#byCall.set(call, task.task_id);
      // It can be stopped alone (ACP v2 `capabilities.cancel`, CYCL-143): the SDK's `stopTask`.
      return {
        ...this.#make(task, { state: "running" }, task.description),
        capabilities: { cancel: {} },
      } as SessionUpdate;
    }
    const known = this.#known.ofRun(task.task_id, task.run_id);
    if (known === undefined) return undefined;
    if (message.subtype === "task_progress") {
      const wasUnknown = known.unknown;
      known.unknown = false;
      known.background = task.is_backgrounded ?? known.background;
      return this.#make(
        wasUnknown ? { ...task, is_backgrounded: known.background } : task,
        { state: "running" },
        task.description,
      );
    }
    if (message.subtype === "task_notification") {
      const end = endOf(task.status, task.summary);
      if (end === undefined) return undefined;
      const update = this.#make(task, { state: "idle", ...end });
      this.#known.delete(task.task_id);
      return update;
    }
    if (message.subtype === "task_updated") {
      const patch = task.patch ?? {};
      const end = endOf(patch.status, patch.error);
      const reconfirmed = known.unknown && patch.is_backgrounded !== undefined;
      if (patch.is_backgrounded !== undefined) {
        known.background = patch.is_backgrounded;
        known.unknown = false;
      }
      // A task that moves to the background later says so here, and nowhere else (SDK: `task_updated`).
      if (
        end === undefined &&
        patch.description === undefined &&
        patch.is_backgrounded === undefined
      ) {
        return undefined;
      }
      const update = this.#make(
        patch.is_backgrounded === undefined
          ? task
          : { ...task, is_backgrounded: patch.is_backgrounded },
        end ? { state: "idle", ...end } : reconfirmed ? { state: "running" } : undefined,
        patch.description,
      );
      if (end !== undefined) this.#known.delete(task.task_id);
      return update;
    }
    return undefined;
  }

  /** The process is gone: the sub-agents that were running are over. */
  endAll(): SessionUpdate[] {
    return this.#known
      .endAll()
      .map((id) => this.#make({ task_id: id }, { state: "idle", stopReason: "cancelled" }));
  }

  #make(task: Task, state: object | undefined, title?: string, status?: "unknown"): SessionUpdate {
    const meta: Record<string, unknown> = {};
    if (status) meta.status = status;
    const toolCallId = task.tool_use_id ?? this.#known.get(task.task_id)?.toolCallId;
    if (toolCallId !== undefined) meta.toolCallId = toolCallId;
    if (task.is_backgrounded !== undefined) meta.background = task.is_backgrounded;
    if (task.parent_task_id !== undefined) meta.parentId = task.parent_task_id;
    if (task.summary !== undefined && task.status === undefined) meta.summary = task.summary;
    // The SDK's own hand-back at a sub-agent's end is not a tool it used (seen with a real model).
    if (task.last_tool_name !== undefined && !INTERNAL_TOOLS.has(task.last_tool_name))
      meta.lastTool = task.last_tool_name;
    if (task.usage !== undefined) {
      meta.usage = {
        tokens: task.usage.total_tokens ?? 0,
        toolUses: task.usage.tool_uses ?? 0,
        durationMs: task.usage.duration_ms ?? 0,
      };
    }
    return {
      sessionUpdate: "subagent_update",
      sessionId: task.task_id,
      ...(title ? { title } : {}),
      ...(task.subagent_type ? { description: task.subagent_type } : {}),
      ...(state ? { state } : {}),
      _meta: { [SUBAGENT_META]: meta },
    } as SessionUpdate;
  }
}
