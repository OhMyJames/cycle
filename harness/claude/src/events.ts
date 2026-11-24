import { randomUUID } from "node:crypto";
import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { ModelInfo, SDKMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { configOptions, PERMISSION_MODES, type PermissionMode } from "./config-options.ts";
import { notify, type SessionState } from "./session.ts";
import { goalUpdateOf } from "./tasks.ts";
import { compactedUsage, type PlanUsage } from "./usage.ts";

/** What these messages need of the adapter beyond the session: no more, so this does not reach into the lifecycle. */
export type AsideHost = {
  readonly planUsage: PlanUsage;
  readonly models: readonly ModelInfo[] | undefined;
  /** Background work changed: whether the process may be let go when idle is asked again. */
  scheduleIdle(session: SessionState): void;
};

// What a process says outside a turn's own conversation, told as the session's: the account's limits, a suggestion of
// what to say next, the goal, the background tasks and sub-agents, the commands, a retry, the mode it changed itself,
// a compaction. These can come between turns.

/** On a `notice`: Claude is trying its request again by itself (`META.retry`, docs/protocol.md §8). */
const RETRY = "cycle/retry";
/** What the person may say next, after a turn (`PROMPT_SUGGESTION_UPDATE` of `@cycle/protocol`, CYCL-225). */
const PROMPT_SUGGESTION_UPDATE = "_cycle/prompt_suggestion";

/** Announces the commands, unless they are the ones the clients were last told: a process that starts again has the same ones. */
export const announceCommands = async (
  client: AgentContext,
  session: SessionState,
  commands: readonly SlashCommand[],
) => {
  const update = commandsUpdate(commands);
  const key = JSON.stringify((update as { availableCommands: unknown }).availableCommands);
  if (key === session.commandsKey) return;
  await notify(client, session.id, update);
  // Only once it was sent: a list that did not get there is said again.
  session.commandsKey = key;
};

/** Announces live config options (discovered models & per-model effort levels) whenever they change. */
export const announceConfigOptions = async (
  client: AgentContext,
  session: SessionState,
  models: readonly ModelInfo[] | undefined,
) => {
  const options = configOptions(session, models);
  const key = JSON.stringify(options);
  if (key === session.configKey) return;
  const previous = session.configKey;
  session.configKey = key;
  try {
    await notify(client, session.id, {
      sessionUpdate: "config_option_update",
      configOptions: options,
    } as SessionUpdate);
  } catch (error) {
    if (session.configKey === key) session.configKey = previous;
    throw error;
  }
};

const commandsUpdate = (commands: readonly SlashCommand[]): SessionUpdate => {
  const seen = new Set<string>();
  const availableCommands = [];
  for (const command of commands) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    availableCommands.push({
      type: "command",
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { input: { type: "text", hint: command.argumentHint } } : {}),
    });
  }
  return { sessionUpdate: "available_commands_update", availableCommands } as SessionUpdate;
};

/** The SDK's `api_retry`, as the notice that says the request is being tried again (docs/protocol.md §8). */
const retryNotice = (m: Record<string, unknown>): SessionUpdate => {
  const n = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const attempt = n(m.attempt);
  const maxRetries = n(m.max_retries);
  const delayMs = n(m.retry_delay_ms);
  const status = n(m.error_status);
  return {
    sessionUpdate: "notice",
    severity: "info",
    title:
      attempt !== undefined && maxRetries !== undefined
        ? `Retrying the request (attempt ${attempt} of ${maxRetries})`
        : "Retrying the request",
    _meta: {
      [RETRY]: {
        ...(attempt !== undefined ? { attempt } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(status !== undefined ? { status } : {}),
      },
    },
  } as SessionUpdate;
};

/**
 * What a process says that is not part of a turn: the mode it changed itself (a plan approved),
 * a compaction, a new list of commands. These are the session's, and can come between turns.
 */
export const aside = async (
  lifecycle: AsideHost,
  client: AgentContext,
  session: SessionState,
  message: SDKMessage,
) => {
  if (message.type === "rate_limit_event") {
    await lifecycle.planUsage.tell(
      client,
      session,
      (message as { rate_limit_info?: unknown }).rate_limit_info,
    );
    return;
  }
  // What the person may say next (CYCL-225): the turn that just ended's, so not once another has begun, and only when
  // the last prompt asked for one (a process may still make one it was asked for before being told otherwise).
  if ((message as { type: string }).type === "prompt_suggestion") {
    const suggestion = (message as { suggestion?: unknown }).suggestion;
    if (
      session.suggestions &&
      (session.turn === undefined || session.turn.done) &&
      typeof suggestion === "string" &&
      suggestion.trim() !== ""
    )
      await notify(client, session.id, {
        sessionUpdate: PROMPT_SUGGESTION_UPDATE,
        suggestion,
      } as unknown as SessionUpdate);
    return;
  }
  // The goal the user set with /goal: told whole after each check (docs/protocol.md §9).
  if ((message as { type: string }).type === "active_goal") {
    const update = goalUpdateOf(message);
    if (update !== undefined) await notify(client, session.id, update);
    return;
  }
  if (message.type !== "system") return;
  const m = message as unknown as Record<string, unknown> & { subtype: string };
  if (message.subtype === "background_tasks_changed") {
    const updates = [
      ...session.subagents.reconcile(message.tasks),
      ...session.tasks.reconcile(message.tasks),
    ];
    lifecycle.scheduleIdle(session);
    for (const update of updates) await notify(client, session.id, update);
  } else if (m.subtype.startsWith("task_")) {
    const update = session.subagents.update(m);
    if (update !== undefined) {
      lifecycle.scheduleIdle(session);
      // A sub-agent that ended: what it left running ends first, as its own (docs/protocol.md §9).
      const sub = update as { sessionId: string; state?: { state?: string } };
      if (sub.state?.state === "idle")
        for (const call of session.transcripts.end(sub.sessionId))
          await notify(client, sub.sessionId, call);
      else if (sub.state?.state === "running") session.transcripts.resume(sub.sessionId);
      await notify(client, session.id, update);
    }
    const task = session.tasks.update(m);
    if (task !== undefined) {
      lifecycle.scheduleIdle(session);
      await notify(client, session.id, task);
    }
  } else if (m.subtype === "commands_changed") {
    await announceCommands(client, session, m.commands as SlashCommand[]);
  } else if (m.subtype === "api_retry") {
    // Claude tries the request again by itself: a state for the person to see, not a failure (docs/protocol.md §8).
    await notify(client, session.id, retryNotice(m));
  } else if (m.subtype === "status") {
    const mode = m.permissionMode as PermissionMode | undefined;
    if (
      mode !== undefined &&
      PERMISSION_MODES.includes(mode) &&
      mode !== session.mode &&
      session.modeChanging === 0
    ) {
      session.mode = mode;
      const options = configOptions(session, lifecycle.models);
      session.configKey = JSON.stringify(options);
      await notify(client, session.id, {
        sessionUpdate: "config_option_update",
        configOptions: options,
      } as SessionUpdate);
    }
    if (m.status === "compacting" && session.compaction === undefined) {
      session.compaction = randomUUID();
      await notify(client, session.id, {
        sessionUpdate: "compaction_update",
        compactionId: session.compaction,
        status: "in_progress",
      } as SessionUpdate);
    } else if (m.status !== "compacting" && session.compaction !== undefined) {
      const failed = m.compact_result === "failed";
      const compactionId = session.compaction;
      const compacted = session.compacted;
      session.compaction = undefined;
      session.compacted = undefined;
      await notify(client, session.id, {
        sessionUpdate: "compaction_update",
        compactionId,
        status: failed ? "failed" : "completed",
        ...(failed && typeof m.compact_error === "string" ? { error: m.compact_error } : {}),
      } as SessionUpdate);
      if (!failed && compacted !== undefined) {
        session.turn?.translator.compacted(compacted);
        await compactedUsage(client, session, compacted);
      }
    }
  } else if (m.subtype === "compact_boundary") {
    // What the context holds now that it was made smaller. Without `post_tokens` nothing is known
    // until the next model call: the last usage stays, and clients know it is from before (protocol §8).
    const post = (m.compact_metadata as { post_tokens?: unknown } | undefined)?.post_tokens;
    if (typeof post !== "number" || !Number.isFinite(post) || post < 0) return;
    // Held while the compaction runs: one that then fails left the context as it was.
    if (session.compaction !== undefined) session.compacted = post;
    else {
      session.turn?.translator.compacted(post);
      await compactedUsage(client, session, post);
    }
  }
};
