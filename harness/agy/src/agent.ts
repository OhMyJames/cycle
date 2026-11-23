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
import { type AdapterConfig, AgyProcess, AgyRpcError, type AgyTransport } from "./server.ts";
import { toV2ConfigOptions } from "./settings.ts";
import { toV2ToolCallUpdate, translateSimpleUpdate } from "./translate.ts";
import {
  AGY_MIN_VERSION,
  AGY_PROMPT_CAPABILITIES,
  isVersionSupported,
  type V1ConfigOption,
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
  cancelled: boolean;
  cancelTimer?: ReturnType<typeof setTimeout> | undefined;
  assistantMessageId: string;
  openTools: Set<string>;
  approvals: AbortController;
};

type SessionState = {
  id: string;
  cwd: string;
  owner: AgentContext;
  turn?: ActiveTurn | undefined;
  availableModels: V1ModelInfo[];
  v1ConfigOptions: V1ConfigOption[];
  lastCommandsJson?: string | undefined;
  requestedEffort?: string | undefined;
};

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

  const emitUpdate = (session: SessionState, update: SessionUpdate) => {
    void session.owner
      .notify(methods.client.session.update, {
        sessionId: session.id,
        update,
      } as never)
      .catch(() => undefined);
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
      const v2Opts = toV2ConfigOptions(
        session.v1ConfigOptions,
        session.availableModels,
        session.requestedEffort,
      );
      emitUpdate(session, {
        sessionUpdate: "config_option_update",
        configOptions: v2Opts,
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
          configOptions: toV2ConfigOptions(
            session.v1ConfigOptions,
            session.availableModels,
            session.requestedEffort,
          ),
        } as SessionUpdate);
      }
      return;
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
    const translated = translateSimpleUpdate(update, msgId, (kind) => {
      process.stderr.write(`[harness/agy] ignored unknown v1 sessionUpdate: ${kind}\n`);
    });
    if (translated) emitUpdate(session, translated);
  };

  const handleRequest = async (method: string, params: unknown): Promise<unknown> => {
    if (method === "session/request_permission") {
      const req = params as V1PermissionRequest;
      const session = sessions.get(req.sessionId);
      if (!session) return { outcome: { outcome: "cancelled" } };

      const signal = session.turn?.approvals.signal;
      if (signal?.aborted) return { outcome: { outcome: "cancelled" } };

      const tc = toV2ToolCallUpdate(req.toolCall) as Record<string, unknown>;
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
          signal ? { cancellationSignal: signal, stopWaitingOnCancel: true } : undefined,
        )
        .catch(() => undefined);
      if (signal?.aborted || !answer) return { outcome: { outcome: "cancelled" } };
      return answer;
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
      const { conn } = await ensureTransport().catch((error) => {
        throw toRequestError(error);
      });
      let created: V1SessionResponse;
      try {
        created = await conn.request<V1SessionResponse>("session/new", {
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
          ...(params.additionalDirectories?.length
            ? { additionalDirectories: params.additionalDirectories }
            : {}),
          ...(meta !== undefined ? { _meta: meta } : {}),
        });
      } catch (error) {
        throw toRequestError(error);
      }

      const state: SessionState = {
        id: created.sessionId,
        cwd: params.cwd,
        owner: client,
        availableModels: created.models?.availableModels ?? [],
        v1ConfigOptions: created.configOptions ?? [],
      };
      sessions.set(state.id, state);
      const configOptions: SessionConfigOption[] = toV2ConfigOptions(
        state.v1ConfigOptions,
        state.availableModels,
      );
      return {
        sessionId: state.id,
        configOptions,
      } as never;
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
      const meta = systemPromptMeta(params.systemPrompt);
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
          mcpServers: params.mcpServers ?? [],
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
            mcpServers: params.mcpServers ?? [],
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

      const state: SessionState = {
        id: resolvedId,
        cwd: params.cwd,
        owner: client,
        availableModels: response.models?.availableModels ?? [],
        v1ConfigOptions: response.configOptions ?? [],
      };
      sessions.set(state.id, state);

      // ACP v2: announce current session state before returning from session/resume.
      await client.notify(methods.client.session.update, {
        sessionId: state.id,
        update: { sessionUpdate: "state_update", state: "idle" } as SessionUpdate,
      });

      const configOptions: SessionConfigOption[] = toV2ConfigOptions(
        state.v1ConfigOptions,
        state.availableModels,
      );
      return {
        configOptions,
        ...(resolvedId !== params.sessionId
          ? { _meta: { [META.agentSessionId]: resolvedId } }
          : {}),
      } as never;
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw new RequestError(-32002, `Unknown session: ${params.sessionId}`);
      const { conn } = await ensureTransport().catch((error) => {
        throw toRequestError(error);
      });

      const messageId = randomUUID();
      const blocks = params.prompt;
      let turn = session.turn;
      if (!turn) {
        turn = {
          inFlight: 0,
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
      } else {
        turn.assistantMessageId = randomUUID();
        emitUpdate(session, {
          sessionUpdate: "user_message",
          messageId,
          content: blocks,
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
