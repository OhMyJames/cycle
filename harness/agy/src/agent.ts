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
import { toV2ConfigOptions } from "./settings.ts";
import { toV2ToolCallUpdate, translateSimpleUpdate, validatePromptBlocks } from "./translate.ts";
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
};

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
};

const currentOption = (opts: readonly V1ConfigOption[], id: string): V1ConfigOption | undefined =>
  opts.find((o) => o.id === id || o.category === id);

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
  const autonomousIdleMs = config.autonomousIdleMs ?? 1_500;

  const emitUpdate = (session: SessionState, update: SessionUpdate) => {
    void session.owner
      .notify(methods.client.session.update, {
        sessionId: session.id,
        update,
      } as never)
      .catch(() => undefined);
  };

  const scheduleAutonomousIdle = (session: SessionState, turn: ActiveTurn) => {
    if (!turn.autonomous || session.turn !== turn) return;
    if (turn.idleTimer) {
      clearTimeout(turn.idleTimer);
      turn.idleTimer = undefined;
    }
    if (turn.openTools.size > 0 || turn.activeRequests > 0) return;
    turn.idleTimer = setTimeout(() => {
      if (session.turn !== turn) return;
      if (turn.openTools.size > 0 || turn.activeRequests > 0) return;
      finishTurn(session, turn, turn.cancelled ? "cancelled" : "end_turn");
    }, autonomousIdleMs);
    turn.idleTimer.unref?.();
  };

  const ensureAutonomousTurn = (session: SessionState): ActiveTurn => {
    if (session.turn) return session.turn;
    const turn: ActiveTurn = {
      inFlight: 0,
      autonomous: true,
      activeRequests: 0,
      cancelled: false,
      assistantMessageId: randomUUID(),
      openTools: new Set(),
      approvals: new AbortController(),
    };
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
    const translated = translateSimpleUpdate(update, msgId, `${session.id}-plan`, (kind) => {
      process.stderr.write(`[harness/agy] ignored unknown v1 sessionUpdate: ${kind}\n`);
    });
    if (translated) emitUpdate(session, translated);
    if (session.turn?.autonomous && TURN_ACTIVITY_UPDATES.has(update.sessionUpdate)) {
      scheduleAutonomousIdle(session, session.turn);
    }
  };

  const handleRequest = async (method: string, params: unknown): Promise<unknown> => {
    if (method === "session/request_permission") {
      const req = params as V1PermissionRequest;
      const session = sessions.get(req.sessionId);
      if (!session) return { outcome: { outcome: "cancelled" } };

      const turn = ensureAutonomousTurn(session);
      const signal = turn.approvals.signal;
      if (signal.aborted) return { outcome: { outcome: "cancelled" } };

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
              options: req.options,
            } as never,
            { cancellationSignal: signal, stopWaitingOnCancel: true },
          )
          .catch(() => undefined);
        if (signal.aborted || !answer) return { outcome: { outcome: "cancelled" } };
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

      const v1Opts = created.configOptions ?? [];
      const state: SessionState = {
        id: created.sessionId,
        owner: client,
        availableModels: created.models?.availableModels ?? [],
        v1ConfigOptions: v1Opts,
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
          response = created;
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
        turn = {
          inFlight: 0,
          autonomous: false,
          activeRequests: 0,
          cancelled: false,
          assistantMessageId: randomUUID(),
          openTools: new Set(),
          approvals: new AbortController(),
        };
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
