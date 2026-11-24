import { randomUUID } from "node:crypto";
import {
  type AgentContext,
  agent,
  methods,
  type NewSessionRequest,
  RequestError,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { CycleErrorCode, META } from "@cycle/protocol";
import { translateMcpServers } from "./mcp.ts";
import { type AdapterConfig, AgyProcess, AgyRpcError, type AgyTransport } from "./server.ts";
import { DEFAULT_AGY_MODE, toV2ConfigOptions } from "./settings.ts";
import {
  StepsPlans,
  toV2ToolCallUpdate,
  translateSimpleUpdate,
  validatePromptBlocks,
} from "./translate.ts";
import {
  AGY_MIN_VERSION,
  AGY_PROMPT_CAPABILITIES,
  isVersionSupported,
  type V1ConfigOption,
  type V1ElicitationRequest,
  type V1InitializeResult,
  type V1ModelInfo,
  type V1PermissionRequest,
  type V1PromptResult,
  type V1ResumeResponse,
  type V1SessionResponse,
  type V1ToolCallPayload,
  type V1UpdateNotification,
} from "./v1.ts";

type ActiveTurn = {
  inFlight: number;
  autonomous: boolean;
  activeRequests: number;
  cancelled: boolean;
  cancelTimer?: ReturnType<typeof setTimeout> | undefined;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  assistantMessageId: string;
  openTools: Set<string>;
  approvals: AbortController;
  /**
   * agy's `invoke_subagent` calls. The call itself shows as done within seconds while the sub-agent keeps working
   * for minutes without a word on ACP (CYC-289), so a finished call does not end it: only a failure, a
   * `manage_task` call finishing (agy's own check on its tasks), or `SUBAGENT_MAX_MS` does.
   */
  subagents: Map<string, { since: number; title: string }>;
  subagentTicker?: ReturnType<typeof setInterval> | undefined;
};

/** agy tools that start work which outlives the call. */
const SUBAGENT_TOOL = "invoke_subagent";
const TASK_TOOL = "manage_task";
/** Longest a sub-agent is waited for with nothing said: past it the turn may end, so a lost one cannot pin it. */
const SUBAGENT_MAX_MS = 10 * 60_000;
/** How often a working sub-agent is shown as still working. */
const SUBAGENT_TICK_MS = 5_000;

const newTurn = (autonomous: boolean): ActiveTurn => ({
  inFlight: 0,
  autonomous,
  activeRequests: 0,
  cancelled: false,
  assistantMessageId: randomUUID(),
  openTools: new Set(),
  approvals: new AbortController(),
  subagents: new Map(),
});

const formatElapsed = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m${String(total % 60).padStart(2, "0")}s` : `${total}s`;
};

/** Shell programs that run other commands or are too wide to remember by their name: never remembered. */
const UNREMEMBERABLE_PROGRAMS = new Set([
  "sudo",
  "su",
  "doas",
  "env",
  "sh",
  "bash",
  "zsh",
  "fish",
  "eval",
  "exec",
  "xargs",
  "nohup",
  "time",
  "command",
  "builtin",
  "watch",
  "timeout",
  "rm",
  "dd",
  "ssh",
  "source",
  ".",
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "bunx",
  "npx",
  "perl",
  "ruby",
  "php",
  "awk",
  "find",
  "curl",
  "wget",
  "mv",
  "chmod",
  "chown",
  "kill",
  "docker",
  "osascript",
  "open",
  "tee",
]);

/**
 * The rule a shell command is remembered by: one prefix per segment of a `|` / `&&` / `||` / `;` chain (the program
 * and, when it is a plain word, its subcommand: `git status`). Undefined when it cannot be judged by segments:
 * a substitution, a redirect, a newline or a program that runs others.
 */
export const commandPrefixes = (command: string): string[] | undefined => {
  // A lone `&` (background), a group, a negation, a substitution, a redirect or a newline: not judged by segments.
  if (/[`\n\r<>(){}!\\]|\$[({]/.test(command) || /(^|[^&])&([^&]|$)/.test(command))
    return undefined;
  const prefixes: string[] = [];
  for (const segment of command.split(/&&|\|\||[|;]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const program = words[0];
    if (program === undefined || /^\w+=/.test(program)) return undefined;
    if (UNREMEMBERABLE_PROGRAMS.has(program.split("/").pop() ?? program)) return undefined;
    // The program, the flags straight after it, and the plain word that follows: `git status`, `git -C repo`.
    // Remembered exactly, so `git -C repo` is never `git push`.
    let end = 1;
    while (words[end]?.startsWith("-")) end += 1;
    if (/^[a-z][\w-]*$/i.test(words[end] ?? "")) end += 1;
    prefixes.push(words.slice(0, end).join(" "));
  }
  return prefixes.length > 0 ? prefixes : undefined;
};

const coversPrefix = (remembered: ReadonlySet<string>, prefix: string): boolean =>
  remembered.has(prefix);

const ALWAYS_OPTION_ID = "cycle-allow-session";

const TURN_ACTIVITY_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

type SessionState = {
  id: string;
  owner: AgentContext;
  turn?: ActiveTurn | undefined;
  availableModels: V1ModelInfo[];
  v1ConfigOptions: V1ConfigOption[];
  lastCommandsJson?: string | undefined;
  defaultModel?: string | undefined;
  defaultEffort?: string | undefined;
  requestedModel?: string | undefined;
  requestedEffort?: string | undefined;
  /** agy's update_steps calls still going: what makes its plan. */
  stepsPlans: StepsPlans;
  /** What a call is, by id, until it ends: a permission request names the call but not always its input. */
  calls: Map<string, { name?: string | undefined; input?: unknown }>;
  /** "Always allow in this session", kept in memory only: MCP tool names and shell command prefixes. */
  allowedTools: Set<string>;
  allowedPrefixes: Set<string>;
};

const currentOption = (opts: readonly V1ConfigOption[], id: string): V1ConfigOption | undefined =>
  opts.find((o) => o.id === id || o.category === id);

/**
 * agy starts every new session in its own `default` mode (ask before each edit and command), whatever Cycle's
 * schema says. A new session is put in `DEFAULT_AGY_MODE` here, so the default Cycle shows is the one agy runs in
 * even when the person never saved one. An account that cannot have it keeps what agy chose (agy refuses, or does
 * not list it); the daemon then applies the person's own defaults on top.
 */
const startInDefaultMode = async (
  conn: AgyTransport,
  sessionId: string,
  opts: V1ConfigOption[],
): Promise<V1ConfigOption[]> => {
  const mode = currentOption(opts, "mode");
  if (mode === undefined || mode.currentValue === DEFAULT_AGY_MODE) return opts;
  if (!(mode.options ?? []).some((o) => o.value === DEFAULT_AGY_MODE)) return opts;
  try {
    const res = await conn.request<{ configOptions?: V1ConfigOption[] }>(
      "session/set_config_option",
      { sessionId, configId: mode.id, value: DEFAULT_AGY_MODE },
    );
    if (Array.isArray(res?.configOptions)) return res.configOptions;
    return opts.map((o) => (o === mode ? { ...o, currentValue: DEFAULT_AGY_MODE } : o));
  } catch {
    return opts;
  }
};

const sessionConfigOptions = (session: SessionState): SessionConfigOption[] =>
  toV2ConfigOptions(session.v1ConfigOptions, session.availableModels, {
    defaultModel: session.defaultModel,
    requestedModel: session.requestedModel,
    requestedEffort: session.requestedEffort,
  });

const toRequestError = (error: unknown): RequestError => {
  if (error instanceof RequestError) return error;
  if (error instanceof AgyRpcError) {
    if (error.code === -32000) {
      return new RequestError(
        -32000,
        "Authentication required. Run `cycle login agy` on the daemon's machine.",
        error.data,
      );
    }
    return new RequestError(error.code, error.message, error.data);
  }
  return new RequestError(
    -32603,
    error instanceof Error ? error.message : "Unexpected agy adapter error",
  );
};

const isMissingSessionError = (error: unknown): boolean => {
  if (!(error instanceof AgyRpcError)) return false;
  if (error.code === -32002) return true;
  if (error.code === -32603) {
    return /failed to read session|session not found|not found|no such/i.test(error.message);
  }
  return false;
};

const systemPromptMeta = (
  systemPrompt: NewSessionRequest["systemPrompt"],
): Record<string, unknown> | undefined => {
  if (systemPrompt === undefined || systemPrompt === null) return undefined;
  if (systemPrompt.mode === "override") {
    throw new RequestError(-32602, "agy only supports systemPrompt in append mode");
  }
  if (systemPrompt.mode !== "append" || !Array.isArray(systemPrompt.content)) {
    throw new RequestError(-32602, "Invalid systemPrompt");
  }
  const text = (systemPrompt.content as Array<{ type?: string; text?: string }>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
  return { antigravity: { systemPrompt: { append: text } } };
};

export function createAdapter(config: AdapterConfig) {
  let transport: AgyTransport | undefined;
  let initialized: Promise<V1InitializeResult> | undefined;
  let closing = false;
  let clientCanElicit = false;
  const sessions = new Map<string, SessionState>();
  const cancelTimeoutMs = config.cancelTimeoutMs ?? 5_000;
  // agy's model call between two steps often takes longer than 1.5 s, which flickered running/idle and let a queued
  // message go while agy still worked (CYC-290). No measured spread yet: the low end of 5-10 s, as a message sent in the window is refused.
  const autonomousIdleMs = config.autonomousIdleMs ?? 5_000;

  const emitUpdate = (session: SessionState, update: SessionUpdate) => {
    void session.owner
      .notify(methods.client.session.update, {
        sessionId: session.id,
        update,
      } as never)
      .catch(() => undefined);
  };

  /** Sub-agents still counted as working: not yet let go and not past `SUBAGENT_MAX_MS`. */
  const liveSubagents = (turn: ActiveTurn): number => {
    const now = Date.now();
    let live = 0;
    for (const sub of turn.subagents.values()) if (now - sub.since <= SUBAGENT_MAX_MS) live += 1;
    return live;
  };

  /** A sub-agent over: its call, shown running while it worked, is closed as the end says. */
  const releaseSubagents = (
    session: SessionState,
    turn: ActiveTurn,
    ids: Iterable<string>,
    status: "completed" | "failed" | "cancelled",
  ) => {
    for (const toolCallId of [...ids]) {
      const sub = turn.subagents.get(toolCallId);
      if (!sub) continue;
      turn.subagents.delete(toolCallId);
      if (status === "failed") continue; // agy's own failed update already closed it.
      emitUpdate(session, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status,
        title: sub.title,
      } as SessionUpdate);
    }
  };

  const holdsTurn = (turn: ActiveTurn): boolean =>
    turn.openTools.size > 0 || turn.activeRequests > 0 || liveSubagents(turn) > 0;

  const stopSubagentTicker = (turn: ActiveTurn) => {
    if (turn.subagentTicker) clearInterval(turn.subagentTicker);
    turn.subagentTicker = undefined;
  };

  /** While a sub-agent works the call is shown running again, with how long it has been: agy says nothing else. */
  const syncSubagentTicker = (session: SessionState, turn: ActiveTurn) => {
    releaseSubagents(
      session,
      turn,
      [...turn.subagents]
        .filter(([, sub]) => Date.now() - sub.since > SUBAGENT_MAX_MS)
        .map(([id]) => id),
      "completed",
    );
    if (liveSubagents(turn) === 0) {
      stopSubagentTicker(turn);
      scheduleAutonomousIdle(session, turn);
      return;
    }
    if (turn.subagentTicker) return;
    turn.subagentTicker = setInterval(() => {
      if (session.turn !== turn) return stopSubagentTicker(turn);
      syncSubagentTicker(session, turn);
      if (!turn.subagentTicker) return;
      const now = Date.now();
      for (const [toolCallId, sub] of turn.subagents) {
        emitUpdate(session, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          title: `${sub.title} · working ${formatElapsed(now - sub.since)}`,
        } as SessionUpdate);
      }
    }, SUBAGENT_TICK_MS);
    turn.subagentTicker.unref?.();
  };

  const scheduleAutonomousIdle = (session: SessionState, turn: ActiveTurn) => {
    if (!turn.autonomous || session.turn !== turn) return;
    if (turn.idleTimer) {
      clearTimeout(turn.idleTimer);
      turn.idleTimer = undefined;
    }
    if (holdsTurn(turn)) return;
    turn.idleTimer = setTimeout(() => {
      if (session.turn !== turn) return;
      if (holdsTurn(turn)) return;
      finishTurn(session, turn, turn.cancelled ? "cancelled" : "end_turn");
    }, autonomousIdleMs);
    turn.idleTimer.unref?.();
  };

  const ensureAutonomousTurn = (session: SessionState): ActiveTurn => {
    if (session.turn) return session.turn;
    const turn = newTurn(true);
    session.turn = turn;
    emitUpdate(session, {
      sessionUpdate: "state_update",
      state: "running",
    } as SessionUpdate);
    return turn;
  };

  const closeDanglingTools = (session: SessionState, turn: ActiveTurn) => {
    for (const toolCallId of turn.openTools) {
      emitUpdate(session, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "cancelled",
      } as SessionUpdate);
    }
    turn.openTools.clear();
  };

  const abortPendingRequests = (turn: ActiveTurn) => {
    turn.approvals.abort();
  };

  const finishTurn = (
    session: SessionState,
    turn: ActiveTurn,
    stopReason: string,
    error?: { code: number; message: string },
  ) => {
    if (session.turn !== turn) return;
    if (turn.cancelTimer) {
      clearTimeout(turn.cancelTimer);
      turn.cancelTimer = undefined;
    }
    if (turn.idleTimer) {
      clearTimeout(turn.idleTimer);
      turn.idleTimer = undefined;
    }
    stopSubagentTicker(turn);
    session.calls.clear();
    releaseSubagents(
      session,
      turn,
      [...turn.subagents.keys()],
      turn.cancelled ? "cancelled" : "completed",
    );
    abortPendingRequests(turn);
    closeDanglingTools(session, turn);
    session.turn = undefined;
    emitUpdate(session, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason,
      ...(error !== undefined ? { error } : {}),
    } as SessionUpdate);
  };

  const handleServerExit = (error: Error) => {
    transport = undefined;
    initialized = undefined;
    for (const session of sessions.values()) {
      if (session.turn) {
        finishTurn(session, session.turn, "error", {
          code: CycleErrorCode.AgentExited,
          message: error.message,
        });
      }
    }
    if (!closing) config.onServerExit?.();
  };

  const handleNotification = (method: string, params: unknown) => {
    if (method !== "session/update") return;
    const note = params as V1UpdateNotification | undefined;
    if (!note?.sessionId || !note.update) return;
    const session = sessions.get(note.sessionId);
    if (!session) return;
    const update = note.update;

    if (update.sessionUpdate === "available_commands_update") {
      const json = JSON.stringify(update.availableCommands ?? []);
      if (json === session.lastCommandsJson) return;
      session.lastCommandsJson = json;
    }

    if (update.sessionUpdate === "config_option_update") {
      session.v1ConfigOptions = update.configOptions as V1ConfigOption[];
      const thought = currentOption(session.v1ConfigOptions, "thought_level");
      if (
        session.requestedEffort !== undefined &&
        session.requestedEffort !== "default" &&
        !(thought?.options ?? []).some((o) => o.value === session.requestedEffort)
      ) {
        session.requestedEffort = "default";
      }
      emitUpdate(session, {
        sessionUpdate: "config_option_update",
        configOptions: sessionConfigOptions(session),
      } as SessionUpdate);
      return;
    }

    if (update.sessionUpdate === "current_mode_update") {
      const nextMode = (update as { currentModeId: string }).currentModeId;
      if (session.v1ConfigOptions.length > 0) {
        session.v1ConfigOptions = session.v1ConfigOptions.map((opt) =>
          opt.id === "mode" || opt.category === "mode" ? { ...opt, currentValue: nextMode } : opt,
        );
        emitUpdate(session, {
          sessionUpdate: "config_option_update",
          configOptions: sessionConfigOptions(session),
        } as SessionUpdate);
      }
      return;
    }

    if (!session.turn && TURN_ACTIVITY_UPDATES.has(update.sessionUpdate)) {
      ensureAutonomousTurn(session);
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const toolId = (update as { toolCallId?: string }).toolCallId;
      const status = (update as { status?: string }).status;
      const payload = update as V1ToolCallPayload;
      if (toolId) {
        const known = session.calls.get(toolId) ?? {};
        session.calls.set(toolId, {
          name: payload.name ?? known.name,
          input: payload.rawInput ?? known.input,
        });
      }
      if (session.turn && toolId) {
        const turn = session.turn;
        const name = session.calls.get(toolId)?.name;
        if (name === SUBAGENT_TOOL && !turn.subagents.has(toolId)) {
          if (status !== "failed" && status !== "cancelled") {
            const role = (payload.rawInput as { Role?: unknown } | undefined)?.Role;
            turn.subagents.set(toolId, {
              since: Date.now(),
              title:
                payload.title ?? (typeof role === "string" && role !== "" ? role : "Sub-agent"),
            });
            syncSubagentTicker(session, turn);
          }
        } else if (turn.subagents.has(toolId) && (status === "failed" || status === "cancelled")) {
          releaseSubagents(session, turn, [toolId], "failed");
          syncSubagentTicker(session, turn);
        } else if (
          name === TASK_TOOL &&
          status === "completed" &&
          turn.subagents.size > 0 &&
          /status/i.test(JSON.stringify(session.calls.get(toolId)?.input ?? ""))
        ) {
          // agy asking for the status of its tasks is the one sign of a sub-agent being over.
          releaseSubagents(session, turn, [...turn.subagents.keys()], "completed");
          syncSubagentTicker(session, turn);
        }
      }
      // A permission request for a call comes before it ends: what it was is only needed until then.
      if (toolId && (status === "completed" || status === "failed" || status === "cancelled")) {
        session.calls.delete(toolId);
      }
      if (session.turn) {
        // Start a fresh assistant message id for any text/thought arriving after a tool call.
        session.turn.assistantMessageId = randomUUID();
        if (toolId) {
          if (status === "completed" || status === "failed" || status === "cancelled") {
            session.turn.openTools.delete(toolId);
          } else {
            session.turn.openTools.add(toolId);
          }
        }
      }
    }

    const msgId = session.turn?.assistantMessageId ?? randomUUID();
    const planId = `${session.id}-plan`;
    const translated = translateSimpleUpdate(update, msgId, planId, (kind) => {
      process.stderr.write(`[harness/agy] ignored unknown v1 sessionUpdate: ${kind}\n`);
    });
    // A sub-agent is shown under the name the call is shown by, whatever agy titled it.
    const shownTitle = (translated as { title?: unknown } | undefined)?.title;
    const working = (update as { toolCallId?: string }).toolCallId;
    const sub = working === undefined ? undefined : session.turn?.subagents.get(working);
    if (sub && typeof shownTitle === "string" && shownTitle !== "") sub.title = shownTitle;
    // agy's update_steps changes the plan: the plan says it (docs/conversation-content.md), not a row per call, as
    // Claude's TodoWrite and TaskCreate do.
    const steps =
      update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
        ? session.stepsPlans.see(update as V1ToolCallPayload, planId)
        : undefined;
    if (translated)
      emitUpdate(
        session,
        steps?.plan ? ({ ...translated, kind: "think" } as SessionUpdate) : translated,
      );
    if (steps?.update) emitUpdate(session, steps.update);
    if (session.turn?.autonomous && TURN_ACTIVITY_UPDATES.has(update.sessionUpdate)) {
      scheduleAutonomousIdle(session, session.turn);
    }
  };

  /** What "always allow" would remember for a request: an MCP tool by its name, a shell command by its prefixes. */
  const permissionRule = (
    session: SessionState,
    req: V1PermissionRequest,
  ): { tools: string[]; prefixes: string[] } | undefined => {
    const known = session.calls.get(req.toolCall.toolCallId);
    const name = req.toolCall.name ?? known?.name;
    if (name === undefined) return undefined;
    if (name.startsWith("mcp_")) return { tools: [name], prefixes: [] };
    if (name !== "run_command") return undefined;
    const input = (req.toolCall.rawInput ?? known?.input) as { CommandLine?: unknown } | undefined;
    const command = typeof input?.CommandLine === "string" ? input.CommandLine : undefined;
    const prefixes = command === undefined ? undefined : commandPrefixes(command);
    return prefixes === undefined ? undefined : { tools: [], prefixes };
  };

  /** Every part of the request is covered by what was remembered; a command only when all its segments are. */
  const ruleAllowed = (
    session: SessionState,
    rule: { tools: string[]; prefixes: string[] },
  ): boolean =>
    rule.tools.every((t) => session.allowedTools.has(t)) &&
    rule.prefixes.every((p) => coversPrefix(session.allowedPrefixes, p));

  const handleRequest = async (method: string, params: unknown): Promise<unknown> => {
    if (method === "session/request_permission") {
      const req = params as V1PermissionRequest;
      const session = sessions.get(req.sessionId);
      if (!session) return { outcome: { outcome: "cancelled" } };

      const turn = ensureAutonomousTurn(session);
      const signal = turn.approvals.signal;
      if (signal.aborted) return { outcome: { outcome: "cancelled" } };

      // Said "always allow" for this earlier in the session: answered here, the person is not asked again.
      const allowOnce = req.options.find((o) => o.kind === "allow_once");
      const rule = permissionRule(session, req);
      if (allowOnce !== undefined && rule !== undefined && ruleAllowed(session, rule)) {
        if (turn.autonomous) scheduleAutonomousIdle(session, turn);
        return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
      }
      // agy's own "always" option, if it ever gives one, is passed on as it is; otherwise one is added.
      const canRemember =
        allowOnce !== undefined &&
        rule !== undefined &&
        !req.options.some((o) => o.kind === "allow_always");
      const options = canRemember
        ? [
            ...req.options,
            {
              optionId: ALWAYS_OPTION_ID,
              name: "Always allow in this session",
              kind: "allow_always",
            },
          ]
        : req.options;

      turn.activeRequests += 1;
      if (turn.idleTimer) {
        clearTimeout(turn.idleTimer);
        turn.idleTimer = undefined;
      }
      try {
        // The call it asks about is already shown: only what the request says about it goes with it.
        const tc = toV2ToolCallUpdate(req.toolCall, false) as Record<string, unknown>;
        const { sessionUpdate: _u, ...toolCall } = tc;
        const title = req.toolCall.title ?? req.toolCall.name ?? "Permission required";
        const answer = await session.owner
          .request(
            methods.client.session.requestPermission,
            {
              sessionId: session.id,
              title,
              subject: {
                type: "tool_call",
                toolCall,
              },
              options,
            } as never,
            { cancellationSignal: signal, stopWaitingOnCancel: true },
          )
          .catch(() => undefined);
        if (signal.aborted || !answer) return { outcome: { outcome: "cancelled" } };
        const picked = answer as { outcome?: { outcome?: string; optionId?: string } };
        if (
          canRemember &&
          rule !== undefined &&
          allowOnce !== undefined &&
          picked.outcome?.outcome === "selected" &&
          picked.outcome.optionId === ALWAYS_OPTION_ID
        ) {
          // agy knows only its own options: it is told this once, and the session remembers the rest.
          for (const tool of rule.tools) session.allowedTools.add(tool);
          for (const prefix of rule.prefixes) session.allowedPrefixes.add(prefix);
          return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
        }
        return answer;
      } finally {
        turn.activeRequests = Math.max(0, turn.activeRequests - 1);
        if (turn.autonomous) scheduleAutonomousIdle(session, turn);
      }
    }

    if (method === "elicitation/create") {
      const req = params as V1ElicitationRequest;
      const session = sessions.get(req.sessionId);
      if (!session || !clientCanElicit) return { action: "cancel" };

      const turn = ensureAutonomousTurn(session);
      const signal = turn.approvals.signal;
      if (signal.aborted) return { action: "cancel" };

      turn.activeRequests += 1;
      if (turn.idleTimer) {
        clearTimeout(turn.idleTimer);
        turn.idleTimer = undefined;
      }
      try {
        const response = (await session.owner
          .request(
            methods.client.elicitation.create,
            {
              ...req,
              sessionId: session.id,
              mode: req.mode ?? "form",
            } as never,
            { cancellationSignal: signal, stopWaitingOnCancel: true },
          )
          .catch(() => undefined)) as
          | {
              action?: "accept" | "decline" | "cancel";
              content?: Record<string, unknown> | null;
              _meta?: Record<string, unknown>;
            }
          | undefined;
        if (signal.aborted || !response || typeof response !== "object") {
          return { action: "cancel" };
        }
        // When no client can answer a form, daemon returns `{ action: "cancel", _meta: { "cycle/noClient": true } }`.
        // Strip internal `_meta` so agy sees a clean cancel ("User Skipped") and falls back to plain chat.
        if (response._meta?.[META.noClient] === true) {
          return { action: "cancel" };
        }
        const action = response.action ?? "cancel";
        return action === "accept" && response.content !== undefined
          ? { action, content: response.content }
          : { action };
      } finally {
        turn.activeRequests = Math.max(0, turn.activeRequests - 1);
        if (turn.autonomous) scheduleAutonomousIdle(session, turn);
      }
    }

    throw new AgyRpcError(-32601, `Unsupported client request from agy: ${method}`);
  };

  const ensureTransport = async (): Promise<{ conn: AgyTransport; info: V1InitializeResult }> => {
    if (!transport || transport.closed) {
      const handlers = {
        onNotification: handleNotification,
        onRequest: handleRequest,
        onExit: handleServerExit,
      };
      transport = config.connect ? config.connect(handlers) : new AgyProcess(config, handlers);
      initialized = undefined;
    }
    if (!initialized) {
      const conn = transport;
      initialized = conn
        .request<V1InitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            ...(clientCanElicit ? { elicitation: { form: {} } } : {}),
          },
          clientInfo: { name: "cycle", version: "1" },
        })
        .then(
          (res) => {
            const version = res.agentInfo?.version;
            if (!version || !isVersionSupported(version, AGY_MIN_VERSION)) {
              conn.close(
                new Error(
                  `agy version ${version ?? "unknown"} is below minimum ${AGY_MIN_VERSION}`,
                ),
              );
              throw new RequestError(
                CycleErrorCode.AgentUnavailable,
                `agy version ${version ?? "unknown"} is below the required minimum ${AGY_MIN_VERSION}`,
              );
            }
            return res;
          },
          (error) => {
            initialized = undefined;
            throw error;
          },
        );
    }
    const info = await initialized;
    return { conn: transport, info };
  };

  const app = agent({ name: "cycle-agy-adapter" })
    .onRequest(methods.agent.initialize, async ({ params }) => {
      const caps = (params as { capabilities?: { elicitation?: { form?: unknown } } })
        ?.capabilities;
      clientCanElicit = caps?.elicitation?.form != null;
      const { info } = await ensureTransport().catch((error) => {
        throw toRequestError(error);
      });
      return {
        protocolVersion: 2,
        info: {
          name: info.agentInfo?.name ?? "Antigravity ACP Server",
          version: info.agentInfo?.version ?? "0.0.0",
        },
        capabilities: {
          session: {
            prompt: AGY_PROMPT_CAPABILITIES,
            mcp: {
              ...(info.agentCapabilities?.mcpCapabilities?.http ? { http: {} } : {}),
              stdio: {},
            },
            ...(info.agentCapabilities?.sessionCapabilities?.additionalDirectories
              ? { additionalDirectories: {} }
              : {}),
            systemPrompt: {},
          },
        },
      };
    })
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      const meta = systemPromptMeta(params.systemPrompt);
      const mcpServers = translateMcpServers(params.mcpServers);
      const { conn } = await ensureTransport().catch((error) => {
        throw toRequestError(error);
      });
      let created: V1SessionResponse;
      try {
        created = await conn.request<V1SessionResponse>("session/new", {
          cwd: params.cwd,
          mcpServers,
          ...(params.additionalDirectories?.length
            ? { additionalDirectories: params.additionalDirectories }
            : {}),
          ...(meta !== undefined ? { _meta: meta } : {}),
        });
      } catch (error) {
        throw toRequestError(error);
      }

      const v1Opts = await startInDefaultMode(conn, created.sessionId, created.configOptions ?? []);
      const state: SessionState = {
        id: created.sessionId,
        owner: client,
        availableModels: created.models?.availableModels ?? [],
        v1ConfigOptions: v1Opts,
        stepsPlans: new StepsPlans(),
        calls: new Map(),
        allowedTools: new Set(),
        allowedPrefixes: new Set(),
        defaultModel: currentOption(v1Opts, "model")?.currentValue,
        defaultEffort: currentOption(v1Opts, "thought_level")?.currentValue,
      };
      sessions.set(state.id, state);
      const configOptions: SessionConfigOption[] = sessionConfigOptions(state);
      const tier = (created._meta as { antigravity?: { tier?: unknown } } | undefined)?.antigravity
        ?.tier;
      return {
        sessionId: state.id,
        configOptions,
        ...(typeof tier === "string" && tier.trim() !== ""
          ? { _meta: { antigravity: { tier: tier.trim() } } }
          : {}),
      } as never;
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
      const meta = systemPromptMeta(params.systemPrompt);
      const mcpServers = translateMcpServers(params.mcpServers);
      const hadTurn =
        (params._meta as Record<string, unknown> | undefined)?.[META.hadTurn] === true;
      const { conn } = await ensureTransport().catch((error) => {
        throw toRequestError(error);
      });

      let response: V1ResumeResponse;
      let resolvedId = params.sessionId;
      try {
        response = await conn.request<V1ResumeResponse>("session/resume", {
          sessionId: params.sessionId,
          cwd: params.cwd,
          mcpServers,
          ...(params.additionalDirectories?.length
            ? { additionalDirectories: params.additionalDirectories }
            : {}),
          ...(meta !== undefined ? { _meta: meta } : {}),
        });
        if (typeof response.sessionId === "string" && response.sessionId.trim() !== "") {
          resolvedId = response.sessionId;
        }
      } catch (error) {
        if (hadTurn || !isMissingSessionError(error)) {
          throw toRequestError(error);
        }
        try {
          const created = await conn.request<V1SessionResponse>("session/new", {
            cwd: params.cwd,
            mcpServers,
            ...(params.additionalDirectories?.length
              ? { additionalDirectories: params.additionalDirectories }
              : {}),
            ...(meta !== undefined ? { _meta: meta } : {}),
          });
          response = {
            ...created,
            configOptions: await startInDefaultMode(
              conn,
              created.sessionId,
              created.configOptions ?? [],
            ),
          };
          resolvedId = created.sessionId;
        } catch (fallbackError) {
          throw toRequestError(fallbackError);
        }
      }

      const v1Opts = response.configOptions ?? [];
      const state: SessionState = {
        id: resolvedId,
        owner: client,
        availableModels: response.models?.availableModels ?? [],
        v1ConfigOptions: v1Opts,
        stepsPlans: new StepsPlans(),
        calls: new Map(),
        allowedTools: new Set(),
        allowedPrefixes: new Set(),
        defaultModel: currentOption(v1Opts, "model")?.currentValue,
        defaultEffort: currentOption(v1Opts, "thought_level")?.currentValue,
      };
      sessions.set(state.id, state);

      // ACP v2: announce current session state before returning from session/resume.
      await client.notify(methods.client.session.update, {
        sessionId: state.id,
        update: { sessionUpdate: "state_update", state: "idle" } as SessionUpdate,
      });

      const configOptions: SessionConfigOption[] = sessionConfigOptions(state);
      const tier = (response._meta as { antigravity?: { tier?: unknown } } | undefined)?.antigravity
        ?.tier;
      const responseMeta: Record<string, unknown> = {};
      if (resolvedId !== params.sessionId) responseMeta[META.agentSessionId] = resolvedId;
      if (typeof tier === "string" && tier.trim() !== "") {
        responseMeta.antigravity = { tier: tier.trim() };
      }
      return {
        configOptions,
        ...(Object.keys(responseMeta).length > 0 ? { _meta: responseMeta } : {}),
      } as never;
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw new RequestError(-32002, `Unknown session: ${params.sessionId}`);
      if (params.type !== "id" || typeof params.value !== "string") {
        throw new RequestError(-32602, "Expected a string option ID");
      }
      const { conn } = await ensureTransport().catch((error) => {
        throw toRequestError(error);
      });

      const applyV1 = async (configId: string, value: string) => {
        try {
          const res = await conn.request<{ configOptions?: V1ConfigOption[] }>(
            "session/set_config_option",
            {
              sessionId: session.id,
              configId,
              value,
            },
          );
          if (Array.isArray(res?.configOptions)) {
            session.v1ConfigOptions = res.configOptions;
          }
        } catch (error) {
          throw toRequestError(error);
        }
      };

      if (params.configId === "mode") {
        await applyV1("mode", params.value);
      } else if (params.configId === "model") {
        if (params.value === "default") {
          session.requestedModel = "default";
          const currentModel = currentOption(session.v1ConfigOptions, "model")?.currentValue;
          if (session.defaultModel !== undefined && currentModel !== session.defaultModel) {
            await applyV1("model", session.defaultModel);
          }
        } else {
          await applyV1("model", params.value);
          session.requestedModel = params.value;
        }
        // Keep requested effort only if the newly selected model supports it; otherwise reset to default.
        const thought = currentOption(session.v1ConfigOptions, "thought_level");
        const supportedEfforts = (thought?.options ?? []).map((o) => o.value);
        if (session.requestedEffort !== undefined && session.requestedEffort !== "default") {
          if (!supportedEfforts.includes(session.requestedEffort)) {
            session.requestedEffort = "default";
          } else if (thought?.currentValue !== session.requestedEffort) {
            try {
              await applyV1("thought_level", session.requestedEffort);
            } catch {
              session.requestedEffort = "default";
            }
          }
        }
      } else if (params.configId === "effort") {
        const thought = currentOption(session.v1ConfigOptions, "thought_level");
        if (params.value === "default") {
          session.requestedEffort = "default";
          if (
            thought !== undefined &&
            session.defaultEffort !== undefined &&
            thought.currentValue !== session.defaultEffort &&
            (thought.options ?? []).some((o) => o.value === session.defaultEffort)
          ) {
            await applyV1("thought_level", session.defaultEffort).catch(() => undefined);
          }
        } else {
          if (!thought || (thought.options ?? []).length === 0) {
            throw new RequestError(-32602, "Current model does not support effort levels");
          }
          await applyV1("thought_level", params.value);
          session.requestedEffort = params.value;
        }
      } else if (currentOption(session.v1ConfigOptions, params.configId) !== undefined) {
        await applyV1(params.configId, params.value);
      } else {
        throw new RequestError(-32602, `Unknown agy setting: ${params.configId}`);
      }

      const configOptions = sessionConfigOptions(session);
      emitUpdate(session, {
        sessionUpdate: "config_option_update",
        configOptions,
      } as SessionUpdate);
      return { configOptions } as never;
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw new RequestError(-32002, `Unknown session: ${params.sessionId}`);
      validatePromptBlocks(params.prompt);
      const { conn } = await ensureTransport().catch((error) => {
        throw toRequestError(error);
      });

      const messageId = randomUUID();
      const blocks = params.prompt;
      const steer =
        (params._meta as Record<string, unknown> | null | undefined)?.[META.steer] === true;
      let turn = session.turn;
      if (steer) {
        if (!turn || turn.inFlight === 0) {
          throw new RequestError(-32600, "No turn is running to steer");
        }
        turn.assistantMessageId = randomUUID();
        emitUpdate(session, {
          sessionUpdate: "user_message",
          messageId,
          content: blocks,
        } as SessionUpdate);
      } else {
        if (turn) {
          throw new RequestError(-32600, "A turn is already running");
        }
        turn = newTurn(false);
        session.turn = turn;
        emitUpdate(session, {
          sessionUpdate: "user_message",
          messageId,
          content: blocks,
        } as SessionUpdate);
        emitUpdate(session, {
          sessionUpdate: "state_update",
          state: "running",
        } as SessionUpdate);
      }

      turn.inFlight += 1;
      const activeTurn = turn;

      // v1 `session/prompt` stays pending until the turn ends (no timeout limit).
      void conn
        .request<V1PromptResult>(
          "session/prompt",
          {
            sessionId: session.id,
            prompt: blocks,
          },
          0,
        )
        .then(
          (res) => {
            if (session.turn !== activeTurn) return;
            activeTurn.inFlight = Math.max(0, activeTurn.inFlight - 1);
            if (activeTurn.inFlight === 0) {
              const stopReason = activeTurn.cancelled
                ? "cancelled"
                : (res?.stopReason ?? "end_turn");
              finishTurn(session, activeTurn, stopReason);
            }
          },
          (error: unknown) => {
            if (session.turn !== activeTurn) return;
            activeTurn.inFlight = Math.max(0, activeTurn.inFlight - 1);
            if (activeTurn.inFlight === 0) {
              const rpc = toRequestError(error);
              finishTurn(session, activeTurn, activeTurn.cancelled ? "cancelled" : "error", {
                code: rpc.code,
                message: rpc.message,
              });
            }
          },
        );

      return { messageId } as never;
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session?.turn) return;
      const turn = session.turn;
      turn.cancelled = true;
      abortPendingRequests(turn);
      transport?.notify("session/cancel", { sessionId: session.id });
      if (!turn.cancelTimer) {
        turn.cancelTimer = setTimeout(() => {
          finishTurn(session, turn, "cancelled");
        }, cancelTimeoutMs);
        turn.cancelTimer.unref?.();
      }
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) return {} as never;
      if (session.turn) {
        finishTurn(session, session.turn, "cancelled");
      }
      sessions.delete(session.id);
      if (transport && !transport.closed) {
        await transport.request("session/close", { sessionId: session.id }).catch(() => undefined);
      }
      return {} as never;
    });

  return {
    app,
    close: () => {
      closing = true;
      transport?.close();
      sessions.clear();
    },
  };
}
